import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  alertEventId,
  chatKey,
  generateCode,
  inRoster,
  isRosterHash,
  messageEventId,
  normalizePhone,
  phoneOfJid,
  phoneVariants,
  replyStateEventId,
  rosterHash,
  summaryEventId
} from '../../../src/core/copiloto/identity'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('Copiloto: telefones', () => {
  it('normaliza: só dígitos; 10 ou 11 dígitos ganham o 55', () => {
    expect(normalizePhone('(47) 99999-8888')).toBe('5547999998888')
    expect(normalizePhone('47 8888-7777')).toBe('554788887777')
    expect(normalizePhone('+55 47 99999-8888')).toBe('5547999998888')
    expect(normalizePhone('5547999998888')).toBe('5547999998888')
    // a regra é só pelo tamanho (igual no servidor): 11 dígitos sempre ganham o 55; 12+ ficam como estão
    expect(normalizePhone('+1 415 555 0100')).toBe('5514155550100')
    expect(normalizePhone('+44 20 7946 0958')).toBe('442079460958')
    expect(normalizePhone('')).toBeNull()
    expect(normalizePhone('sem número')).toBeNull()
    expect(normalizePhone(null)).toBeNull()
  })

  it('nono dígito: celular BR nas duas formas; fixo e estrangeiro só na própria', () => {
    expect(phoneVariants('5547999998888')).toEqual(['5547999998888', '554799998888'])
    expect(phoneVariants('554788887777')).toEqual(['554788887777', '5547988887777'])
    // fixo (começa com 2–5) não ganha o 9
    expect(phoneVariants('554733334444')).toEqual(['554733334444'])
    expect(phoneVariants('442079460958')).toEqual(['442079460958'])
  })

  it('telefone do JID: só @s.whatsapp.net, sem o dispositivo', () => {
    expect(phoneOfJid('5547999998888@s.whatsapp.net')).toBe('5547999998888')
    expect(phoneOfJid('5547999998888:12@s.whatsapp.net')).toBe('5547999998888')
    expect(phoneOfJid('123@lid')).toBeNull()
    expect(phoneOfJid('120363000000000001@g.us')).toBeNull()
  })

  it('roster: sha256hex("sagazap-v1:" + telefone), casando qualquer forma do celular', () => {
    expect(rosterHash('5547999998888')).toBe(sha('sagazap-v1:5547999998888'))
    expect(isRosterHash(rosterHash('1'))).toBe(true)
    expect(isRosterHash('XYZ')).toBe(false)
    // o servidor mandou só a forma com o 9; a conta antiga (sem o 9) casa mesmo assim
    const roster = new Set([rosterHash('5547988887777')])
    expect(inRoster('554788887777', roster)).toBe(true)
    expect(inRoster('5511988887777', roster)).toBe(false)
  })
})

describe('Copiloto: identificadores', () => {
  const jid = '5547999998888@s.whatsapp.net'
  it('chat.key e ids como no contrato', () => {
    expect(chatKey(jid)).toBe(sha(`sagazap-chat-v1:${jid}`))
    const id = messageEventId(jid, 'ABC123')
    expect(id).toBe(`sz1:m:${sha(`${jid}|ABC123`).slice(0, 40)}`)
    expect(id).toHaveLength('sz1:m:'.length + 40)
    expect(alertEventId(7)).toBe('sz1:a:7')
    expect(replyStateEventId(jid)).toBe(`sz1:r:${chatKey(jid)}`)
    expect(summaryEventId(jid)).toBe(`sz1:s:${chatKey(jid)}`)
  })

  it('o código tem 32 bytes aleatórios em base64url', () => {
    const a = generateCode()
    const b = generateCode()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(a, 'base64url')).toHaveLength(32)
    expect(a).not.toBe(b)
  })
})
