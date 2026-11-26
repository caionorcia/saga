import { beforeEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../../src/core/clock'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { reconcileSaved, reconcileSent, saveApproved, selectExamples, similarity } from '../../../src/core/memory/memory'
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

describe('selectExamples: sugestões não escolhidas', () => {
  it('guarda as não escolhidas e inclui no máximo 2 exemplos com "rejected" (mesmo contato ou parecidos)', () => {
    for (let i = 0; i < 4; i++) {
      clock.advance(1000)
      saveApproved(repo, { jid: A, contextText: `ctx ${i}`, originalSuggestion: null, finalText: `resp ${i}`, provider: 'groq', rejected: [`nao ${i}`] })
    }
    expect(repo.listApproved({ jid: A, limit: 1 })[0].rejected).toEqual(['nao 3'])
    const ex = selectExamples(repo, A, 'zzzz')
    expect(ex.filter((e) => e.rejected).map((e) => e.rejected)).toEqual(['nao 3', 'nao 2'])
  })

  it('sem não escolhidas, ou igual à resposta final, não inclui a linha', () => {
    save(A, 'ctx', 'Resposta igual')
    clock.advance(1000)
    saveApproved(repo, { jid: A, contextText: 'ctx2', originalSuggestion: null, finalText: 'Resposta igual!', provider: 'groq', rejected: ['resposta igual'] })
    expect(selectExamples(repo, A, 'x').every((e) => e.rejected === undefined)).toBe(true)
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

describe('reconcileSaved (copiou, enviou e só depois salvou)', () => {
  const saved = 'Oi Michael, pode sim! Vamos marcar amanhã?'
  const add = (m: NormalizedMessage) => repo.insertMessage(m)

  it('liga a resposta salva à mensagem minha parecida enviada nas últimas 6 h', () => {
    add(msg('s0', A, true, clock.now() - 8 * 3_600_000, saved)) // velha demais
    add(msg('s1', A, true, clock.now() - 5 * 60_000, 'Oi Michael, pode sim! Vamos marcar amanhã às 15h?'))
    add(msg('r1', A, false, clock.now() - 60_000, saved)) // recebida, não conta
    const id = save(A, 'ctx', saved)
    reconcileSaved(repo, { id, jid: A, finalText: saved }, clock.now())
    expect(repo.listApproved({ jid: A, limit: 1 })[0].sentText).toBe('Oi Michael, pode sim! Vamos marcar amanhã às 15h?')
  })

  it('sem mensagem parecida (ou só de outro contato, ou de mais de 6 h): não grava', () => {
    add(msg('s1', B, true, clock.now() - 60_000, saved))
    add(msg('s2', A, true, clock.now() - 60_000, 'Bom dia, segue o link da reunião'))
    add(msg('s3', A, true, clock.now() - 7 * 3_600_000, saved))
    const id = save(A, 'ctx', saved)
    reconcileSaved(repo, { id, jid: A, finalText: saved }, clock.now())
    expect(repo.listApproved({ jid: A, limit: 1 })[0].sentText).toBeNull()
  })
})

describe('grupos', () => {
  const G = '120363025555555555@g.us'
  beforeEach(() => repo.upsertContact({ jid: G, isGroup: true }))

  it('same_contact usa o jid do grupo; sent_history pareia minha mensagem no grupo com a anterior de um participante', () => {
    save(G, 'ctx do grupo', 'resposta no grupo')
    save(A, 'ctx A', 'resposta A')
    repo.insertMessage({ ...msg('g1', G, false, T0 - 5000, 'Mentor, quando sai a gravação?'), isGroup: true, senderJid: B, senderName: 'Bia' })
    repo.insertMessage({ ...msg('g2', G, true, T0 - 4000, 'Sai amanhã, Bia!'), isGroup: true })
    const ex = selectExamples(repo, G, 'x')
    expect(ex[0]).toMatchObject({ source: 'same_contact', reply: 'resposta no grupo' })
    expect(ex.find((e) => e.source === 'sent_history')).toEqual({ context: 'Mentor, quando sai a gravação?', reply: 'Sai amanhã, Bia!', source: 'sent_history' })
  })

  it('reconcileSent liga a resposta aprovada à mensagem que postei no grupo', () => {
    const id = save(G, 'ctx', 'Sai amanhã, pessoal!')
    reconcileSent(repo, { ...msg('g9', G, true, clock.now() + 1000, 'Sai amanhã, pessoal!!'), isGroup: true })
    expect(repo.listApproved({ jid: G, limit: 5 }).find((a) => a.id === id)!.sentText).toBe('Sai amanhã, pessoal!!')
  })
})
