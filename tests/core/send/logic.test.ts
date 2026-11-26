import { describe, expect, it } from 'vitest'
import type { MessageRow } from '../../../src/core/db/repo'
import { errCode, findSentEcho, hasRecentContactMessage, messageKey, newMessageId, pickQuote, quotedMessage, sendAddress, unreadKeys } from '../../../src/core/send/logic'
import { SendGate } from '../../../src/core/send/gate'
import { FakeClock } from '../../../src/core/clock'
import { typingMs } from '../../../src/shared/send'

const NOW = 1_764_000_000_000
const GRP = '120363025555555555@g.us'
const ANA = '5547999998888@s.whatsapp.net'
const BIA = '5511988887777@s.whatsapp.net'

function m(o: Partial<MessageRow> & { id: string; ts: number }): MessageRow {
  return {
    jid: GRP,
    fromMe: false,
    kind: 'text',
    text: 'oi',
    mediaKeyJson: null,
    durationSec: null,
    audioPath: null,
    transcript: null,
    transcriptStatus: null,
    senderJid: ANA,
    senderName: 'Ana',
    senderLabel: 'Ana',
    mentionsMe: false,
    waKeyJson: null,
    ...o
  }
}

describe('envio: regras puras', () => {
  it('grupo: cita a mais recente que menciona/cita o mentor depois da última dele', () => {
    const msgs = [
      m({ id: 'a', ts: 1, mentionsMe: true }),
      m({ id: 'me', ts: 2, fromMe: true, senderJid: null }),
      m({ id: 'b', ts: 3, mentionsMe: true, senderJid: BIA }),
      m({ id: 'c', ts: 4, mentionsMe: true }),
      m({ id: 'd', ts: 5 })
    ]
    expect(pickQuote(msgs)?.id).toBe('c')
  })

  it('grupo: sem menção, cita a mais recente do contato depois da última do mentor; o mentor por último → nada', () => {
    expect(pickQuote([m({ id: 'me', ts: 1, fromMe: true }), m({ id: 'b', ts: 2 }), m({ id: 'c', ts: 3 })])?.id).toBe('c')
    // a menção de antes da resposta do mentor já foi respondida
    expect(pickQuote([m({ id: 'a', ts: 1, mentionsMe: true }), m({ id: 'me', ts: 2, fromMe: true }), m({ id: 'b', ts: 3 })])?.id).toBe('b')
    expect(pickQuote([m({ id: 'a', ts: 1 }), m({ id: 'me', ts: 2, fromMe: true })])).toBeNull()
  })

  it('citação usa a chave original (participante como veio) e o áudio como veio', () => {
    const q = quotedMessage(m({ id: 'G1', ts: 5_000, text: 'pergunta', waKeyJson: JSON.stringify({ remoteJid: GRP, id: 'G1', participant: '888:1@lid' }) }))
    expect(q).toEqual({ key: { remoteJid: GRP, id: 'G1', fromMe: false, participant: '888:1@lid' }, message: { conversation: 'pergunta' }, messageTimestamp: 5 })
    // mensagem antiga (antes da v0.4.0): chave reconstruída pela conversa e pelo remetente
    expect(messageKey(m({ id: 'old', ts: 1 }))).toEqual({ remoteJid: GRP, id: 'old', fromMe: false, participant: ANA })
    const audio = quotedMessage(m({ id: 'A1', ts: 1, kind: 'audio', text: null, mediaKeyJson: JSON.stringify({ key: {}, message: { audioMessage: { seconds: 9 } } }) }))
    expect(audio.message).toEqual({ audioMessage: { seconds: 9 } })
  })

  it('marcar como lida: só as do contato depois da última resposta do mentor, só com a chave original (nunca reconstruída)', () => {
    const lidKey = JSON.stringify({ remoteJid: '999:2@lid', id: 'x2' })
    const pnKey = JSON.stringify({ remoteJid: ANA, id: 'x3' })
    const msgs = [
      m({ id: 'x0', ts: 1, jid: ANA, senderJid: null, waKeyJson: JSON.stringify({ remoteJid: ANA, id: 'x0' }) }),
      m({ id: 'me', ts: 2, jid: ANA, fromMe: true, senderJid: null }),
      // de antes da v0.4.0: sem chave original, fica de fora
      m({ id: 'x1', ts: 3, jid: ANA, senderJid: null }),
      m({ id: 'x2', ts: 4, jid: ANA, senderJid: null, waKeyJson: lidKey }),
      m({ id: 'x3', ts: 5, jid: ANA, senderJid: null, waKeyJson: pnKey })
    ]
    expect(unreadKeys(msgs)).toEqual([
      { remoteJid: '999:2@lid', id: 'x2', fromMe: false },
      { remoteJid: ANA, id: 'x3', fromMe: false }
    ])
  })

  it('destino: grupo é o grupo; individual é o JID com que o contato escreveu por último (@lid sem dispositivo, senão o telefone)', () => {
    expect(sendAddress([m({ id: 'g', ts: 1 })], GRP)).toBe(GRP)
    const lid = (id: string, ts: number, remote: string) => m({ id, ts, jid: ANA, senderJid: null, waKeyJson: JSON.stringify({ remoteJid: remote, id }) })
    expect(sendAddress([lid('a', 1, ANA), lid('b', 2, '999:7@lid')], ANA)).toBe('999@lid')
    expect(sendAddress([lid('a', 1, '999:7@lid'), lid('b', 2, '5547999998888:3@s.whatsapp.net')], ANA)).toBe(ANA)
    // sem chave original (mensagens antigas) ou só minhas: o JID da conversa
    expect(sendAddress([m({ id: 'a', ts: 1, jid: ANA }), m({ id: 'me', ts: 2, jid: ANA, fromMe: true })], ANA)).toBe(ANA)
  })

  it('id de mensagem no formato do WhatsApp Web; erro vira só tipo e código (sem número nem texto)', () => {
    expect(newMessageId()).toMatch(/^3EB0[0-9A-F]{36}$/)
    expect(newMessageId()).not.toBe(newMessageId())
    const e = Object.assign(new Error('falhou para 5547999998888@s.whatsapp.net'), { output: { statusCode: 408 } })
    expect(errCode(e)).toBe('Error 408')
    expect(errCode(Object.assign(new TypeError('x 5511@lid'), {}))).toBe('TypeError')
    expect(errCode('texto com 5547999998888')).toBe('Error')
  })

  it('só responde: o contato precisa ter mandado mensagem nos últimos 30 dias (as minhas não contam)', () => {
    const DAY = 86_400_000
    expect(hasRecentContactMessage([m({ id: 'a', ts: NOW - 29 * DAY })], NOW)).toBe(true)
    // figurinha/mídia contam como conteúdo
    expect(hasRecentContactMessage([m({ id: 'st', ts: NOW - DAY, kind: 'other', text: '[figurinha]' })], NOW)).toBe(true)
    // um tipo que não é conteúdo (defesa: reações e controle nem chegam ao banco) não conta
    expect(hasRecentContactMessage([m({ id: 'r', ts: NOW - DAY, kind: 'reaction' as any })], NOW)).toBe(false)
    expect(hasRecentContactMessage([m({ id: 'a', ts: NOW - 31 * DAY }), m({ id: 'me', ts: NOW - DAY, fromMe: true })], NOW)).toBe(false)
    expect(hasRecentContactMessage([], NOW)).toBe(false)
  })

  it('conferir: pelo id gerado pelo app (qualquer tentativa), só mensagem minha; sem comparar relógio nem texto', () => {
    const db = new Map([
      ['ID1', m({ id: 'ID1', ts: NOW + 3 * 3_600_000, fromMe: true, text: 'Outro texto (editado no celular)' })],
      ['THEIRS', m({ id: 'THEIRS', ts: NOW, text: 'Combinado!' })]
    ])
    const get = (id: string) => db.get(id) ?? null
    expect(findSentEcho(['ID0', 'ID1'], get)?.id).toBe('ID1')
    expect(findSentEcho(['ID0'], get)).toBeNull()
    expect(findSentEcho(['THEIRS'], get)).toBeNull()
    expect(findSentEcho([], get)).toBeNull()
  })

  it('"digitando…": 1,5 s + 35 ms por caractere, no máximo 8 s, com até 0,5 s de sorteio', () => {
    expect(typingMs('')).toBe(1_500)
    expect(typingMs('a'.repeat(100))).toBe(5_000)
    expect(typingMs('a'.repeat(1000))).toBe(8_000)
    expect(typingMs('a'.repeat(1000), 1)).toBe(8_500)
    expect(typingMs('oi', 0.5)).toBe(1_570 + 250)
  })

  describe('confirmação (token)', () => {
    it('uso único, só para o mesmo jid e texto, vale 5 min', () => {
      const clock = new FakeClock(NOW)
      const gate = new SendGate(clock)
      const a = gate.issue(ANA, ' Oi! ')
      expect(a.expiresAt).toBe(NOW + 5 * 60_000)
      expect(gate.consume(a.token, ANA, 'Oi!')).toEqual({ address: ANA, quotedId: null })
      expect(gate.consume(a.token, ANA, 'Oi!')).toBeNull()
      // o destino e a citação vistos na confirmação ficam presos ao token
      const bound = gate.issue(GRP, 'Oi!', { address: GRP, quotedId: 'G7' })
      expect(gate.consume(bound.token, GRP, 'Oi!')).toEqual({ address: GRP, quotedId: 'G7' })

      const b = gate.issue(ANA, 'Oi!')
      expect(gate.consume(b.token, ANA, 'Oi! editado')).toBeNull()
      // uma tentativa errada gasta o token
      expect(gate.consume(b.token, ANA, 'Oi!')).toBeNull()

      const c = gate.issue(ANA, 'Oi!')
      expect(gate.consume(c.token, BIA, 'Oi!')).toBeNull()

      const d = gate.issue(ANA, 'Oi!')
      clock.advance(5 * 60_000)
      expect(gate.consume(d.token, ANA, 'Oi!')).toBeNull()
      expect(gate.consume('inventado', ANA, 'Oi!')).toBeNull()
    })
  })
})
