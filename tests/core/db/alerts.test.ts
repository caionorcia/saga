import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { FakeClock } from '../../../src/core/clock'
import type { NormalizedMessage } from '../../../src/core/types'

const A = '5547999998888@s.whatsapp.net'
const B = '5511988887777@s.whatsapp.net'
const G = '120363025555555555@g.us'

function msg(over: Partial<NormalizedMessage>): NormalizedMessage {
  return { id: 'm1', jid: A, fromMe: false, ts: 1_000, kind: 'text', text: 'oi', mediaKeyJson: null, durationSec: null, ...over }
}

describe('Repo: fila do dia e alertas', () => {
  let repo: Repo
  let clock: FakeClock

  beforeEach(() => {
    clock = new FakeClock(1_000_000)
    repo = new Repo(openDb(':memory:'), clock)
    repo.upsertContact({ jid: A })
    repo.upsertContact({ jid: B })
    repo.upsertContact({ jid: G, isGroup: true })
  })

  describe('waitingSince', () => {
    it('= primeira mensagem do contato depois da última do mentor; null quando o mentor falou por último', () => {
      repo.insertMessage(msg({ id: 'a1', ts: 100 }))
      repo.insertMessage(msg({ id: 'a2', ts: 200, fromMe: true }))
      repo.insertMessage(msg({ id: 'a3', ts: 300 }))
      repo.insertMessage(msg({ id: 'a4', ts: 400 }))
      repo.insertMessage(msg({ id: 'b1', jid: B, ts: 100 }))
      repo.insertMessage(msg({ id: 'b2', jid: B, ts: 150, fromMe: true }))
      const list = repo.listContacts({ includeHidden: true })
      expect(list.find((c) => c.jid === A)!.waitingSince).toBe(300)
      expect(list.find((c) => c.jid === B)!.waitingSince).toBeNull()
      expect(list.find((c) => c.jid === G)!.waitingSince).toBeNull()
    })

    it('sem nenhuma mensagem do mentor: a primeira mensagem do contato', () => {
      repo.insertMessage(msg({ id: 'a1', ts: 100 }))
      repo.insertMessage(msg({ id: 'a2', ts: 50 }))
      expect(repo.listContacts({ includeHidden: true }).find((c) => c.jid === A)!.waitingSince).toBe(50)
    })

    it('grupo: primeira mensagem de participante depois da última do mentor', () => {
      repo.insertMessage(msg({ id: 'g1', jid: G, ts: 100, fromMe: true }))
      repo.insertMessage(msg({ id: 'g2', jid: G, ts: 200, senderJid: B, isGroup: true }))
      expect(repo.listContacts({ includeHidden: true }).find((c) => c.jid === G)!.waitingSince).toBe(200)
    })
  })

  describe('alertas', () => {
    it('um alerta ativo por (jid, kind): upsert atualiza o detalhe; resolver tira da lista', () => {
      expect(repo.upsertAlert({ jid: A, kind: 'urgente', detail: 'prazo amanhã', msgId: 'a1' })).toBe(true)
      expect(repo.upsertAlert({ jid: A, kind: 'urgente', detail: 'prazo hoje', msgId: 'a2' })).toBe(true)
      expect(repo.upsertAlert({ jid: A, kind: 'urgente', detail: 'prazo hoje', msgId: 'a2' })).toBe(false)
      const list = repo.listAlerts(A)
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ jid: A, kind: 'urgente', detail: 'prazo hoje', msgId: 'a2', createdAt: 1_000_000 })
      expect(repo.dismissAlert(A, 'urgente')).toBe(true)
      expect(repo.dismissAlert(A, 'urgente')).toBe(false)
      expect(repo.listAlerts(A)).toEqual([])
      // depois de resolvido, um sinal novo cria outro alerta
      repo.upsertAlert({ jid: A, kind: 'urgente', detail: 'outro', msgId: 'a9' })
      expect(repo.listAlerts(A)).toHaveLength(1)
      expect(repo.lastAlert(A, 'urgente')!.detail).toBe('outro')
    })

    it('listAlerts sem jid: todos os ativos fora dos escondidos, mais graves primeiro', () => {
      repo.upsertAlert({ jid: A, kind: 'reuniao', detail: 'r', msgId: null })
      repo.upsertAlert({ jid: B, kind: 'urgente', detail: 'u', msgId: null })
      repo.upsertAlert({ jid: A, kind: 'desanimo', detail: 'd', msgId: null })
      expect(repo.listAlerts().map((a) => a.kind)).toEqual(['urgente', 'desanimo', 'reuniao'])
      repo.setHidden(B, true)
      expect(repo.listAlerts().map((a) => a.kind)).toEqual(['desanimo', 'reuniao'])
    })

    it('listContacts traz os tipos ativos por gravidade', () => {
      repo.upsertAlert({ jid: A, kind: 'esperando', detail: 'e', msgId: null })
      repo.upsertAlert({ jid: A, kind: 'travado', detail: 't', msgId: null })
      repo.upsertAlert({ jid: A, kind: 'urgente', detail: 'u', msgId: null })
      const c = repo.listContacts({ includeHidden: true }).find((x) => x.jid === A)!
      expect(c.alerts).toEqual(['urgente', 'travado', 'esperando'])
      expect(repo.listContacts({ includeHidden: true }).find((x) => x.jid === B)!.alerts).toEqual([])
    })

    it('dismissAlertsUpTo resolve só os tipos pedidos e só alertas de mensagens até o horário', () => {
      repo.insertMessage(msg({ id: 'a1', ts: 100 }))
      repo.insertMessage(msg({ id: 'a2', ts: 500 }))
      repo.upsertAlert({ jid: A, kind: 'urgente', detail: 'u', msgId: 'a1' })
      repo.upsertAlert({ jid: A, kind: 'travado', detail: 't', msgId: 'a2' })
      repo.upsertAlert({ jid: A, kind: 'desanimo', detail: 'd', msgId: 'a1' })
      const n = repo.dismissAlertsUpTo(A, ['urgente', 'travado', 'reuniao', 'esperando'], 300)
      expect(n).toBe(1)
      expect(repo.listAlerts(A).map((a) => a.kind).sort()).toEqual(['desanimo', 'travado'])
    })

    it('triageCounts: conversas aguardando e conversas com alerta (fora as escondidas)', () => {
      repo.insertMessage(msg({ id: 'a1', ts: 100 }))
      repo.insertMessage(msg({ id: 'b1', jid: B, ts: 100 }))
      repo.upsertAlert({ jid: A, kind: 'urgente', detail: 'u', msgId: null })
      repo.upsertAlert({ jid: A, kind: 'travado', detail: 't', msgId: null })
      expect(repo.triageCounts()).toEqual({ awaiting: 2, withAlerts: 1 })
      repo.setHidden(A, true)
      expect(repo.triageCounts()).toEqual({ awaiting: 1, withAlerts: 0 })
    })
  })

  it('alert_checks guarda até onde a IA já olhou', () => {
    expect(repo.getAlertCheck(A)).toBeNull()
    repo.setAlertCheck(A, 'a3', 300)
    expect(repo.getAlertCheck(A)).toEqual({ lastMsgId: 'a3', lastTs: 300, checkedAt: 1_000_000 })
    repo.setAlertCheck(A, 'a4', 400)
    expect(repo.getAlertCheck(A)!.lastMsgId).toBe('a4')
  })
})
