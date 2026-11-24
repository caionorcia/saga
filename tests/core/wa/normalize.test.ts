import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BufferJSON, type WAMessage } from '@whiskeysockets/baileys'
import { normalize, isIndividualJid, toPhoneJid } from '../../../src/core/wa/normalize'

const FIX = join(__dirname, '../../fixtures/wa')
const load = (name: string): WAMessage => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'), BufferJSON.reviver)
const JID = '5547999998888@s.whatsapp.net'

function make(message: any, over: Partial<WAMessage['key']> = {}): WAMessage {
  return { key: { remoteJid: JID, fromMe: false, id: 'X1', ...over }, messageTimestamp: 1763900000, message } as WAMessage
}

describe('normalize', () => {
  it('texto simples (conversation)', () => {
    expect(normalize(load('text'))).toEqual({
      id: 'TXT1',
      jid: JID,
      fromMe: false,
      ts: 1763900000_000,
      kind: 'text',
      text: 'Oi, tudo bem?',
      mediaKeyJson: null,
      durationSec: null
    })
  })

  it('extendedTextMessage com citação devolve o texto da própria mensagem', () => {
    const n = normalize(load('extended-quote'))!
    expect(n.text).toBe('Minha resposta')
    expect(n.kind).toBe('text')
    expect(n.fromMe).toBe(true)
  })

  it('áudio PTT com seconds=37 vira kind audio com a mensagem serializada', () => {
    const raw = load('audio-ptt')
    const n = normalize(raw)!
    expect(n.kind).toBe('audio')
    expect(n.durationSec).toBe(37)
    expect(n.text).toBeNull()
    expect(n.mediaKeyJson).not.toBeNull()
    const back = JSON.parse(n.mediaKeyJson!, BufferJSON.reviver)
    expect(back.key.id).toBe('AUD1')
    expect(Buffer.isBuffer(back.message.audioMessage.mediaKey)).toBe(true)
    expect(Buffer.compare(back.message.audioMessage.mediaKey, raw.message!.audioMessage!.mediaKey as Buffer)).toBe(0)
  })

  it('mensagem de grupo → null', () => {
    expect(normalize(load('group'))).toBeNull()
  })

  it('protocolMessage REVOKE → null', () => {
    expect(normalize(load('revoke'))).toBeNull()
  })

  it('reação → null', () => {
    expect(normalize(load('reaction'))).toBeNull()
  })

  it('ephemeralMessage com texto é desembrulhada', () => {
    const n = normalize(load('ephemeral'))!
    expect(n.kind).toBe('text')
    expect(n.text).toBe('Mensagem temporária')
  })

  it('imagem com legenda → other com a legenda', () => {
    const n = normalize(load('image-caption'))!
    expect(n.kind).toBe('other')
    expect(n.text).toBe('Olha isso')
    expect(n.mediaKeyJson).toBeNull()
  })

  it('imagem/vídeo/documento sem legenda usam rótulos', () => {
    expect(normalize(make({ imageMessage: { mimetype: 'image/jpeg' } }))!.text).toBe('[imagem]')
    expect(normalize(make({ videoMessage: { mimetype: 'video/mp4' } }))!.text).toBe('[vídeo]')
    expect(normalize(make({ documentMessage: { fileName: 'contrato.pdf' } }))!.text).toBe('[documento: contrato.pdf]')
    expect(normalize(make({ documentWithCaptionMessage: { message: { documentMessage: { fileName: 'a.pdf', caption: 'leia' } } } }))!.text).toBe('leia')
  })

  it('visualização única é desembrulhada', () => {
    const n = normalize(make({ viewOnceMessageV2: { message: { imageMessage: { caption: 'uma vez' } } } }))!
    expect(n.kind).toBe('other')
    expect(n.text).toBe('uma vez')
  })

  it('status, newsletter, broadcast, edição e mensagens sem conteúdo → null', () => {
    expect(normalize(make({ conversation: 'x' }, { remoteJid: 'status@broadcast' }))).toBeNull()
    expect(normalize(make({ conversation: 'x' }, { remoteJid: '120363000000000000@newsletter' }))).toBeNull()
    expect(normalize(make({ conversation: 'x' }, { remoteJid: '1234567890@broadcast' }))).toBeNull()
    expect(normalize(make({ editedMessage: { message: { protocolMessage: { type: 14 } } } }))).toBeNull()
    expect(normalize(make(undefined))).toBeNull()
    expect(normalize(make({}))).toBeNull()
    expect(normalize(make({ conversation: '' }))).toBeNull()
    expect(normalize(make({ senderKeyDistributionMessage: { groupId: 'g' }, messageContextInfo: {} }))).toBeNull()
    expect(normalize(make({ conversation: 'x' }, { id: undefined }))).toBeNull()
  })

  it('LID com remoteJidAlt em telefone usa o JID do telefone', () => {
    const n = normalize(load('lid-with-alt'))!
    expect(n.jid).toBe(JID)
  })

  it('LID sem alternativa mantém o @lid; timestamp Long é aceito', () => {
    const n = normalize(load('lid-only'))!
    expect(n.jid).toBe('123456789012345@lid')
    expect(n.ts).toBe(1763900800_000)
  })

  it('fromMe em chat @lid: remoteJidAlt igual ao meu número é ignorado (fica no contato)', () => {
    const raw = load('lid-fromme-own-alt')
    expect(normalize(raw, { ownJid: '5547900000000:12@s.whatsapp.net' })!.jid).toBe('123456789012345@lid')
    // sem saber o próprio número, a alternativa de uma mensagem minha não é confiável
    expect(normalize(raw)!.jid).toBe('123456789012345@lid')
    // alternativa diferente do meu número continua valendo
    const other = { ...raw, key: { ...raw.key, remoteJidAlt: JID } }
    expect(normalize(other, { ownJid: '5547900000000@s.whatsapp.net' })!.jid).toBe(JID)
  })

  it('remove o sufixo de dispositivo do JID', () => {
    expect(normalize(make({ conversation: 'x' }, { remoteJid: '5547999998888:12@s.whatsapp.net' }))!.jid).toBe(JID)
  })
})

describe('helpers de JID', () => {
  it('isIndividualJid', () => {
    expect(isIndividualJid(JID)).toBe(true)
    expect(isIndividualJid('1@lid')).toBe(true)
    expect(isIndividualJid('1@g.us')).toBe(false)
    expect(isIndividualJid('status@broadcast')).toBe(false)
    expect(isIndividualJid(undefined)).toBe(false)
  })

  it('toPhoneJid normaliza só JIDs de telefone', () => {
    expect(toPhoneJid('5547999998888:3@s.whatsapp.net')).toBe(JID)
    expect(toPhoneJid('1@lid')).toBeNull()
    expect(toPhoneJid(null)).toBeNull()
  })
})
