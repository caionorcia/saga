import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../src/core/clock'
import { ReconnectPolicy, classifyDisconnect } from '../../../src/core/wa/reconnect'

const T0 = 1_700_000_000_000
const MIN = 60_000
const SEQ = [10_000, 30_000, 120_000, 300_000, 900_000, 1_800_000]
const mid = () => 0.5

function drain(p: ReconnectPolicy, n: number): (number | null)[] {
  return Array.from({ length: n }, () => p.nextDelayMs())
}

describe('ReconnectPolicy', () => {
  it('rng=0.5 gera exatamente 10s, 30s, 2min, 5min, 15min, 30min', () => {
    const p = new ReconnectPolicy(new FakeClock(T0), mid)
    expect(drain(p, 6)).toEqual(SEQ)
  })

  it('a 7ª tentativa dentro de 1 h devolve null', () => {
    const p = new ReconnectPolicy(new FakeClock(T0), mid)
    drain(p, 6)
    expect(p.nextDelayMs()).toBeNull()
  })

  it('null trava: após 60 min continua null até manualRetry()', () => {
    const clock = new FakeClock(T0)
    const p = new ReconnectPolicy(clock, mid)
    drain(p, 6)
    expect(p.nextDelayMs()).toBeNull()
    clock.advance(60 * MIN)
    expect(p.nextDelayMs()).toBeNull()
    expect(p.nextDelayMs()).toBeNull()
    p.manualRetry()
    expect(p.nextDelayMs()).toBe(10_000)
  })

  it('null trava: após 60 min continua null até reset()', () => {
    const clock = new FakeClock(T0)
    const p = new ReconnectPolicy(clock, mid)
    drain(p, 6)
    expect(p.nextDelayMs()).toBeNull()
    clock.advance(60 * MIN)
    expect(p.nextDelayMs()).toBeNull()
    p.reset()
    expect(p.nextDelayMs()).toBe(10_000)
  })

  it('a escada não desce quando a janela envelhece: após 60 min, a próxima espera é 30s, não 10s', () => {
    const clock = new FakeClock(T0)
    const p = new ReconnectPolicy(clock, mid)
    expect(p.nextDelayMs()).toBe(10_000)
    clock.advance(60 * MIN)
    expect(p.nextDelayMs()).toBe(30_000)
  })

  it('janela deslizante: 6 tentativas a cada 10 min dão a escada inteira, depois a escada fica em 30 min até travar', () => {
    const clock = new FakeClock(T0)
    const p = new ReconnectPolicy(clock, mid)
    const got: (number | null)[] = []
    for (let i = 0; i < 6; i++) {
      got.push(p.nextDelayMs())
      clock.advance(10 * MIN)
    }
    expect(got).toEqual(SEQ)
    // agora t=60min: a tentativa de t=0 saiu da janela, então ainda há vaga, e a escada segue no teto
    expect(p.nextDelayMs()).toBe(1_800_000)
    // janela cheia de novo (t=10..60): trava
    expect(p.nextDelayMs()).toBeNull()
  })

  it('reset() reinicia a escada em 10s', () => {
    const p = new ReconnectPolicy(new FakeClock(T0), mid)
    drain(p, 3)
    p.reset()
    expect(p.nextDelayMs()).toBe(10_000)
  })

  it('manualRetry() zera a escada e a janela: a próxima chamada volta a dar 10s', () => {
    const p = new ReconnectPolicy(new FakeClock(T0), mid)
    drain(p, 6)
    expect(p.nextDelayMs()).toBeNull()
    p.manualRetry()
    expect(p.nextDelayMs()).toBe(10_000)
  })

  it('jitter ±20%: rng=0 → 0,8×base; rng=1 → 1,2×base', () => {
    expect(new ReconnectPolicy(new FakeClock(T0), () => 0).nextDelayMs()).toBe(8_000)
    expect(new ReconnectPolicy(new FakeClock(T0), () => 1).nextDelayMs()).toBe(12_000)
  })

  it('teto: com rng=1 o atraso nunca passa de 1.800.000 ms (30 min)', () => {
    const p = new ReconnectPolicy(new FakeClock(T0), () => 1)
    expect(drain(p, 6)).toEqual([12_000, 36_000, 144_000, 360_000, 1_080_000, 1_800_000])
  })

  it('usa Math.random por padrão quando rng não é informado', () => {
    const d = new ReconnectPolicy(new FakeClock(T0)).nextDelayMs()
    expect(d).toBeGreaterThanOrEqual(8_000)
    expect(d).toBeLessThanOrEqual(12_000)
  })
})

describe('ReconnectPolicy.markStable', () => {
  it('volta a escada para 10 s mas mantém a janela de 60 min', () => {
    const clock = new FakeClock(T0)
    const p = new ReconnectPolicy(clock, mid)
    expect(drain(p, 3)).toEqual(SEQ.slice(0, 3))
    p.markStable()
    expect(p.nextDelayMs()).toBe(10_000)
    expect(drain(p, 2)).toEqual([30_000, 120_000])
    // 6 tentativas na janela: a 7ª é null mesmo depois de markStable
    p.markStable()
    expect(p.nextDelayMs()).toBeNull()
  })

  it('a janela continua deslizando normalmente', () => {
    const clock = new FakeClock(T0)
    const p = new ReconnectPolicy(clock, mid)
    drain(p, 5)
    p.markStable()
    clock.advance(61 * MIN)
    expect(drain(p, 6)).toEqual(SEQ)
  })
})

describe('classifyDisconnect', () => {
  it('401 → logged_out', () => expect(classifyDisconnect(401)).toBe('logged_out'))
  it('411 (multideviceMismatch) → logged_out', () => expect(classifyDisconnect(411)).toBe('logged_out'))
  it('403 → restricted', () => expect(classifyDisconnect(403)).toBe('restricted'))
  it('440 → replaced', () => expect(classifyDisconnect(440)).toBe('replaced'))
  it('500 (badSession) → bad_session', () => expect(classifyDisconnect(500)).toBe('bad_session'))
  it('405 → outdated', () => expect(classifyDisconnect(405)).toBe('outdated'))
  it('mensagem com "version" → outdated quando o código não é definitivo', () => {
    expect(classifyDisconnect(428, 'Client version outdated')).toBe('outdated')
    expect(classifyDisconnect(undefined, 'Version mismatch')).toBe('outdated')
  })
  it('precedência: 401 com mensagem "version" continua logged_out', () => {
    expect(classifyDisconnect(401, 'Client version outdated')).toBe('logged_out')
  })
  it('precedência: 500 é bad_session com qualquer mensagem', () => {
    expect(classifyDisconnect(500, 'Client version outdated')).toBe('bad_session')
    expect(classifyDisconnect(500, 'anything')).toBe('bad_session')
  })
  it('408 → retry', () => expect(classifyDisconnect(408)).toBe('retry'))
  it('428 → retry', () => expect(classifyDisconnect(428)).toBe('retry'))
  it('503 (unavailableService) → retry', () => expect(classifyDisconnect(503)).toBe('retry'))
  it('515 (restartRequired) → retry', () => expect(classifyDisconnect(515)).toBe('retry'))
  it('undefined → retry', () => expect(classifyDisconnect(undefined)).toBe('retry'))
})
