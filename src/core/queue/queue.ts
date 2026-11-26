import type { Clock } from '../clock'
import type { Repo, JobRow } from '../db/repo'
import type { RateLimiter } from './limiter'

export type JobType = 'download_audio' | 'transcribe' | 'fetch_profile' | 'classify' | 'send_message'
/** `signal` é abortado quando o job estoura o prazo do tipo (o resultado atrasado é descartado). */
export type Handler = (payload: any, signal?: AbortSignal) => Promise<void>
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

/**
 * Prazo de cada job por tipo. Um job que estoura o prazo conta como tentativa falha e a fila segue:
 * sem isso, um pedido HTTP que nunca responde (ex.: download de mídia) travaria a fila inteira.
 */
export const DEFAULT_JOB_TIMEOUTS_MS: Record<JobType, number> = {
  download_audio: 120_000,
  transcribe: 180_000,
  fetch_profile: 60_000,
  classify: 90_000,
  // "digitando…" (até 8,5 s) + o envio + marcar como lida. Folgado de propósito: estourar o prazo NÃO dá o envio como
  // desconhecido enquanto o pedido ao WhatsApp ainda está em andamento (o serviço espera ele terminar)
  send_message: 180_000
}

/**
 * Tipos que nunca tentam de novo sozinhos: uma falha (ou o app fechando no meio) é definitiva. Um envio só sai de novo
 * com uma nova confirmação do mentor ("nunca reenviar no escuro").
 */
export const NO_AUTO_RETRY: ReadonlySet<JobType> = new Set(['send_message'])
const SUMMARY_EVERY_MS = 5 * 60_000

export interface JobQueueOpts {
  timeoutsMs?: Partial<Record<JobType, number>>
  /** registro de diagnóstico: uma linha por início/fim de job e um resumo a cada 5 min (nunca o payload) */
  diag?: (kind: string, detail: string) => void
}

/** Estourou o prazo do tipo. */
export class JobTimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`tempo esgotado (${Math.round(ms / 1000)} s)`)
    this.name = 'JobTimeoutError'
  }
}

