import { beforeEach, describe, expect, it } from 'vitest'
import { EventBuilder, type AlertEvent, type MessageEvent, type ReplyStateEvent, type SummaryEvent } from '../../../src/core/copiloto/events'
import { chatKey, messageEventId } from '../../../src/core/copiloto/identity'
import { setNeedsReply } from '../../../src/core/ai/needsReply'
import { rateAlert } from '../../../src/core/ai/alertFeedback'
import { ANA, ANA_PHONE, BIA, BIA_PHONE, CAIO, CAIO_LID, CAIO_PHONE, G_ANA, G_BIA, OLD, OLD_PHONE, ROSTER_PHONES, rosterOf, setup } from './helpers'

let ctx: ReturnType<typeof setup>
let b: EventBuilder
const roster = new Set(rosterOf([...ROSTER_PHONES, CAIO_PHONE]))

beforeEach(() => {
  ctx = setup()
  b = new EventBuilder({ repo: ctx.repo, roster, pnForLid: (lid) => (lid === CAIO_LID ? CAIO : null) })
})

describe('Copiloto: filtro de mentorados', () => {
  it('conversa individual: só quem está no roster', () => {
    ctx.add(ANA)
    ctx.add(BIA)
    ctx.add(OLD)
    expect(b.chat(ANA)).toEqual({ key: chatKey(ANA), kind: 'individual', name: '+55 47 99999-8888', phones: [ANA_PHONE] })
    expect(b.chat(OLD)?.phones).toEqual([OLD_PHONE])
    expect(b.chat(BIA)).toBeNull()
  })

  it('@lid: usa o telefone que o app conhece; sem telefone, não entra', () => {
    ctx.add(CAIO_LID)
    expect(b.chat(CAIO_LID)?.phones).toEqual([CAIO_PHONE])
    const noMap = new EventBuilder({ repo: ctx.repo, roster })
    expect(noMap.chat(CAIO_LID)).toBeNull()
  })

  it('grupo: entra se algum participante é mentorado; chat.phones só com mentorados', () => {
    ctx.repo.upsertContact({ jid: G_ANA, isGroup: true, pushName: 'Turma de exemplo', nameRank: 2 })
    ctx.repo.setGroupMembers(G_ANA, [BIA, CAIO_LID])
    ctx.add(G_ANA, { senderJid: ANA, senderName: 'Ana' })
    ctx.add(G_ANA, { senderJid: BIA, senderName: 'Bia' })
    ctx.repo.setGroupMembers(G_BIA, [BIA])
    ctx.add(G_BIA, { senderJid: BIA })
    const chat = b.chat(G_ANA)!
    expect(chat).toMatchObject({ kind: 'group', name: 'Turma de exemplo' })
    expect(chat.phones).toEqual([CAIO_PHONE, ANA_PHONE].sort())
    expect(JSON.stringify(chat)).not.toContain(BIA_PHONE)
    expect(b.chat(G_BIA)).toBeNull()
  })

  it('nada de quem não é mentorado vira evento', () => {
    const m = ctx.add(BIA)
    expect(b.message(ctx.repo.getMessage(m.id)!)).toBeNull()
    expect(b.replyState(BIA)).toBeNull()
    expect(b.summary(BIA)).toBeNull()
  })
})

