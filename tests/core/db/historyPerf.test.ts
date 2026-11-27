import { describe, expect, it } from 'vitest'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { FakeClock } from '../../../src/core/clock'
import { parseQuery, toFtsMatch } from '../../../src/core/search/query'

/**
 * v0.9.0: com o histórico completo guardado (100 mil mensagens ou mais), a lista de conversas, os contadores, a conversa
 * em páginas e a pesquisa por mentorado continuam rápidos (pelos índices).
 */
const NOW = 1_764_000_000_000
const DAY = 86_400_000
const skipBench = process.env['SAGA_BENCH'] !== '1' && (process.env['SAGA_SKIP_BENCH'] === '1' || !!process.env['CI'])

describe.skipIf(skipBench)('desempenho com o histórico completo', () => {
  it('120 mil mensagens (2 anos, 1.500 conversas, uma com 40 mil): lista, contadores, página e pesquisa rápidas', () => {
    const r = new Repo(openDb(':memory:'), new FakeClock(NOW))
    const words = ['aula', 'módulo', 'pacote', 'cliente', 'venda', 'funil', 'proposta', 'reunião', 'planilha', 'contrato', 'agenda', 'meta', 'oferta', 'preço']
    let seed = 11
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    const people = Array.from({ length: 1_400 }, (_, i) => `55479${String(i).padStart(8, '0')}@s.whatsapp.net`)
    const groups = Array.from({ length: 100 }, (_, i) => `1203630${String(i).padStart(11, '0')}@g.us`)
    const BIG = people[0]
    const t0 = performance.now()
    r.transaction(() => {
      for (const c of people) r.upsertContact({ jid: c, pushName: `Pessoa ${c.slice(5, 9)}` })
      for (const g of groups) r.upsertContact({ jid: g, pushName: `Grupo ${g.slice(-4)}`, isGroup: true })
      for (let i = 0; i < 120_000; i++) {
        const inBig = i % 3 === 0
        const jid = inBig ? BIG : i % 5 === 0 ? groups[i % groups.length] : people[1 + (i % (people.length - 1))]
        const text = Array.from({ length: 10 }, () => words[Math.floor(rnd() * words.length)]).join(' ')
        const isGroup = jid.endsWith('@g.us')
        r.insertMessage({
          id: `m${i}`,
          jid,
          fromMe: rnd() < 0.4,
          ts: NOW - Math.floor(rnd() * 730) * DAY - (i % 1000) * 1000,
          kind: 'text',
          text: i === 77_777 ? `${text} precificação` : text,
          mediaKeyJson: null,
          durationSec: null,
          ...(isGroup ? { isGroup: true, senderJid: people[1 + (i % 50)], senderName: 'Alguém' } : {})
        })
      }
    })
    const ingestMs = performance.now() - t0
    // grupos pequenos com participantes conhecidos ("Respondido no grupo" olha os grupos de cada contato)
    groups.forEach((g, k) => r.setGroupMembers(g, people.slice(1 + k * 10, 1 + k * 10 + 12), 12))
    expect(r.messageCount(BIG)).toBe(40_000)
    const time = (fn: () => unknown) => {
      fn()
      const t = performance.now()
      fn()
      return performance.now() - t
    }
    const list = time(() => r.listContacts({ includeHidden: false }))
    const triage = time(() => r.triageCounts())
    const page = time(() => r.listMessagesPage(BIG, 200))
    const deep = time(() => r.listMessagesPage(BIG, 200, 'm3'))
    const match = toFtsMatch(parseQuery('proposta de contrato'), 'and')
    const scoped = time(() => r.searchInChats(match, [BIG, ...groups.slice(0, 5)], null, null, 50))
    const rare = r.searchInChats(toFtsMatch(parseQuery('precificação'), 'and'), people.slice(0, 1_400), null, null, 50)
    if (process.env['SAGA_BENCH_LOG']) console.log('histórico ms', { ingestMs, list, triage, page, deep, scoped })
    expect(rare.total).toBe(1)
    expect(ingestMs).toBeLessThan(30_000)
    expect(list).toBeLessThan(500)
    expect(triage).toBeLessThan(200)
    expect(page).toBeLessThan(50)
    expect(deep).toBeLessThan(300)
    expect(scoped).toBeLessThan(300)
  }, 180_000)
})
