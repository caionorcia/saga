import { beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { FakeClock } from '../../../src/core/clock'
import type { NormalizedMessage } from '../../../src/core/types'

const JID_A = '5547999998888@s.whatsapp.net'
const JID_B = '5511988887777@s.whatsapp.net'

function msg(over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: 'm1',
    jid: JID_A,
    fromMe: false,
    ts: 1_000,
    kind: 'text',
    text: 'oi',
    mediaKeyJson: null,
    durationSec: null,
    ...over
  }
}

describe('Repo', () => {
  let db: DatabaseSync
  let repo: Repo

  beforeEach(() => {
    db = openDb(':memory:')
    repo = new Repo(db)
    repo.upsertContact({ jid: JID_A })
    repo.upsertContact({ jid: JID_B })
  })

  it('insertMessage ignora id repetido', () => {
    expect(repo.insertMessage(msg())).toBe(true)
    expect(repo.insertMessage(msg())).toBe(false)
    expect(repo.listMessages(JID_A)).toHaveLength(1)
  })

  it('guarda duration_sec e converte from_me para boolean', () => {
    repo.insertMessage(msg({ kind: 'audio', text: null, durationSec: 42, fromMe: true }))
    const [m] = repo.listMessages(JID_A)
    expect(m.durationSec).toBe(42)
    expect(m.fromMe).toBe(true)
  })

  it('listContacts ordena pela mensagem mais recente e calcula awaitingReply', () => {
    repo.insertMessage(msg({ id: 'a1', jid: JID_A, ts: 1_000, fromMe: false }))
    repo.insertMessage(msg({ id: 'b1', jid: JID_B, ts: 2_000, fromMe: false }))
    repo.insertMessage(msg({ id: 'b2', jid: JID_B, ts: 3_000, fromMe: true }))
    repo.insertMessage(msg({ id: 'a2', jid: JID_A, ts: 4_000, fromMe: false }))
    let list = repo.listContacts({ includeHidden: false })
    expect(list.map((c) => c.jid)).toEqual([JID_A, JID_B])
    expect(list[0].awaitingReply).toBe(true)
    expect(list[1].awaitingReply).toBe(false)
    repo.insertMessage(msg({ id: 'b3', jid: JID_B, ts: 5_000, fromMe: true }))
    list = repo.listContacts({ includeHidden: false })
    expect(list.map((c) => c.jid)).toEqual([JID_B, JID_A])
  })

  it('setHidden esconde o contato da lista', () => {
    repo.setHidden(JID_A, true)
    expect(repo.listContacts({ includeHidden: false }).map((c) => c.jid)).toEqual([JID_B])
    expect(repo.listContacts({ includeHidden: true })).toHaveLength(2)
  })

  it('nome exibido: custom_name ?? push_name ?? número formatado', () => {
    expect(repo.listContacts({ includeHidden: true }).find((c) => c.jid === JID_A)!.displayName).toBe(
      '+55 47 99999-8888'
    )
    repo.upsertContact({ jid: JID_A, pushName: 'Fulano' })
    expect(repo.listContacts({ includeHidden: true }).find((c) => c.jid === JID_A)!.displayName).toBe('Fulano')
    repo.renameContact(JID_A, 'Mentor Zé')
    expect(repo.listContacts({ includeHidden: true }).find((c) => c.jid === JID_A)!.displayName).toBe('Mentor Zé')
  })

  it('upsertContact sem pushName não apaga o nome existente', () => {
    repo.upsertContact({ jid: JID_A, pushName: 'Fulano' })
    repo.upsertContact({ jid: JID_A })
    expect(repo.listContacts({ includeHidden: true }).find((c) => c.jid === JID_A)!.pushName).toBe('Fulano')
  })

  it('setNotes e setTranscript', () => {
    repo.setNotes(JID_A, 'cliente antigo')
    expect(repo.listContacts({ includeHidden: true }).find((c) => c.jid === JID_A)!.notes).toBe('cliente antigo')
    repo.insertMessage(msg({ id: 'au', kind: 'audio', text: null }))
    repo.setTranscript('au', 'olá mundo', 'done')
    const m = repo.listMessages(JID_A)[0]
    expect(m.transcript).toBe('olá mundo')
    expect(m.transcriptStatus).toBe('done')
  })

  it('listMessages devolve as últimas N em ordem cronológica', () => {
    for (let i = 1; i <= 5; i++) repo.insertMessage(msg({ id: `x${i}`, ts: i * 100 }))
    expect(repo.listMessages(JID_A, 2).map((m) => m.id)).toEqual(['x4', 'x5'])
  })

  it('saveAnalysis / getAnalysis substitui a anterior', () => {
    expect(repo.getAnalysis(JID_A)).toBeNull()
    repo.saveAnalysis(JID_A, 'm1', 'groq', 'resumo', ['a', 'b'])
    repo.saveAnalysis(JID_A, 'm2', 'claude', 'novo', ['c'])
    const a = repo.getAnalysis(JID_A)!
    expect(a.lastMsgId).toBe('m2')
    expect(a.provider).toBe('claude')
    expect(a.suggestions).toEqual(['c'])
  })

  it('logEvent / recentEvents mais recentes primeiro', () => {
    repo.logEvent('a', '1')
    repo.logEvent('b', '2')
    expect(repo.recentEvents(1).map((e) => e.kind)).toEqual(['b'])
    expect(repo.recentEvents(10).map((e) => e.kind)).toEqual(['b', 'a'])
  })

  it('getSetting / setSetting', () => {
    expect(repo.getSetting('k')).toBeNull()
    repo.setSetting('k', 'v1')
    repo.setSetting('k', 'v2')
    expect(repo.getSetting('k')).toBe('v2')
  })

  it('esquema: FTS5 sem acento e unicidade de jobs.key', () => {
    db.prepare(
      "INSERT INTO approved_fts(context_text, final_text) VALUES ('Preço da consultoria', 'ok')"
    ).run()
    const hit = db.prepare("SELECT count(*) AS n FROM approved_fts WHERE approved_fts MATCH 'preco'").get() as {
      n: number
    }
    expect(hit.n).toBe(1)
    const ins = db.prepare(
      "INSERT INTO jobs(type, key, payload_json, status, attempts, next_run_at, priority) VALUES ('t','k','{}','pending',0,0,0)"
    )
    ins.run()
    expect(() => ins.run()).toThrow()
  })

  it('getMessage e setAudioPath', () => {
    repo.upsertContact({ jid: JID_A })
    repo.insertMessage(msg({ id: 'a1', kind: 'audio', text: null, durationSec: 5 }))
    expect(repo.getMessage('nada')).toBeNull()
    expect(repo.getMessage('a1')).toMatchObject({ id: 'a1', kind: 'audio', audioPath: null })
    repo.setAudioPath('a1', '/m/a1.ogg')
    expect(repo.getMessage('a1')!.audioPath).toBe('/m/a1.ogg')
  })

  it('análise guarda a impressão das transcrições e quantos áudios estavam pendentes', () => {
    repo.upsertContact({ jid: JID_A })
    repo.saveAnalysis(JID_A, 'm1', 'groq', 'r', ['a', 'b'], { transcriptFp: 'fp1', pendingAudios: 2 })
    expect(repo.getAnalysis(JID_A)).toMatchObject({ transcriptFp: 'fp1', pendingAudios: 2 })
    repo.saveAnalysis(JID_A, 'm1', 'groq', 'r', ['a', 'b'])
    expect(repo.getAnalysis(JID_A)).toMatchObject({ transcriptFp: '', pendingAudios: 0 })
  })

  it('newestMessageTs, isHidden, jobCounts por tipo e requeueJob', () => {
    expect(repo.newestMessageTs()).toBeNull()
    repo.upsertContact({ jid: JID_A })
    repo.insertMessage(msg({ id: 'a', ts: 500 }))
    repo.insertMessage(msg({ id: 'b', ts: 300 }))
    expect(repo.newestMessageTs()).toBe(500)
    expect(repo.isHidden(JID_A)).toBe(false)
    repo.setHidden(JID_A, true)
    expect(repo.isHidden(JID_A)).toBe(true)
    expect(repo.isHidden('nada')).toBe(false)

    repo.insertJobIgnore('download_audio', 'a', { id: 'a' }, 0)
    repo.insertJobIgnore('transcribe', 't', { id: 'a' }, 0)
    expect(repo.jobCounts('download_audio')).toMatchObject({ pending: 1, done: 0 })
    const [j] = repo.listJobs('pending')
    repo.markJobDone(j.id)
    expect(repo.jobCounts('download_audio')).toMatchObject({ pending: 0, done: 1 })
    expect(repo.jobCounts()).toMatchObject({ pending: 1, done: 1 })
    // concluído volta a pendente; novo é inserido; pendente fica como está
    repo.requeueJob('download_audio', 'a', { id: 'a', ts: 5 }, 3)
    repo.requeueJob('download_audio', 'novo', { id: 'novo' }, 0)
    repo.requeueJob('transcribe', 't', { id: 'mudou' }, 0)
    const pend = Object.fromEntries(repo.listJobs('pending').map((x) => [x.key, x]))
    expect(pend['a']).toMatchObject({ attempts: 0, priority: 3, payload: { id: 'a', ts: 5 } })
    expect(pend['novo']).toBeTruthy()
    expect(pend['t'].payload).toEqual({ id: 'a' })
  })

  it('openDb ativa foreign_keys e é idempotente em arquivo', () => {
    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
    expect(fk.foreign_keys).toBe(1)
  })
})

describe('FakeClock', () => {
  it('advance move now e monotonic', () => {
    const c = new FakeClock(1_000)
    c.advance(500)
    expect(c.now()).toBe(1_500)
    expect(c.monotonic()).toBe(500)
  })
})
