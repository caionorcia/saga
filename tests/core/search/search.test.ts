import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import type { NormalizedMessage } from '../../../src/core/types'
import { runSearch } from '../../../src/core/search/search'

const NOW = 1_764_000_000_000
const DAY = 86_400_000
const ANA = '5547911110000@s.whatsapp.net'
const BIA = '5547922220000@s.whatsapp.net'
const GRP = '120363000000000001@g.us'

function msg(o: Partial<NormalizedMessage> & { id: string; jid: string }): NormalizedMessage {
  return { fromMe: false, ts: NOW - DAY, kind: 'text', text: null, mediaKeyJson: null, durationSec: null, ...o }
}

let repo: Repo
beforeEach(() => {
  repo = new Repo(openDb(':memory:'))
  repo.upsertContact({ jid: ANA, pushName: 'Ana Teste' })
  repo.upsertContact({ jid: BIA, pushName: 'Bia Exemplo' })
  repo.upsertContact({ jid: GRP, pushName: 'Turma Exemplo', isGroup: true })
  repo.insertMessage(msg({ id: 'a1', jid: ANA, text: 'Mentor, como faço a precificação do meu pacote?', ts: NOW - 2 * DAY }))
  repo.insertMessage(msg({ id: 'a2', jid: ANA, text: 'Obrigada pela aula!', ts: NOW - 40 * DAY }))
  repo.insertMessage(msg({ id: 'b1', jid: BIA, kind: 'audio', text: null, ts: NOW - 3 * DAY }))
  repo.insertMessage(msg({ id: 'g1', jid: GRP, isGroup: true, senderJid: '5547933330000@s.whatsapp.net', senderName: 'Carla Fictícia', text: 'Alguém sabe precificar serviço recorrente?', ts: NOW - 10 * DAY }))
  repo.insertMessage(msg({ id: 'g2', jid: GRP, isGroup: true, fromMe: true, text: 'Vamos ver preço na aula de quinta.', ts: NOW - 9 * DAY }))
})

