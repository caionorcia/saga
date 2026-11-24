import type { Clock } from '../clock'
import type { Repo, JobRow } from '../db/repo'
import type { RateLimiter } from './limiter'

export type JobType = 'download_audio' | 'transcribe' | 'fetch_profile'
export type Handler = (payload: any) => Promise<void>
export type TickResult = 'ran' | 'idle' | 'paused' | 'waiting'

export interface QueueStats {
  pending: number
  running: number
  failed: number
  done: number
  paused: boolean
  nextRunAt: number | null
}

const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000]
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
  private started = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private loop: Promise<void> | null = null
  private ticking: Promise<TickResult> | null = null

  constructor(
    private readonly repo: Repo,
    private readonly clock: Clock,
    private readonly limiters: Record<JobType, RateLimiter>
  ) {}

  enqueue(type: JobType, key: string, payload: unknown, priority = 0): void {
    this.repo.insertJobIgnore(type, key, payload, priority)
    this.wake()
  }

  recoverAfterCrash(): number {
    return this.repo.resetRunningJobs()
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
    for (const type of this.handlers.keys()) {
      const job = this.repo.nextPendingJob(type, now)
      if (job) candidates.push(job)
    }
    if (candidates.length === 0) return 'idle'
    candidates.sort((a, b) => b.priority - a.priority || a.id - b.id)
    const job = candidates.find((j) => this.limiters[j.type as JobType].nextAllowedAt() <= now)
    if (!job) return 'waiting'

    const limiter = this.limiters[job.type as JobType]
    this.repo.markJobRunning(job.id)
    // conta contra o ritmo mesmo que o job falhe
    limiter.record(job.type === 'transcribe' ? Number((job.payload as any)?.durationSec) || 0 : 1)
    try {
      await this.handlers.get(job.type as JobType)!(job.payload)
      this.repo.markJobDone(job.id)
    } catch (e) {
      const attempts = job.attempts + 1
      const msg = e instanceof Error ? e.message : String(e)
      const next = attempts >= BACKOFF_MS.length ? null : this.clock.now() + BACKOFF_MS[attempts - 1]
      this.repo.markJobFailed(job.id, attempts, msg, next)
    }
    return 'ran'
  }

  stats(): QueueStats {
    const c = this.repo.jobCounts()
    let nextRunAt: number | null = null
    for (const { type, nextRunAt: n } of this.repo.pendingNextRunByType()) {
      const lim = this.limiters[type as JobType]
      if (!lim) continue
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
