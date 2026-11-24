import type { Clock } from '../clock'
import type { Repo, JobRow } from '../db/repo'
import type { RateLimiter } from './limiter'

export type JobType = 'download_audio' | 'transcribe' | 'fetch_profile'
export type Handler = (payload: any) => Promise<void>
export type TickResult = 'ran' | 'idle' | 'paused' | 'waiting'
export type JobListener = (job: JobRow) => void

export interface QueueStats {
  pending: number
  running: number
  failed: number
  done: number
  paused: boolean
  nextRunAt: number | null
}

/**
 * Lançada por um handler para devolver o job à fila sem gastar tentativa
 * (ex.: disco cheio). `delayMs` adia a próxima execução.
 */
export class DeferJobError extends Error {
  constructor(
    message: string,
    readonly delayMs = 0
  ) {
    super(message)
    this.name = 'DeferJobError'
  }
}

const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000]

/** Horário (WhatsApp) da mensagem do job, para desempate; sem ts = mais antigo de todos. */
function payloadTs(j: JobRow): number {
  const ts = Number((j.payload as { ts?: unknown } | null)?.ts)
  return Number.isFinite(ts) ? ts : -Infinity
}
const MAX_SLEEP_MS = 60_000
const MIN_SLEEP_MS = 50

/**
 * Fila persistente: único portão para ações de rede ao WhatsApp.
 * Roda no máximo 1 job por tick, sempre respeitando o limitador do tipo.
 * Handlers precisam ser idempotentes (um job `running` pode rodar de novo após queda).
 */
export class JobQueue {
  private handlers = new Map<JobType, Handler>()
  private paused = false
  private pausedTypes = new Set<JobType>()
  /** pausas por tempo (`pauseTypeFor`): o timer que retoma o tipo */
  private typeTimers = new Map<JobType, ReturnType<typeof setTimeout>>()
  private started = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private loop: Promise<void> | null = null
  private ticking: Promise<TickResult> | null = null
  private failedListeners = new Set<JobListener>()
  private doneListeners = new Set<JobListener>()

  constructor(
    private readonly repo: Repo,
    private readonly clock: Clock,
    private readonly limiters: Record<JobType, RateLimiter>
  ) {}

  enqueue(type: JobType, key: string, payload: unknown, priority = 0): void {
    this.repo.insertJobIgnore(type, key, payload, priority)
    this.wake()
  }

  /** Como `enqueue`, mas um job já concluído com a mesma chave volta para a fila (tentativas zeradas). */
  requeue(type: JobType, key: string, payload: unknown, priority = 0): void {
    this.repo.requeueJob(type, key, payload, priority)
    this.wake()
  }

  /** Jobs `running` de uma execução interrompida contam como uma falha (evita laço de quedas). */
  recoverAfterCrash(): number {
    const jobs = this.repo.listJobs('running')
    for (const job of jobs) this.failJob(job, 'interrompido (o app fechou durante a execução)')
    return jobs.length
  }

  private failJob(job: JobRow, msg: string): void {
    const attempts = job.attempts + 1
    const next = attempts >= BACKOFF_MS.length ? null : this.clock.now() + BACKOFF_MS[attempts - 1]
    this.repo.markJobFailed(job.id, attempts, msg, next)
    if (next === null) this.notify(this.failedListeners, { ...job, status: 'failed', attempts, lastError: msg })
  }

  /** Avisa quando um job falha de vez (última tentativa). Devolve a função que cancela o aviso. */
  onJobFailed(cb: JobListener): () => void {
    this.failedListeners.add(cb)
    return () => this.failedListeners.delete(cb)
  }

  /** Avisa quando um job termina com sucesso. Devolve a função que cancela o aviso. */
  onJobDone(cb: JobListener): () => void {
    this.doneListeners.add(cb)
    return () => this.doneListeners.delete(cb)
  }

  private notify(listeners: Set<JobListener>, job: JobRow): void {
    for (const cb of listeners) {
      try {
        cb(job)
      } catch {
        // um ouvinte com defeito não pode travar a fila
      }
    }
  }

  retryFailed(id: number): void {
    this.repo.retryJob(id)
    this.wake()
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    this.wake()
  }

  isPaused(): boolean {
    return this.paused
  }

  /** Pausa só um tipo de job; os outros continuam rodando. Cancela uma pausa por tempo do mesmo tipo. */
  pauseType(type: JobType): void {
    this.clearTypeTimer(type)
    this.pausedTypes.add(type)
  }

