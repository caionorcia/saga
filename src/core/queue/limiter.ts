import type { Clock } from '../clock'
import type { Repo } from '../db/repo'

export interface LimitConfig {
  minGapMs: number
  maxGapMs: number
  perHour: number
  perDay: number
  /** teto diário de segundos de áudio cobrados (só groq_audio) */
  audioSecondsPerDay?: number
  /** mínimo cobrado por pedido, em segundos (só groq_audio) */
  minBilledSec?: number
}

export type LimiterName = 'wa_media' | 'wa_profile' | 'groq_audio' | 'llm'

export const LIMITS: Record<LimiterName, LimitConfig> = {
  wa_media: { minGapMs: 4000, maxGapMs: 12000, perHour: 300, perDay: 2000 },
  wa_profile: { minGapMs: 8000, maxGapMs: 20000, perHour: 60, perDay: 300 },
  groq_audio: {
    minGapMs: 3000,
    maxGapMs: 6000,
    perHour: 20 * 60,
    perDay: 2000,
    audioSecondsPerDay: 28800,
    minBilledSec: 10
  },
  llm: { minGapMs: 0, maxGapMs: 1000, perHour: 600, perDay: 2000 }
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** [epoch ms, unidades de pedido, segundos cobrados] */
type Entry = [number, number, number]

export class RateLimiter {
  private entries: Entry[] = []
  private lastMono: number | null = null
  private gapMs = 0
  private warmupUntilMono = -Infinity

  constructor(
    private readonly cfg: LimitConfig,
    private readonly clock: Clock,
    private readonly rng: () => number = Math.random,
    private readonly persist?: { repo: Repo; key: string }
  ) {
    if (persist) this.entries = this.load(persist)
    this.normalize()
  }

  /** Aquecimento: intervalos dobrados pelos próximos `durationMs`. */
  startWarmup(durationMs = 15 * 60_000): void {
    this.warmupUntilMono = this.clock.monotonic() + durationMs
  }

  /** Registra uma ação. Para limitadores de áudio, `costUnits` são os segundos do áudio. */
  record(costUnits = 1): void {
    if (!Number.isFinite(costUnits) || costUnits < 0) costUnits = this.cfg.minBilledSec ?? 1
    this.startGap()
    this.normalize()
    if (this.cfg.audioSecondsPerDay !== undefined) {
      this.entries.push([this.clock.now(), 1, Math.max(this.cfg.minBilledSec ?? 0, costUnits)])
    } else {
      this.entries.push([this.clock.now(), costUnits, 0])
    }
    this.save()
  }

  /** A ação terminou: o próximo intervalo conta a partir do fim, não só do início. */
  markFinished(): void {
    this.startGap()
  }

  private startGap(): void {
    const mono = this.clock.monotonic()
    const mult = mono < this.warmupUntilMono ? 2 : 1
    this.gapMs = (this.cfg.minGapMs + this.rng() * (this.cfg.maxGapMs - this.cfg.minGapMs)) * mult
    this.lastMono = mono
  }

  /** Epoch (ms) a partir do qual a próxima ação é permitida; <= now quando já é permitida. */
  nextAllowedAt(at?: number): number {
    // um único "agora" para o cálculo inteiro: duas leituras do relógio (1 ms de diferença no Windows)
    // davam um resultado sempre 1 ms no futuro e a fila nunca rodava
    const now = at ?? this.clock.now()
    this.normalize(now)
    let t = now
    if (this.lastMono !== null) {
      t = Math.max(t, now + (this.lastMono + this.gapMs - this.clock.monotonic()))
    }
    t = Math.max(t, this.windowFree(now, HOUR, 1, this.cfg.perHour, 1))
    t = Math.max(t, this.windowFree(now, DAY, 1, this.cfg.perDay, 1))
    if (this.cfg.audioSecondsPerDay !== undefined) {
      t = Math.max(t, this.windowFree(now, DAY, 2, this.cfg.audioSecondsPerDay, this.cfg.minBilledSec ?? 1))
    }
    return t
  }

  /** Quando uma janela deslizante volta a ter espaço para `need` unidades do campo `field`. */
  private windowFree(now: number, windowMs: number, field: 1 | 2, cap: number, need: number): number {
    const inWin = this.entries.filter((e) => e[0] > now - windowMs)
    let sum = inWin.reduce((a, e) => a + e[field], 0)
    if (sum + need <= cap) return now
    for (const e of inWin) {
      sum -= e[field]
      if (sum + need <= cap) return e[0] + windowMs
    }
    return now + windowMs
  }

  /** Descarta registros com mais de 24 h; registros "do futuro" (relógio voltou) viram "agora". */
  private normalize(now: number = this.clock.now()): void {
    let changed = false
    for (const e of this.entries) {
      if (e[0] > now) {
        e[0] = now
        changed = true
      }
    }
    const kept = this.entries.filter((e) => e[0] > now - DAY)
    if (kept.length !== this.entries.length) {
      this.entries = kept
      changed = true
    }
    if (changed) this.save()
  }

  private load(p: { repo: Repo; key: string }): Entry[] {
    try {
      const raw = p.repo.getSetting(p.key)
      const arr = raw ? JSON.parse(raw) : []
      return Array.isArray(arr) ? arr.filter((e) => Array.isArray(e) && e.length === 3) : []
    } catch {
      return []
    }
  }

  private save(): void {
    if (this.persist) this.persist.repo.setSetting(this.persist.key, JSON.stringify(this.entries))
  }
}