/** Mensagem de erro para o registro: uma linha, curta, sem caminho/consulta de URLs. */
function safeErr(msg: string): string {
  return msg
    .replace(/(https?:\/\/[^/\s?#]+)[^\s]*/g, '$1/…')
    .replace(/\s+/g, ' ')
    .slice(0, 200)
}

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
  private readonly timeouts: Record<JobType, number>
  private readonly diagFn?: (kind: string, detail: string) => void
  private summaryTimer: ReturnType<typeof setInterval> | null = null
  /** tentativa em andamento: só ela pode concluir o job (respostas atrasadas são ignoradas) */
  private attemptSeq = 0
  private current: { jobId: number; token: number; type: JobType; startedMono: number } | null = null

  constructor(
    private readonly repo: Repo,
    private readonly clock: Clock,
    /** tipo sem limitador nunca roda (ex.: testes que não usam `classify`) */
    private readonly limiters: Partial<Record<JobType, RateLimiter>>,
    opts: JobQueueOpts = {}
  ) {
    this.timeouts = { ...DEFAULT_JOB_TIMEOUTS_MS, ...(opts.timeoutsMs ?? {}) }
    this.diagFn = opts.diag
  }

  private diag(kind: string, detail: string): void {
    try {
      this.diagFn?.(kind, detail)
    } catch {
      // registrar nunca trava a fila
    }
  }

  /** Uma linha de resumo da fila no registro de diagnóstico (contagens por tipo, pausas, limitadores). */
  logSummary(): void {
    if (!this.diagFn) return
    try {
      const now = this.clock.now()
      const parts: string[] = []
      for (const type of Object.keys(DEFAULT_JOB_TIMEOUTS_MS) as JobType[]) {
        const lim = this.limiters[type]
        if (!lim) continue
        const c = this.repo.jobCounts(type)
        const next = lim.nextAllowedAt(now) - now
        parts.push(
          `${type}: pending=${c.pending} running=${c.running} done=${c.done} failed=${c.failed} next_allowed=${next <= 0 ? 'now' : `+${Math.ceil(next / 1000)}s`}`
        )
      }
      const paused = [...this.pausedTypes]
      const cur = this.current
      const running = cur
        ? `; current=${cur.type} #${cur.jobId} ${Math.round((this.clock.monotonic() - cur.startedMono) / 1000)}s`
        : ''
      this.diag(
        'queue_summary',
        `${parts.join('; ')}; paused_types=${paused.length ? paused.join(',') : '-'}; global_pause=${this.paused ? 'yes' : 'no'}${running}`
      )
    } catch {
      // banco fechado: sem resumo
    }
  }

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
    const final = attempts >= BACKOFF_MS.length || NO_AUTO_RETRY.has(job.type as JobType)
    const next = final ? null : this.clock.now() + BACKOFF_MS[attempts - 1]
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
    return [...this.handlers.keys()].filter((t) => !this.pausedTypes.has(t) && this.limiters[t])
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
    const job = candidates.find((j) => this.limiters[j.type as JobType]!.nextAllowedAt(now) <= now)
    if (!job) return 'waiting'

    const limiter = this.limiters[job.type as JobType]!
    // conta contra o ritmo mesmo que o job falhe (antes de marcar running: se lançar, nada fica preso)
    limiter.record(job.type === 'transcribe' ? Number((job.payload as any)?.durationSec) : 1)
    this.repo.markJobRunning(job.id)
    const type = job.type as JobType
    const token = ++this.attemptSeq
    const startedMono = this.clock.monotonic()
    const startedAt = Date.now()
    this.current = { jobId: job.id, token, type, startedMono }
    const tag = `${type} #${job.id}`
    this.diag('job_start', `${tag} tentativa ${job.attempts + 1}`)
    const ctrl = new AbortController()
    const ms = this.timeouts[type]
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const run = Promise.resolve().then(() => this.handlers.get(type)!(job.payload, ctrl.signal))
      // a tentativa que estourou o prazo pode resolver/rejeitar depois: nunca escapa, nunca conclui o job
      run.catch(() => {})
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new JobTimeoutError(ms)), ms)
        ;(timer as { unref?: () => void }).unref?.()
      })
      await Promise.race([run, timeout])
      if (this.current?.token !== token) return 'ran'
      this.repo.markJobDone(job.id)
      this.diag('job_done', `${tag} ${Date.now() - startedAt} ms`)
      this.notify(this.doneListeners, { ...job, status: 'done', lastError: null })
    } catch (e) {
      if (this.current?.token !== token) return 'ran'
      if (e instanceof JobTimeoutError) {
        ctrl.abort(e)
        this.diag('job_timeout', `${tag} sem resposta em ${Math.round(ms / 1000)} s (tentativa ${job.attempts + 1})`)
        this.failJob(job, e.message)
      } else if (e instanceof DeferJobError) {
        this.diag('job_deferred', `${tag} ${safeErr(e.message)} (+${Math.round(e.delayMs / 1000)} s)`)
        this.repo.markJobFailed(job.id, job.attempts, e.message, this.clock.now() + e.delayMs)
      } else {
        const msg = e instanceof Error ? e.message : String(e)
        const code = (e as { code?: unknown; output?: { statusCode?: unknown }; status?: unknown } | null)
        const c = code?.output?.statusCode ?? code?.status ?? code?.code
        this.diag(
          'job_failed',
          `${tag} tentativa ${job.attempts + 1}${c !== undefined ? ` código ${String(c)}` : ''}: ${safeErr(msg)} (${Date.now() - startedAt} ms)`
        )
        this.failJob(job, msg)
      }
    } finally {
      clearTimeout(timer)
      if (this.current?.token === token) this.current = null
      limiter.markFinished()
    }
    return 'ran'
  }

  stats(): QueueStats {
    const c = this.repo.jobCounts()
    let nextRunAt: number | null = null
    for (const { type, nextRunAt: n } of this.repo.pendingNextRunByType()) {
      // sem handler ou pausado, o laço nunca rodaria: não acordar à toa
      const lim = this.limiters[type as JobType]
      if (!lim || !this.handlers.has(type as JobType) || this.pausedTypes.has(type as JobType)) continue
      const t = Math.max(n, lim.nextAllowedAt())
      if (nextRunAt === null || t < nextRunAt) nextRunAt = t
    }
    return { ...c, paused: this.paused, nextRunAt }
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.schedule(0)
    if (this.diagFn && !this.summaryTimer) {
      this.logSummary()
      this.summaryTimer = setInterval(() => this.logSummary(), SUMMARY_EVERY_MS)
      ;(this.summaryTimer as { unref?: () => void }).unref?.()
    }
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.summaryTimer) clearInterval(this.summaryTimer)
    this.summaryTimer = null
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
