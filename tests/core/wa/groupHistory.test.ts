import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../src/core/clock'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import {
  GROUP_HISTORY_LIMITS,
  historyTarget,
  loadExhausted,
  markExhausted,
  mayHaveOlder,
  localDayStart,
  newRun,
  nextRequestAt,
  oldestAnchor,
  reachedTarget,
  recordRequest,
  requestsToday,
  runView,
  saveRun
} from '../../../src/core/wa/groupHistory'
import { historyFetchLine, noAnchorLine } from '../../../src/shared/copiloto'

const NOW = 1_764_000_000_000
const DAY = 86_400_000
const GRP = '120363025555555555@g.us'

function setup() {
  const clock = new FakeClock(NOW)
  const repo = new Repo(openDb(':memory:'), clock)
  return { clock, repo }
}

describe('v0.8.3: limites gravados da busca do histórico no celular', () => {
  it('um pedido a cada 20 s e no máximo 60 por dia local; vale depois de reiniciar (está no banco)', () => {
    const { repo } = setup()
    expect(nextRequestAt(repo, NOW)).toBe(NOW)
    recordRequest(repo, NOW)
    expect(nextRequestAt(repo, NOW + 1_000)).toBe(NOW + GROUP_HISTORY_LIMITS.gapMs)
    // outro Repo no mesmo banco = o app reiniciado: o limite continua
    const again = new Repo((repo as any).db, new FakeClock(NOW + 5_000))
    expect(nextRequestAt(again, NOW + 5_000)).toBe(NOW + GROUP_HISTORY_LIMITS.gapMs)
    const day = localDayStart(NOW)
    let t = NOW
    for (let i = 1; i < GROUP_HISTORY_LIMITS.perDay; i++) recordRequest(repo, (t += GROUP_HISTORY_LIMITS.gapMs))
    expect(requestsToday(repo, t)).toBe(GROUP_HISTORY_LIMITS.perDay)
    const tomorrow = localDayStart(day + DAY + 3_600_000)
    expect(nextRequestAt(repo, t + 60_000)).toBe(tomorrow)
    expect(requestsToday(repo, tomorrow + 1)).toBe(0)
    expect(nextRequestAt(repo, tomorrow + 1)).toBeLessThanOrEqual(tomorrow + 1)
  })

  it('v0.9.0: sem limite de data (todo o histórico do celular); ponto de partida = a mensagem mais antiga do grupo', () => {
    const { repo } = setup()
    expect(historyTarget(repo, NOW)).toBe(0)
    repo.upsertContact({ jid: GRP, isGroup: true })
    repo.insertMessage({ id: 'b', jid: GRP, fromMe: false, ts: NOW - 2 * DAY, kind: 'text', text: 'x', mediaKeyJson: null, durationSec: null, waKeyJson: JSON.stringify({ remoteJid: GRP, id: 'b', participant: '1@lid' }) })
    repo.insertMessage({ id: 'a', jid: GRP, fromMe: true, ts: NOW - 3 * DAY, kind: 'text', text: 'x', mediaKeyJson: null, durationSec: null })
    expect(historyTarget(repo, NOW)).toBe(0)
    expect(reachedTarget(NOW - 3000 * DAY, 0)).toBe(false)
    expect(oldestAnchor(repo, GRP)).toEqual({ id: 'a', fromMe: true, ts: NOW - 3 * DAY })
    expect(oldestAnchor(repo, '1@g.us')).toBeNull()
    expect(reachedTarget(NOW - 30 * DAY + 30 * 60_000, NOW - 30 * DAY)).toBe(true)
    expect(reachedTarget(NOW - 29 * DAY, NOW - 30 * DAY)).toBe(false)
  })

  it('a linha da tela (só contagens)', () => {
    const { repo } = setup()
    expect(runView(repo, NOW)).toBeNull()
    const run = newRun(NOW, NOW - 30 * DAY, [GRP, GRP, '2@g.us'], 3)
    run.groups[GRP].s = 'done'
    run.requests = 4
    run.received = 120
    saveRun(repo, run)
    const v = runView(repo, NOW)!
    expect(v).toMatchObject({ state: 'running', groups: 2, done: 1, requests: 4, received: 120, noAnchor: 3, capped: false })
    expect(historyFetchLine(v)).toBe('Buscando no celular: 1 de 2 conversa(s) concluída(s) · 4 pedido(s) ao celular · 120 mensagem(ns) nova(s)')
    expect(historyFetchLine({ ...v, state: 'waiting_phone' })).toMatch(/o celular não respondeu/)
    expect(noAnchorLine(3)).toBe('3 grupo(s) precisam reconectar o aparelho para trazer o histórico')
    expect(newRun(NOW, 0, [], 2)).toMatchObject({ state: 'done', finishedAt: NOW })
  })
})

describe('v0.9.0: conversas que chegaram ao fim', () => {
  it('ficam anotadas com a mais antiga; mudou a mais antiga, pode ter mais de novo', () => {
    const { repo } = setup()
    expect(mayHaveOlder(repo, GRP, 'a')).toBe(true)
    markExhausted(repo, GRP, 'a')
    expect(loadExhausted(repo)).toEqual({ [GRP]: 'a' })
    expect(mayHaveOlder(repo, GRP, 'a')).toBe(false)
    expect(mayHaveOlder(repo, GRP, 'z')).toBe(true)
    repo.setSetting('wa.historyExhausted', 'lixo')
    expect(loadExhausted(repo)).toEqual({})
  })
})