describe('índice da busca (gatilhos)', () => {
  it('mensagem nova entra; transcrição pronta entra depois; o áudio vira achável', () => {
    expect(runSearch(repo, 'cliente', {}, NOW).result.total).toBe(0)
    repo.setTranscript('b1', 'Tenho medo de perder cliente se eu subir o valor', 'done')
    const r = runSearch(repo, 'quem falou de perder cliente?', {}, NOW).result
    expect(r.mode).toBe('and')
    expect(r.groups.map((g) => g.jid)).toEqual([BIA])
    expect(r.groups[0].hits[0]).toMatchObject({ id: 'b1', kind: 'audio' })
    // trocar a transcrição atualiza o índice
    repo.setTranscript('b1', 'outro assunto', 'done')
    expect(runSearch(repo, 'cliente', {}, NOW).result.total).toBe(0)
  })

  it('migração preenche o índice de um banco que já tinha mensagens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'saga-fts-'))
    try {
      const file = join(dir, 'saga.db')
      let db = openDb(file)
      let r = new Repo(db)
      r.upsertContact({ jid: ANA, pushName: 'Ana Teste' })
      db.exec('DROP TRIGGER messages_fts_ai; DROP TRIGGER messages_fts_au; DROP TRIGGER messages_fts_ad; DROP TABLE messages_fts; DROP INDEX idx_messages_ts')
      r.insertMessage(msg({ id: 'x1', jid: ANA, text: 'Precificação do pacote' }))
      db.exec('ALTER TABLE messages DROP COLUMN wa_key_json; DROP TABLE sends')
      db.exec('PRAGMA user_version = 12')
      db.close()
      db = openDb(file)
      r = new Repo(db)
      expect(r.searchIndexCount()).toBe(1)
      expect(runSearch(r, 'precificação', {}, NOW).result.total).toBe(1)
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('runSearch', () => {
  it('pergunta natural: agrupa por conversa, com quem mandou (grupo), trecho e destaque', () => {
    const { result } = runSearch(repo, 'Quem falou sobre precificação?', {}, NOW)
    expect(result.terms).toEqual(['precificacao'])
    expect(result.total).toBe(2)
    const byJid = Object.fromEntries(result.groups.map((g) => [g.jid, g]))
    expect(byJid[ANA]).toMatchObject({ name: 'Ana Teste', isGroup: false, count: 1 })
    expect(byJid[ANA].hits[0].senderName).toBeNull()
    const g = byJid[GRP]
    expect(g).toMatchObject({ name: 'Turma Exemplo', isGroup: true, count: 1 })
    expect(g.hits[0].senderName).toBe('Carla Fictícia')
    const s = g.hits[0].snippet
    expect(s.ranges.map(([a, b]) => s.text.slice(a, b))).toEqual(['precificar'])
  })

  it('sem todas as palavras juntas: mostra as com qualquer uma (modo "or")', () => {
    const r = runSearch(repo, 'precificação quinta', {}, NOW).result
    expect(r.mode).toBe('or')
    expect(r.total).toBe(3)
  })

  it('filtros: tipo, período, só áudios e uma conversa', () => {
    expect(runSearch(repo, 'precificação', { kind: 'group' }, NOW).result.groups.map((g) => g.jid)).toEqual([GRP])
    expect(runSearch(repo, 'precificação', { kind: 'individual' }, NOW).result.groups.map((g) => g.jid)).toEqual([ANA])
    expect(runSearch(repo, 'precificação', { period: '7d' }, NOW).result.groups.map((g) => g.jid)).toEqual([ANA])
    expect(runSearch(repo, 'aula', { period: '30d' }, NOW).result.total).toBe(1)
    expect(runSearch(repo, 'aula', { period: 'all' }, NOW).result.total).toBe(2)
    expect(runSearch(repo, 'precificação', { jid: GRP }, NOW).result.total).toBe(1)
    expect(runSearch(repo, 'precificação', { audioOnly: true }, NOW).result.total).toBe(0)
  })

  it('nome de quem mandou (grupos) também é achável', () => {
    const r = runSearch(repo, 'carla', {}, NOW).result
    expect(r.groups.map((g) => g.jid)).toEqual([GRP])
  })

  it('só palavras vazias: modo "empty", sem consultar', () => {
    expect(runSearch(repo, 'quem falou sobre?', {}, NOW).result).toMatchObject({ mode: 'empty', total: 0, groups: [] })
  })

  it('aspas: frase exata', () => {
    expect(runSearch(repo, '"serviço recorrente"', {}, NOW).result.total).toBe(1)
    expect(runSearch(repo, '"recorrente serviço"', {}, NOW).result.total).toBe(0)
  })
})

/**
 * Desempenho: ~100 mil mensagens sintéticas; resposta abaixo de 200 ms. Pula em CI (máquinas lentas e compartilhadas)
 * ou com `SAGA_SKIP_BENCH=1`; `SAGA_BENCH=1` força.
 */
const skipBench = process.env['SAGA_BENCH'] !== '1' && (process.env['SAGA_SKIP_BENCH'] === '1' || !!process.env['CI'])
describe.skipIf(skipBench)('desempenho da busca', () => {
  it('100 mil mensagens: menos de 200 ms por busca', () => {
    const r = new Repo(openDb(':memory:'))
    const words = ['aula', 'módulo', 'pacote', 'cliente', 'venda', 'funil', 'proposta', 'reunião', 'planilha', 'contrato', 'agenda', 'conteúdo', 'meta', 'lançamento', 'oferta', 'preço', 'mentoria', 'dúvida', 'tarefa', 'gravação']
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    const contacts = Array.from({ length: 200 }, (_, i) => `55479${String(i).padStart(8, '0')}@s.whatsapp.net`)
    for (const c of contacts) r.upsertContact({ jid: c, pushName: `Pessoa ${c.slice(5, 9)}` })
    const db = (r as unknown as { db: { exec(s: string): void } }).db
    db.exec('BEGIN')
    for (let i = 0; i < 100_000; i++) {
      const text = Array.from({ length: 12 }, () => words[Math.floor(rnd() * words.length)]).join(' ')
      r.insertMessage(msg({ id: `m${i}`, jid: contacts[i % contacts.length], text: i === 5_000 ? `${text} precificação` : text, ts: NOW - (i % 90) * DAY }))
    }
    db.exec('COMMIT')
    expect(r.searchIndexCount()).toBe(100_000)
    const queries = ['quem falou sobre precificação?', 'proposta de contrato', 'aula gravação', 'preço', '"plano de ação"']
    runSearch(r, 'aquece', {}, NOW)
    const times: number[] = []
    for (const q of queries) {
      const t = performance.now()
      runSearch(r, q, { period: '30d' }, NOW)
      runSearch(r, q, {}, NOW)
      times.push((performance.now() - t) / 2)
    }
    expect(runSearch(r, 'quem falou sobre precificação?', {}, NOW).result.total).toBe(1)
    if (process.env["SAGA_BENCH_LOG"]) console.log("busca ms", times.map((t) => t.toFixed(1)).join(" "))
    expect(Math.max(...times)).toBeLessThan(200)
  }, 120_000)
})