  /** Pausa um tipo por `ms` e retoma sozinho (ex.: sem internet, teto de gasto até a meia-noite). */
  pauseTypeFor(type: JobType, ms: number): void {
    this.pauseType(type)
    const t = setTimeout(() => {
      this.typeTimers.delete(type)
      this.resumeType(type)
    }, Math.max(0, ms))
    ;(t as { unref?: () => void }).unref?.()
    this.typeTimers.set(type, t)
  }

  resumeType(type: JobType): void {
    this.clearTypeTimer(type)
    if (this.pausedTypes.delete(type)) this.wake()
  }

  private clearTypeTimer(type: JobType): void {
    const t = this.typeTimers.get(type)
    if (t) clearTimeout(t)
    this.typeTimers.delete(type)
  }

  isTypePaused(type: JobType): boolean {
    return this.pausedTypes.has(type)
  }

  /** Tipos que o laço pode rodar agora: com handler e não pausados. */
  private activeTypes(): JobType[] {
    return [...this.handlers.keys()].filter((t) => !this.pausedTypes.has(t))
  }

  register(type: JobType, handler: Handler): void {
    this.handlers.set(type, handler)
  }

  tick(): Promise<TickResult> {
    // serializa: nunca dois jobs ao mesmo tempo
    const run = (this.ticking ?? Promise.resolve()).then(
      () => this.doTick(),
      () => this.doTick()
    ) as Promise<TickResult>
    this.ticking = run
    return run
  }

  private async doTick(): Promise<TickResult> {
    if (this.paused) return 'paused'
    const now = this.clock.now()
    const candidates: JobRow[] = []
    for (const type of this.activeTypes()) {
      const job = this.repo.nextPendingJob(type, now)
      if (job) candidates.push(job)
    }
    if (candidates.length === 0) return 'idle'
    // mesma prioridade: primeiro a mensagem mais nova (payload.ts), depois a mais antiga na fila
    candidates.sort((a, b) => b.priority - a.priority || payloadTs(b) - payloadTs(a) || a.id - b.id)
    const job = candidates.find((j) => this.limiters[j.type as JobType].nextAllowedAt() <= now)
    if (!job) return 'waiting'

    const limiter = this.limiters[job.type as JobType]
    // conta contra o ritmo mesmo que o job falhe (antes de marcar running: se lançar, nada fica preso)
    limiter.record(job.type === 'transcribe' ? Number((job.payload as any)?.durationSec) : 1)
    this.repo.markJobRunning(job.id)
    try {
      await this.handlers.get(job.type as JobType)!(job.payload)
      this.repo.markJobDone(job.id)
      this.notify(this.doneListeners, { ...job, status: 'done', lastError: null })
    } catch (e) {
      if (e instanceof DeferJobError) {
        this.repo.markJobFailed(job.id, job.attempts, e.message, this.clock.now() + e.delayMs)
      } else {
        this.failJob(job, e instanceof Error ? e.message : String(e))
      }
    } finally {
      limiter.markFinished()
    }
    return 'ran'
  }

  stats(): QueueStats {
    const c = this.repo.jobCounts()
    let nextRunAt: number | null = null
    for (const { type, nextRunAt: n } of this.repo.pendingNextRunByType()) {
      // sem handler ou pausado, o laço nunca rodaria: não acordar à toa
      if (!this.handlers.has(type as JobType) || this.pausedTypes.has(type as JobType)) continue
      const lim = this.limiters[type as JobType]
      const t = Math.max(n, lim.nextAllowedAt())
      if (nextRunAt === null || t < nextRunAt) nextRunAt = t
    }
    return { ...c, paused: this.paused, nextRunAt }
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.schedule(0)
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const t of this.typeTimers.values()) clearTimeout(t)
    this.typeTimers.clear()
    await this.loop
    await this.ticking?.catch(() => {})
  }

  private wake(): void {
    if (this.started && !this.loop) this.schedule(0)
  }

  private schedule(delay: number): void {
    if (!this.started) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.loop = this.runOnce().finally(() => {
        this.loop = null
      })
    }, Math.max(MIN_SLEEP_MS, delay))
  }

  private async runOnce(): Promise<void> {
    try {
      await this.tick()
    } catch {
      // erro inesperado de infraestrutura: tenta de novo no próximo ciclo
    }
    if (!this.started) return
    const next = this.paused ? null : this.stats().nextRunAt
    const delay = next === null ? MAX_SLEEP_MS : Math.min(MAX_SLEEP_MS, next - this.clock.now())
    this.schedule(delay)
  }
}
