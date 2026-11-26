import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BufferJSON, type WAMessage } from '@whiskeysockets/baileys'
import { normalize, isGroupJid, isIndividualJid, toPhoneJid } from '../../../src/core/wa/normalize'

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
      durationSec: null,
      waKeyJson: JSON.stringify({ remoteJid: JID, id: 'TXT1' })
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

  it('mensagem de grupo: conversa @g.us com o remetente (participant) e o pushName dele', () => {
    expect(normalize(load('group'))).toEqual({
      id: 'GRP1',
      jid: '120363025555555555@g.us',
      fromMe: false,
      ts: 1763900000_000,
      kind: 'text',
      text: 'mensagem no grupo',
      mediaKeyJson: null,
      durationSec: null,
      waKeyJson: JSON.stringify({ remoteJid: '120363025555555555@g.us', id: 'GRP1', participant: JID }),
      isGroup: true,
      senderJid: JID,
      senderName: 'Ana',
      mentionsMe: false
    })
  })

  it('grupo: participant @lid com participantAlt em telefone usa o telefone; sem alternativa fica o @lid', () => {
    const g = (key: any) => normalize(make({ conversation: 'x' }, { remoteJid: '1203@g.us', ...key }))!
    expect(g({ participant: '999:2@lid', participantAlt: '5511988887777:4@s.whatsapp.net' }).senderJid).toBe('5511988887777@s.whatsapp.net')
    expect(g({ participant: '999:2@lid' }).senderJid).toBe('999@lid')
    expect(g({ participant: '5511988887777:7@s.whatsapp.net' }).senderJid).toBe('5511988887777@s.whatsapp.net')
  })

  it('grupo: mensagem minha não tem remetente nem nome; fromMe igual', () => {
    const n = normalize({ ...make({ conversation: 'eu' }, { remoteJid: '1203@g.us', fromMe: true, participant: '5547900000000@s.whatsapp.net' }), pushName: 'Mentor' } as WAMessage)!
    expect(n).toMatchObject({ jid: '1203@g.us', fromMe: true, isGroup: true, senderJid: null, senderName: null })
    // a chave original só é guardada nas mensagens do contato (citar e marcar como lida)
    expect(n.waKeyJson).toBeUndefined()
  })

  it('mensagem do contato guarda a chave original (@lid como veio, com o participante no grupo), sem conteúdo', () => {
    const n = normalize(make({ conversation: 'oi' }, { remoteJid: '999:2@lid', remoteJidAlt: '5511988887777@s.whatsapp.net', id: 'L1' } as any))!
    expect(n.jid).toBe('5511988887777@s.whatsapp.net')
    expect(JSON.parse(n.waKeyJson!)).toEqual({ remoteJid: '999:2@lid', id: 'L1' })
    const g = normalize(make({ conversation: 'x' }, { remoteJid: '1203@g.us', participant: '888:1@lid', id: 'G1' }))!
    expect(JSON.parse(g.waKeyJson!)).toEqual({ remoteJid: '1203@g.us', id: 'G1', participant: '888:1@lid' })
  })

  it('grupo: menção ao mentor (telefone ou @lid) ou citação de mensagem dele → mentionsMe', () => {
    const opts = { ownJid: '5547900000000:3@s.whatsapp.net', ownLid: '777000:3@lid' }
    const g = (message: any) => normalize(make(message, { remoteJid: '1203@g.us', participant: JID }), opts)!.mentionsMe
    expect(g({ extendedTextMessage: { text: '@5547900000000 pode ajudar?', contextInfo: { mentionedJid: ['5547900000000@s.whatsapp.net'] } } })).toBe(true)
    expect(g({ extendedTextMessage: { text: '@777000 oi', contextInfo: { mentionedJid: ['777000@lid'] } } })).toBe(true)
    expect(g({ extendedTextMessage: { text: '@outro', contextInfo: { mentionedJid: ['5511988887777@s.whatsapp.net'] } } })).toBe(false)
    expect(g({ extendedTextMessage: { text: 'isso!', contextInfo: { participant: '777000@lid', stanzaId: 'Q1' } } })).toBe(true)
    expect(g({ audioMessage: { seconds: 5, contextInfo: { mentionedJid: ['5547900000000@s.whatsapp.net'] } } })).toBe(true)
    expect(g({ conversation: 'sem menção' })).toBe(false)
    // sem saber quem sou: nunca marca
    expect(normalize(make({ extendedTextMessage: { text: 'x', contextInfo: { mentionedJid: ['5547900000000@s.whatsapp.net'] } } }, { remoteJid: '1203@g.us', participant: JID }))!.mentionsMe).toBe(false)
  })

  it('grupo, minha mensagem: targets = quem ela menciona e o autor da mensagem citada (sem dispositivo); nas dos outros, nada', () => {
    const mine = (message: any) => normalize(make(message, { remoteJid: '1203@g.us', fromMe: true }))!
    expect(
      mine({ extendedTextMessage: { text: '@Ana veja', contextInfo: { mentionedJid: ['5547999998888:3@s.whatsapp.net', '777@lid'], participant: '888:2@lid', stanzaId: 'Q' } } }).targets
    ).toEqual(['5547999998888@s.whatsapp.net', '777@lid', '888@lid'])
    expect(mine({ conversation: 'bom dia, turma' }).targets).toEqual([])
    expect(mine({ extendedTextMessage: { text: 'x', contextInfo: { mentionedJid: ['1203@g.us'] } } }).targets).toEqual([])
    const theirs = normalize(make({ extendedTextMessage: { text: '@x', contextInfo: { mentionedJid: [JID] } } }, { remoteJid: '1203@g.us', participant: JID }))!
    expect(theirs.targets).toBeUndefined()
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

  it('isGroupJid', () => {
    expect(isGroupJid('120363025555555555@g.us')).toBe(true)
    expect(isGroupJid(JID)).toBe(false)
    expect(isGroupJid('status@broadcast')).toBe(false)
    expect(isGroupJid('120363000000000000@newsletter')).toBe(false)
    expect(isGroupJid(null)).toBe(false)
  })

  it('toPhoneJid normaliza só JIDs de telefone', () => {
    expect(toPhoneJid('5547999998888:3@s.whatsapp.net')).toBe(JID)
    expect(toPhoneJid('1@lid')).toBeNull()
    expect(toPhoneJid(null)).toBeNull()
  })
})
