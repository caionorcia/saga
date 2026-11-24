import { beforeEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../../src/core/clock'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { reconcileSent, saveApproved, selectExamples, similarity } from '../../../src/core/memory/memory'
import type { NormalizedMessage } from '../../../src/core/types'

const T0 = 1_700_000_000_000
const A = '5547999990001@s.whatsapp.net'
const B = '5547999990002@s.whatsapp.net'

let clock: FakeClock
let repo: Repo
let db: ReturnType<typeof openDb>

function msg(id: string, jid: string, fromMe: boolean, ts: number, text: string): NormalizedMessage {
  return { id, jid, fromMe, ts, kind: 'text', text, mediaKeyJson: null, durationSec: null }
}

function save(jid: string, ctx: string, final: string): number {
  clock.advance(1000)
  return saveApproved(repo, { jid, contextText: ctx, originalSuggestion: null, finalText: final, provider: 'groq' })
}

beforeEach(() => {
  clock = new FakeClock(T0)
  db = openDb(':memory:')
  repo = new Repo(db, clock)
  repo.upsertContact({ jid: A })
  repo.upsertContact({ jid: B })
})

describe('selectExamples', () => {
  it('sem respostas salvas nem histórico devolve []', () => {
    expect(selectExamples(repo, A, 'olá, tudo bem?')).toEqual([])
  })

  it('prioriza o mesmo contato (mais recentes) e não repete entre fontes', () => {
    for (let i = 0; i < 4; i++) save(A, `contexto A${i}`, `resposta A${i}`)
    save(B, 'contexto B0', 'resposta B0')
    const ex = selectExamples(repo, A, 'zzzz yyyy')
    const same = ex.filter((e) => e.source === 'same_contact')
    expect(same.map((e) => e.reply)).toEqual(['resposta A3', 'resposta A2', 'resposta A1'])
    const replies = ex.map((e) => e.reply)
    expect(new Set(replies).size).toBe(replies.length)
    expect(ex.some((e) => e.source === 'recent' && e.reply === 'resposta B0')).toBe(true)
    // A0 não foi escolhida por same_contact, mas pode entrar como recent
    expect(ex.filter((e) => e.source === 'recent').length).toBeLessThanOrEqual(2)
  })

  it('similar acha a resposta cujo contexto tem "precificação"', () => {
    save(B, 'Michael perguntou sobre precificação do serviço', 'Vamos revisar sua tabela juntos.')
    for (let i = 0; i < 3; i++) save(B, `assunto qualquer ${i}`, `resposta recente ${i}`)
    const ex = selectExamples(repo, A, 'Preciso ajuda na precificação dos produtos')
    const sim = ex.find((e) => e.source === 'similar')
    expect(sim?.reply).toBe('Vamos revisar sua tabela juntos.')
  })

  it('usa sent_text quando existe e inclui histórico real fromMe', () => {
    const id = save(A, 'ctx', 'rascunho aprovado')
    repo.setApprovedSentText(id, 'texto realmente enviado')
    repo.insertMessage(msg('m1', A, false, T0 - 5000, 'Posso marcar para amanhã?'))
    repo.insertMessage(msg('m2', A, true, T0 - 4000, 'Pode sim, às 15h.'))
    const ex = selectExamples(repo, A, 'x')
    expect(ex[0]).toMatchObject({ source: 'same_contact', reply: 'texto realmente enviado' })
    expect(ex.find((e) => e.source === 'sent_history')).toEqual({
      context: 'Posso marcar para amanhã?',
      reply: 'Pode sim, às 15h.',
      source: 'sent_history'
    })
  })
})

describe('sent_history com áudio', () => {
  it('só usa transcrição quando status done', () => {
    repo.insertMessage({ id: 'a1', jid: A, fromMe: false, ts: T0 - 9000, kind: 'audio', text: null, mediaKeyJson: null, durationSec: 5 })
    repo.setTranscript('a1', 'texto parcial', 'failed')
    repo.insertMessage(msg('r1', A, true, T0 - 8000, 'Resposta ao áudio'))
    expect(selectExamples(repo, A, 'x').filter((e) => e.source === 'sent_history')).toEqual([])
    repo.setTranscript('a1', 'texto do áudio', 'done')
    expect(selectExamples(repo, A, 'x').find((e) => e.source === 'sent_history')?.context).toBe('texto do áudio')
  })
})

describe('reconcileSent', () => {
  const saved = 'Oi Michael, pode sim! Vamos marcar amanhã?'
  it('grava sent_text quando enviado 10 min depois com texto parecido', () => {
    const id = save(A, 'ctx', saved)
    reconcileSent(repo, msg('s1', A, true, clock.now() + 10 * 60_000, 'Oi Michael, pode sim! Vamos marcar amanhã às 15h?'))
    expect(repo.listApproved({ jid: A, limit: 1 })[0]).toMatchObject({ id, sentText: 'Oi Michael, pode sim! Vamos marcar amanhã às 15h?' })
  })
  it('não grava 7 h depois', () => {
    save(A, 'ctx', saved)
    reconcileSent(repo, msg('s1', A, true, clock.now() + 7 * 3_600_000, saved))
    expect(repo.listApproved({ jid: A, limit: 1 })[0].sentText).toBeNull()
  })
  it('não grava texto totalmente diferente, nem de outro contato, nem mensagem recebida', () => {
    save(A, 'ctx', saved)
    reconcileSent(repo, msg('s1', A, true, clock.now() + 60_000, 'Bom dia, segue o link da reunião'))
    reconcileSent(repo, msg('s2', B, true, clock.now() + 60_000, saved))
    reconcileSent(repo, msg('s3', A, false, clock.now() + 60_000, saved))
    expect(repo.listApproved({ jid: A, limit: 1 })[0].sentText).toBeNull()
  })
  it('similarity ignora caixa e pontuação', () => {
    expect(similarity('Oi, tudo bem?', 'oi tudo bem')).toBe(1)
    expect(similarity('abc', 'xyz')).toBe(0)
  })
})

describe('FTS sincronizado por trigger', () => {
  it('update e delete refletem no índice', () => {
    const id = save(A, 'consultoria de preço', 'ok')
    expect(repo.searchApproved('"preco"', 5)).toHaveLength(1)
    db.prepare('UPDATE approved_replies SET context_text = ? WHERE id = ?').run('outro assunto', id)
    expect(repo.searchApproved('"preco"', 5)).toHaveLength(0)
    db.prepare('DELETE FROM approved_replies WHERE id = ?').run(id)
    expect(repo.searchApproved('"assunto"', 5)).toHaveLength(0)
  })
})
