import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../src/core/clock'
import { LIMITS, RateLimiter } from '../../../src/core/queue/limiter'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'

const T0 = 1_700_000_000_000

describe('RateLimiter', () => {
  it('rng=0: intervalo mínimo de 4000 ms após o último registro', () => {
    const clock = new FakeClock(T0)
    const l = new RateLimiter(LIMITS.wa_media, clock, () => 0)
    l.record()
    clock.advance(4000)
    l.record()
    expect(l.nextAllowedAt()).toBe(clock.now() + 4000)
  })

  it('rng=1: intervalo máximo de 12000 ms', () => {
    const clock = new FakeClock(T0)
    const l = new RateLimiter(LIMITS.wa_media, clock, () => 1)
    l.record()
    clock.advance(12000)
    l.record()
    expect(l.nextAllowedAt()).toBe(clock.now() + 12000)
  })

  it('sem registros, permite imediatamente', () => {
    const clock = new FakeClock(T0)
    const l = new RateLimiter(LIMITS.wa_media, clock, () => 0)
    expect(l.nextAllowedAt()).toBeLessThanOrEqual(clock.now())
  })

  it('300 registros em menos de 1 h bloqueiam até 1 h após o primeiro', () => {
    const clock = new FakeClock(T0)
    const l = new RateLimiter(LIMITS.wa_media, clock, () => 0)
    const first = clock.now()
    for (let i = 0; i < 300; i++) {
      l.record()
      clock.advance(5000) // 300 * 5 s = 25 min
    }
    expect(l.nextAllowedAt()).toBeGreaterThanOrEqual(first + 3_600_000)
    clock.advance(3_600_000 - 300 * 5000 + 1) // passou 1 h do primeiro
    expect(l.nextAllowedAt()).toBeLessThanOrEqual(clock.now() + 5000)
  })

  it('aquecimento dobra o intervalo por 15 min e depois volta ao normal', () => {
    const clock = new FakeClock(T0)
    const l = new RateLimiter(LIMITS.wa_media, clock, () => 0)
    l.startWarmup()
    l.record()
    expect(l.nextAllowedAt()).toBe(clock.now() + 8000)
    clock.advance(15 * 60_000)
    l.record()
    expect(l.nextAllowedAt()).toBe(clock.now() + 4000)
  })

  it('groq_audio: 2.880 registros de 10 s esgotam o dia', () => {
    const clock = new FakeClock(T0)
    const cfg = { ...LIMITS.groq_audio, perHour: 1e9, perDay: 1e9 }
    const l = new RateLimiter(cfg, clock, () => 0)
    for (let i = 0; i < 2879; i++) l.record(10)
    clock.advance(10_000)
    expect(l.nextAllowedAt()).toBeLessThanOrEqual(clock.now())
    l.record(10)
    clock.advance(10_000)
    expect(l.nextAllowedAt()).toBeGreaterThan(clock.now() + 3_600_000)
  })

  it('groq_audio: record(3) conta como 10 s', () => {
    const clock = new FakeClock(T0)
    const cfg = { ...LIMITS.groq_audio, perHour: 1e9, perDay: 1e9 }
    const l = new RateLimiter(cfg, clock, () => 0)
    for (let i = 0; i < 2880; i++) l.record(3)
    clock.advance(10_000)
    expect(l.nextAllowedAt()).toBeGreaterThan(clock.now() + 3_600_000)
  })

  it('relógio voltando para trás nunca libera mais cedo', () => {
    const clock = new FakeClock(T0)
    const l = new RateLimiter(LIMITS.wa_media, clock, () => 0)
    for (let i = 0; i < 300; i++) l.record()
    const blockedUntil = l.nextAllowedAt()
    expect(blockedUntil).toBeGreaterThanOrEqual(T0 + 3_600_000)
    clock.advance(-2 * 3_600_000)
    expect(l.nextAllowedAt()).toBeGreaterThanOrEqual(clock.now() + 3_600_000)
  })

  it('a contagem diária persiste ao reabrir sobre o mesmo repo', () => {
    const clock = new FakeClock(T0)
    const repo = new Repo(openDb(':memory:'), clock)
    const persist = { repo, key: 'limiter:wa_media' }
    const l = new RateLimiter(LIMITS.wa_media, clock, () => 0, persist)
    for (let i = 0; i < 2000; i++) l.record()
    clock.advance(2 * 3_600_000) // a janela de 1 h já passou; o teto diário não
    const reopened = new RateLimiter(LIMITS.wa_media, clock, () => 0, persist)
    expect(reopened.nextAllowedAt()).toBeGreaterThan(clock.now() + 3_600_000)
  })

  it('descarta registros com mais de 24 h', () => {
    const clock = new FakeClock(T0)
    const repo = new Repo(openDb(':memory:'), clock)
    const persist = { repo, key: 'limiter:wa_media' }
    const l = new RateLimiter(LIMITS.wa_media, clock, () => 0, persist)
    for (let i = 0; i < 2000; i++) l.record()
    clock.advance(25 * 3_600_000)
    const reopened = new RateLimiter(LIMITS.wa_media, clock, () => 0, persist)
    expect(reopened.nextAllowedAt()).toBeLessThanOrEqual(clock.now())
  })
})
