import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../src/core/clock'
import { ReconnectPolicy, classifyDisconnect } from '../../../src/core/wa/reconnect'

const T0 = 1_700_000_000_000
const MIN = 60_000
const SEQ = [10_000, 30_000, 120_000, 300_000, 900_000, 1_800_000]
const mid = () => 0.5

describe('ReconnectPolicy', () => {
  it('rng=0.5 gera exatamente 10s, 30s, 2min, 5min, 15min, 30min', () => {
    const p = new ReconnectPolicy(new FakeClock(T0), mid)
    const got = SEQ.map(() => p.nextDelayMs())
    expect(got).toEqual(SEQ)
  })

  it('a 7ª tentativa dentro de 1 h devolve null (desistir até a ação manual)', () => {
    const p = new ReconnectPolicy(new FakeClock(T0), mid)
    for (let i = 0; i < 6; i++) p.nextDelayMs()
    expect(p.nextDelayMs()).toBeNull()
    expect(p.nextDelayMs()).toBeNull()
  })

  it('após advance(60min) volta a dar um valor (10s, pois a janela esvaziou)', () => {
    const clock = new FakeClock(T0)
    const p = new ReconnectPolicy(clock, mid)
    for (let i = 0; i < 6; i++) p.nextDelayMs()
    expect(p.nextDelayMs()).toBeNull()
    clock.advance(60 * MIN)
    expect(p.nextDelayMs()).toBe(10_000)
  })

  it('a janela é deslizante: tentativas antigas saem uma a uma', () => {
    const clock = new FakeClock(T0)
    const p = new ReconnectPolicy(clock, mid)
    for (let i = 0; i < 6; i++) {
      p.nextDelayMs()
      clock.advance(10 * MIN)
    }
    // agora = 60 min; a tentativa de t=0 já saiu da janela de 60 min
    expect(p.nextDelayMs()).not.toBeNull()
    // e a de t=10min ainda não: a janela tem 5 tentativas + esta, então a próxima ainda é permitida
    expect(p.nextDelayMs()).toBeNull()
  })

  it('reset() reinicia a sequência em 10s', () => {
    const p = new ReconnectPolicy(new FakeClock(T0), mid)
    p.nextDelayMs()
    p.nextDelayMs()
    p.nextDelayMs()
    p.reset()
    expect(p.nextDelayMs()).toBe(10_000)
  })

  it('manualRetry() limpa a janela: a próxima chamada volta a dar 10s', () => {
    const p = new ReconnectPolicy(new FakeClock(T0), mid)
    for (let i = 0; i < 6; i++) p.nextDelayMs()
    expect(p.nextDelayMs()).toBeNull()
    p.manualRetry()
    expect(p.nextDelayMs()).toBe(10_000)
  })

  it('jitter ±20%: rng=0 → 0,8×base; rng=1 → 1,2×base', () => {
    expect(new ReconnectPolicy(new FakeClock(T0), () => 0).nextDelayMs()).toBe(8_000)
    expect(new ReconnectPolicy(new FakeClock(T0), () => 1).nextDelayMs()).toBe(12_000)
  })

  it('usa Math.random por padrão quando rng não é informado', () => {
    const p = new ReconnectPolicy(new FakeClock(T0))
    const d = p.nextDelayMs()
    expect(d).toBeGreaterThanOrEqual(8_000)
    expect(d).toBeLessThanOrEqual(12_000)
  })
})

describe('classifyDisconnect', () => {
  it('401 → logged_out', () => expect(classifyDisconnect(401)).toBe('logged_out'))
  it('411 (multideviceMismatch) → logged_out', () => expect(classifyDisconnect(411)).toBe('logged_out'))
  it('403 → restricted', () => expect(classifyDisconnect(403)).toBe('restricted'))
  it('440 → replaced', () => expect(classifyDisconnect(440)).toBe('replaced'))
  it('500 (badSession) → bad_session', () => expect(classifyDisconnect(500)).toBe('bad_session'))
  it('405 → outdated', () => expect(classifyDisconnect(405)).toBe('outdated'))
  it('mensagem com "version" → outdated', () => {
    expect(classifyDisconnect(428, 'Client version outdated')).toBe('outdated')
    expect(classifyDisconnect(undefined, 'Version mismatch')).toBe('outdated')
  })
  it('408 → retry', () => expect(classifyDisconnect(408)).toBe('retry'))
  it('428 → retry', () => expect(classifyDisconnect(428)).toBe('retry'))
  it('503 (unavailableService) → retry', () => expect(classifyDisconnect(503)).toBe('retry'))
  it('515 (restartRequired) → retry', () => expect(classifyDisconnect(515)).toBe('retry'))
  it('undefined → retry', () => expect(classifyDisconnect(undefined)).toBe('retry'))
})