describe('Copiloto: eventos', () => {
  it('mensagem individual do mentorado e resposta do mentor', () => {
    const m = ctx.add(ANA, { text: 'Oi, tudo bem?', minutesAgo: 5 })
    const e = b.message(ctx.repo.getMessage(m.id)!)!.event as MessageEvent
    expect(e).toEqual({
      type: 'message',
      id: messageEventId(ANA, m.id),
      chat: b.chat(ANA),
      direction: 'inbound',
      sender: { phone: ANA_PHONE, name: '+55 47 99999-8888', is_mentor: false },
      message_type: 'text',
      sent_at: new Date(m.ts).toISOString(),
      text: 'Oi, tudo bem?',
      is_transcription: false,
      transcription_status: null,
      has_media: false,
      sent_via_sagazap: false
    })
    const r = ctx.add(ANA, { fromMe: true, text: 'Tudo!' })
    const out = b.message(ctx.repo.getMessage(r.id)!)!.event as MessageEvent
    expect(out).toMatchObject({ direction: 'outbound', sender: { phone: null, name: null, is_mentor: true }, sent_via_sagazap: false })
  })

  it('grupo: quem mandou só tem telefone se for mentorado', () => {
    ctx.repo.setGroupMembers(G_ANA, [ANA, BIA])
    const a = ctx.add(G_ANA, { senderJid: ANA, senderName: 'Ana' })
    const x = ctx.add(G_ANA, { senderJid: BIA, senderName: null })
    expect((b.message(ctx.repo.getMessage(a.id)!)!.event as MessageEvent).sender).toEqual({ phone: ANA_PHONE, name: 'Ana', is_mentor: false })
    const other = b.message(ctx.repo.getMessage(x.id)!)!.event as MessageEvent
    expect(other.sender).toEqual({ phone: null, name: null, is_mentor: false })
    expect(JSON.stringify(other)).not.toContain(BIA_PHONE)
  })

  it('áudio: pendente, depois com a transcrição (mesmo id)', () => {
    const m = ctx.add(ANA, { kind: 'audio', text: null, durationSec: 12 })
    const before = b.message(ctx.repo.getMessage(m.id)!)!.event as MessageEvent
    expect(before).toMatchObject({ message_type: 'audio', text: null, is_transcription: false, transcription_status: 'pending', has_media: true })
    ctx.repo.setTranscript(m.id, 'transcrição de exemplo', 'done')
    const after = b.message(ctx.repo.getMessage(m.id)!)!.event as MessageEvent
    expect(after).toMatchObject({ id: before.id, text: 'transcrição de exemplo', is_transcription: true, transcription_status: 'done' })
  })

  it('mídia: imagem, documento e outros, sem o arquivo', () => {
    const img = ctx.add(ANA, { kind: 'other', text: '[imagem]' })
    const doc = ctx.add(ANA, { kind: 'other', text: '[documento: plano.pdf]' })
    const loc = ctx.add(ANA, { kind: 'other', text: '[localização]' })
    const ev = (id: string) => b.message(ctx.repo.getMessage(id)!)!.event as MessageEvent
    expect(ev(img.id)).toMatchObject({ message_type: 'image', has_media: true })
    expect(ev(doc.id)).toMatchObject({ message_type: 'document', has_media: true })
    expect(ev(loc.id)).toMatchObject({ message_type: 'other', has_media: false })
  })

  it('alerta com avaliação e resolvido', () => {
    const m = ctx.add(ANA, { text: 'preciso de ajuda urgente' })
    ctx.repo.upsertAlert({ jid: ANA, kind: 'urgente', detail: 'Pede ajuda com urgência.', msgId: m.id })
    const id = ctx.repo.listAlerts(ANA)[0].id
    const open = b.alert(id)!.event as AlertEvent
    expect(open).toMatchObject({
      type: 'alert',
      id: `sz1:a:${id}`,
      kind: 'urgente',
      detail: 'Pede ajuda com urgência.',
      message_id: messageEventId(ANA, m.id),
      source: 'ai',
      status: 'open',
      dismissed_at: null,
      feedback: null
    })
    rateAlert(ctx.repo, id, 'down', { code: 'exagerado', text: 'nem tanto' })
    const rated = b.alert(id)!.event as AlertEvent
    expect(rated.status).toBe('dismissed')
    expect(rated.dismissed_at).not.toBeNull()
    expect(rated.feedback).toEqual({ verdict: 'down', reason_code: 'exagerado', reason_text: 'nem tanto', correct_kind: null })
  })

  it('Para responder: sem decisão fica na lista; "respondi no grupo" vira replied_in_group; resposta vira replied', () => {
    const m = ctx.add(ANA, { text: 'Tenho uma dúvida sobre o preço' })
    const first = b.replyState(ANA)!.event as ReplyStateEvent
    expect(first).toMatchObject({
      type: 'reply_state',
      id: `sz1:r:${chatKey(ANA)}`,
      last_inbound_message_id: messageEventId(ANA, m.id),
      waiting_since: new Date(m.ts).toISOString(),
      needs_reply: null,
      decided_by: null,
      resolution: null
    })
    setNeedsReply(ctx.repo, ANA, false, { code: 'respondi_grupo' })
    const fresh = new EventBuilder({ repo: ctx.repo, roster })
    expect(fresh.replyState(ANA)!.event).toMatchObject({ needs_reply: false, decided_by: 'mentor', resolution: 'replied_in_group' })
    ctx.add(ANA, { fromMe: true, text: 'Respondido', minutesAgo: 0 })
    const done = new EventBuilder({ repo: ctx.repo, roster }).replyState(ANA)!.event as ReplyStateEvent
    expect(done).toMatchObject({ needs_reply: false, resolution: 'replied', waiting_since: null })
  })

  it('Para responder: decisão da regra (só agradecimento)', () => {
    const m = ctx.add(ANA, { text: 'obrigado!' })
    ctx.repo.setAppReply({ jid: ANA, msgId: m.id, needs: false, reason: 'Só agradecimento.', source: 'rule' })
    expect(b.replyState(ANA)!.event).toMatchObject({ needs_reply: false, decided_by: 'rule', reason: 'Só agradecimento.', resolution: 'not_needed' })
  })

  it('resumo: o da última análise', () => {
    const m = ctx.add(ANA)
    ctx.repo.saveAnalysis(ANA, m.id, 'groq', 'Resumo de exemplo.', ['a', 'b'])
    expect(b.summary(ANA)!.event as SummaryEvent).toEqual({
      type: 'summary',
      id: `sz1:s:${chatKey(ANA)}`,
      chat: b.chat(ANA),
      summary: 'Resumo de exemplo.',
      last_message_id: messageEventId(ANA, m.id),
      generated_at: new Date(ctx.clock.now()).toISOString()
    })
  })

  it('envio direto confirmado: mensagem do mentor com sent_via_sagazap', () => {
    ctx.add(ANA)
    const { send } = ctx.repo.sends.enqueue({ idemKey: 'k1', replyId: 1, jid: ANA, text: 'Resposta enviada', address: ANA, quotedId: null })
    ctx.repo.sends.transition(send.id, send.attempt, ['queued'], 'sent', { sentAt: ctx.clock.now(), newMsgId: 'APPMSG1' })
    const ev = b.send(send.id)!.event as MessageEvent
    expect(ev).toMatchObject({ id: messageEventId(ANA, 'APPMSG1'), direction: 'outbound', text: 'Resposta enviada', sent_via_sagazap: true })
    // o eco chega na conversa: a mesma mensagem (mesmo id), ainda marcada como enviada pelo SagaZap
    ctx.add(ANA, { id: 'APPMSG1', fromMe: true, text: 'Resposta enviada', minutesAgo: 0 })
    const echo = b.message(ctx.repo.getMessage('APPMSG1')!)!.event as MessageEvent
    expect(echo).toMatchObject({ id: ev.id, sent_via_sagazap: true })
  })
})
