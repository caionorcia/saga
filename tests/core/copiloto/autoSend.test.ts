import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock } from '../../../src/core/clock'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { sendJobKey } from '../../../src/core/db/sendRepo'
import { WhatsAppClient } from '../../../src/core/wa/client'
import { useAtomicAuthState } from '../../../src/core/wa/authState'
import type { LlmProvider } from '../../../src/core/ai/llm'
import { SettingsStore, type Cipher } from '../../../src/core/settings'
import { SagaService } from '../../../src/core/service'
import { DEFAULT_SEND_SCHEDULE, cloneSchedule } from '../../../src/shared/sendHours'
import { autoJitter, autoPlan, nextDayAt } from '../../../src/core/copiloto/autoSend'
import { rosterHash } from '../../../src/core/copiloto/identity'


const WEBHOOK = 'https://exemplo.supabase.co/functions/v1/sagazap-webhook'
const FU = '44444444-4444-4444-8444-444444444444'
const FU_OLD = '55555555-5555-4555-8555-555555555555'
let pending: unknown[] = []
let updates: any[] = []
/** v1.2.1: o que o Copiloto devolve em `cancelled_ids`, e a falha da consulta (rede ou 5xx) */
let cancelled: string[] | undefined = undefined
let pendingFail: 'network' | 503 | null = null
let pendingCalls = 0
const fetchMock = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}'))
  if (body.action === 'followups_pending') {
    pendingCalls++
    if (pendingFail === 'network') throw new TypeError('fetch failed')
    if (pendingFail === 503) return new Response('{}', { status: 503 })
    return new Response(JSON.stringify({ version: 1, followups: pending, ...(cancelled ? { cancelled_ids: cancelled } : {}) }), { status: 200 })
  }
  if (body.action === 'roster') return new Response(JSON.stringify({ version: 1, phones: [] }), { status: 200 })
  if (body.action === 'followups_pending') return new Response(JSON.stringify({ version: 1, followups: pending }), { status: 200 })
  if (body.action === 'followup_update') {
    updates.push(...body.updates)
    return new Response(JSON.stringify({ results: body.updates.map((u: { id: string }) => ({ id: u.id, status: 'updated' })) }), { status: 200 })
  }
  return new Response(JSON.stringify({ results: [] }), { status: 200 })
})
const target = (phone: string) => ({ kind: 'individual', phone_hashes: [rosterHash(phone)] })

const NOW = 1_764_000_000_000
const DAY = 86_400_000
const JID = '5547999998888@s.whatsapp.net'
const OLD = '5511988887777@s.whatsapp.net'
const OWN = '5547900000000:3@s.whatsapp.net'
const GOOD = JSON.stringify({ resumo: 'Quer saber o preço', sugestoes: ['Oi! Custa R$ 100.', 'Claro, te explico.'] })

/** tudo o que escreve no WhatsApp: só o caminho de envio pode chamar os três primeiros */
const WRITE_METHODS = ['sendMessage', 'sendPresenceUpdate', 'readMessages', 'sendReceipt', 'sendReceipts', 'chatModify', 'updateMediaMessage', 'logout'] as const

const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(s, 'utf8').reverse(),
  decrypt: (b) => Buffer.from(b).reverse().toString('utf8')
}

class FakeSocket {
  ev = new EventEmitter()
  end = vi.fn()
  spies: Record<string, ReturnType<typeof vi.fn>> = {}
  constructor(public config: any) {
    for (const name of WRITE_METHODS) {
      this.spies[name] = vi.fn(async () => (name === 'sendMessage' ? { key: { id: 'OUT' } } : undefined))
      ;(this as any)[name] = this.spies[name]
    }
  }
  emit(event: string, data: unknown): void {
    this.ev.emit(event, data)
  }
}

function wamsg(o: { id: string; jid?: string; fromMe?: boolean; ts: number; text?: string }): any {
  return {
    key: { remoteJid: o.jid ?? JID, fromMe: o.fromMe ?? false, id: o.id },
    messageTimestamp: Math.floor(o.ts / 1000),
    pushName: o.fromMe ? undefined : 'Ana',
    message: { conversation: o.text ?? 'oi' }
  }
}


/** hora local (o fuso dos testes é o de Brasília): o NOW é segunda 24/11 às 13:00 */
const local = (day: number, h: number, m = 0, s = 0) => new Date(2025, 10, day, h, m, s).getTime()
const MIN = 60_000
const SCHED = cloneSchedule(DEFAULT_SEND_SCHEDULE)

describe('envio automático: quando sai (puro)', () => {
  it('o atraso sorteado fica entre 7 e 25 min', () => {
    expect(autoJitter(() => 0)).toBe(7 * MIN)
    expect(autoJitter(() => 1)).toBe(25 * MIN)
    expect(autoJitter(() => 0.5)).toBe(16 * MIN)
  })

  it('dentro do horário sai já; nos primeiros 7 min da abertura espera abertura + 7..25; fora, o próximo horário + 7..25', () => {
    expect(new Date(NOW).getHours()).toBe(13)
    expect(autoPlan(SCHED, NOW, null, () => 0.5)).toEqual({ due: true })
    expect(autoPlan(SCHED, local(24, 9, 0, 30), null, () => 0)).toEqual({ due: false, at: local(24, 9, 7) })
    expect(autoPlan(SCHED, local(24, 9, 6), null, () => 1)).toEqual({ due: false, at: local(24, 9, 25) })
    expect(autoPlan(SCHED, local(24, 9, 7), null, () => 1)).toEqual({ due: true })
    expect(autoPlan(SCHED, local(24, 19, 0), null, () => 0.5)).toEqual({ due: false, at: local(25, 9, 16) })
    // sexta à noite → segunda
    expect(autoPlan(SCHED, local(28, 20, 0), null, () => 0)).toEqual({ due: false, at: local(1 + 30, 9, 7) })
  })

  it('um horário já escolhido no futuro nunca é sorteado de novo; um vencido no minuto da abertura é trocado', () => {
    expect(autoPlan(SCHED, local(25, 8, 0), local(25, 9, 16), () => 0.99)).toEqual({ due: false, at: local(25, 9, 16) })
    expect(autoPlan(SCHED, local(25, 9, 16), local(25, 9, 16), () => 0.99)).toEqual({ due: true })
    // o app ficou fechado: o horário de ontem venceu, mas agora é o minuto da abertura de hoje
    expect(autoPlan(SCHED, local(25, 9, 0, 20), local(24, 9, 16), () => 0)).toEqual({ due: false, at: local(25, 9, 7) })
    // sem horário de envio: pode sempre
    expect(autoPlan({ ...SCHED, enabled: false }, local(25, 3, 0), null, () => 0)).toEqual({ due: true })
    // nenhum dia liberado: sem horário
    expect(autoPlan({ enabled: true, days: SCHED.days.map((d) => ({ ...d, on: false })) }, NOW, null, () => 0)).toEqual({ due: false, at: null })
  })

  it('limite do dia: fica para a abertura do próximo dia + 7..25', () => {
    expect(nextDayAt(SCHED, NOW, () => 0)).toBe(local(25, 9, 7))
    expect(nextDayAt(SCHED, local(28, 13, 0), () => 0)).toBe(local(31, 9, 7))
    expect(nextDayAt({ ...SCHED, enabled: false }, NOW, () => 0)).toBe(local(25, 0, 7))
  })
})

describe('follow-up com envio automático no serviço (v0.8.0, contrato v1.2)', () => {
  let tmp: string
  let clock: FakeClock
  let repo: Repo
  let settings: SettingsStore
  let sockets: FakeSocket[]
  let service: SagaService
  let diag: Array<[string, string]>
  let rngValue: number

  const last = () => sockets[sockets.length - 1]
  const client = () => (service as any).wa as WhatsAppClient
  const writes = (names: readonly string[] = WRITE_METHODS) => sockets.reduce((n, s) => n + names.reduce((m, k) => m + s.spies[k].mock.calls.length, 0), 0)
  const sentCount = () => sockets.reduce((n, s) => n + s.spies.sendMessage.mock.calls.length, 0)
  const emit = async (event: string, data: unknown) => {
    last().emit(event, data)
    await client().whenIdle()
  }
  /** deixa o tempo passar (a varredura de 15 s, a fila e o "digitando…") */
  const drain = async (ms = 30_000) => {
    for (let left = ms; left > 0; left -= 5_000) {
      const step = Math.min(5_000, left)
      clock.advance(step)
      await vi.advanceTimersByTimeAsync(step)
      await client().whenIdle()
    }
  }

  function make(): SagaService {
    const llm: LlmProvider = { name: 'groq', complete: async () => ({ text: GOOD, inputTokens: 1, outputTokens: 1 }) } as any
    return new SagaService({
      repo,
      cipher,
      fetchImpl: fetchMock as unknown as typeof fetch,
      settings,
      clock,
      rng: () => rngValue,
      paths: { authDir: join(tmp, 'auth'), backupDir: join(tmp, 'auth-backup'), mediaDir: join(tmp, 'media') },
      hasFreeSpace: async () => true,
      diag: (k, d) => diag.push([k, d]),
      waClientFactory: (deps) =>
        new WhatsAppClient({
          ...deps,
          socketFactory: (cfg) => {
            const s = new FakeSocket(cfg)
            sockets.push(s)
            return s as any
          },
          authStateFactory: async (dir, backup) => {
            const a = await useAtomicAuthState(dir, backup)
            a.state.creds.me = { id: OWN, name: 'Mentor' }
            return a
          }
        }),
      llmFactory: () => llm,
      transcriberFactory: () => ({ transcribe: async () => 'x' }) as any,
      fetchWaVersion: async () => ({ version: [2, 3000, 1_100_000_001], isLatest: true })
    })
  }

  async function startOpen(): Promise<void> {
    await service.start()
    await emit('connection.update', { connection: 'open' })
    await emit('messaging-history.set', {
      chats: [],
      contacts: [],
      messages: [
        wamsg({ id: 'a1', ts: NOW - 3_600_000, text: 'Quanto custa a mentoria?' }),
        wamsg({ id: 'o1', jid: OLD, ts: NOW - 29 * DAY, text: 'oi, faz tempo' })
      ]
    })
  }

  /** "o app fechou e abriu de novo": mesmo banco, serviço e conexão novos */
  async function restart(): Promise<void> {
    await service.stop()
    service = make()
    await startOpen()
  }

  const item = (id: string, phone: string, auto: boolean | undefined, text: string) => ({
    id,
    target: target(phone),
    text,
    author: 'Equipe',
    created_at: new Date(NOW - 3_600_000).toISOString(),
    ...(auto === undefined ? {} : { auto_send: auto })
  })

  /** liga a integração (e o automático, se pedido) e deixa a busca trazer os follow-ups */
  async function withFollowups(items: unknown[], opts: { auto?: boolean } = {}): Promise<void> {
    pending = items
    updates = []
    service.copiloto.save({ url: WEBHOOK })
    service.copiloto.generateCode()
    service.copiloto.save({ enabled: true })
    if (opts.auto !== false) await service.copilotoSave({ autoFollowups: true })
    for (let i = 0; i < 4; i++) await service.copiloto.tick().then((n) => clock.advance(n ?? 2_000))
  }
  const report = async () => {
    for (let i = 0; i < 4; i++) await service.copiloto.tick().then((n) => clock.advance(n ?? 2_000))
  }
  const view = async (id: string) => (await service.listFollowups()).find((f) => f.id === id)

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    tmp = mkdtempSync(join(tmpdir(), 'saga-auto-'))
    clock = new FakeClock(NOW)
    repo = new Repo(openDb(':memory:'), clock)
    settings = new SettingsStore(repo, cipher)
    settings.save({ groqKey: 'gsk_x' })
    sockets = []
    diag = []
    rngValue = 0
    cancelled = undefined
    pendingFail = null
    pendingCalls = 0
    service = make()
  })

  afterEach(async () => {
    await service.stop()
    for (const s of sockets) for (const k of WRITE_METHODS.slice(3)) expect(s.spies[k], k).not.toHaveBeenCalled()
    // registro de diagnóstico: nunca o texto nem o número
    for (const [k, d] of diag) if (k.startsWith('send_') || k.startsWith('copiloto')) expect(d).not.toMatch(/5547999998888|5511988887777|semana|Faz tempo/i)
    vi.useRealTimers()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('auto_send ausente = false; o padrão da opção é desligado', async () => {
    await startOpen()
    expect(service.copiloto.status().autoFollowups).toBe(false)
    await withFollowups([item(FU, '5547999998888', undefined, 'Oi! Como foi a semana?')])
    expect(repo.followups.get(FU)!.autoSend).toBe(false)
  })

  it('ligada + auto_send: envia sem tela, pelo caminho da avulsa (digitando, lida, sem citação, id do follow-up), uma vez, e relata "sent"', async () => {
    await startOpen()
    const text = 'Oi! Como foi a semana?'
    await withFollowups([item(FU, '5547999998888', true, text)])
    // conexão aberta há menos de 1 min: ainda não (estável primeiro)
    expect(sentCount()).toBe(0)
    await drain(90_000)
    expect(sentCount()).toBe(1)
    const [row] = repo.sends.listForJid(JID)
    expect(row).toMatchObject({ kind: 'avulsa', auto: true, forced: false, quotedId: null, replyId: null, status: 'sent' })
    expect(row.idemKey.startsWith(`avulsa:${JID}:${FU}:`)).toBe(true)
    expect(last().spies.sendMessage).toHaveBeenCalledWith(JID, { text }, { messageId: row.msgIds[0] })
    expect(last().spies.sendPresenceUpdate).toHaveBeenCalledWith('composing', JID)
    expect(last().spies.readMessages).toHaveBeenCalledWith([expect.objectContaining({ id: 'a1', remoteJid: JID })])
    expect((await view(FU))?.auto).toMatchObject({ state: 'sending' })
    await emit('messages.upsert', { messages: [wamsg({ id: row.msgIds[0], fromMe: true, ts: clock.now(), text })] })
    await vi.advanceTimersByTimeAsync(1_000)
    await report()
    expect(repo.followups.get(FU)).toMatchObject({ status: 'sent', finalText: text, reported: true })
    expect(updates).toContainEqual(expect.objectContaining({ id: FU, status: 'sent', final_text: text, reason: null }))
    expect((await view(FU))?.auto).toMatchObject({ state: 'sent' })
    // idempotência: o Copiloto manda de novo o mesmo id; o mentor tenta pela interface: nunca um segundo envio
    service.copiloto.save({ enabled: true })
    await report()
    const prep = await service.prepareSend({ jid: JID, text, kind: 'avulsa' })
    if (!prep.ok) throw new Error(prep.code)
    expect(await service.sendAvulsa({ token: prep.preview.token, jid: JID, text, draftId: FU })).toMatchObject({ ok: false, code: 'followup_done' })
    await drain(120_000)
    expect(sentCount()).toBe(1)
    expect(repo.listApproved({ limit: 100 })).toHaveLength(0)
    // v1.2.1: cancelado lá depois de enviado: continua enviado aqui
    cancelled = [FU]
    ;(service.copiloto as any).followupPollAt = 0
    await report()
    expect(repo.followups.get(FU)!.status).toBe('sent')
  })

  it('auto_send=false ou a opção desligada: o cartão de sempre (nada sai sozinho)', async () => {
    await startOpen()
    await withFollowups([item(FU, '5547999998888', false, 'Oi! Como foi a semana?'), item(FU_OLD, '5511988887777', true, 'Faz tempo! Tudo bem?')], { auto: false })
    await drain(120_000)
    expect(writes()).toBe(0)
    expect((await view(FU))?.auto).toBeNull()
    expect((await view(FU_OLD))?.auto).toBeNull()
    await service.copilotoSave({ autoFollowups: true })
    await drain(3 * MIN)
    // o marcado false continua esperando o mentor
    expect((await view(FU))).toMatchObject({ status: 'waiting', auto: null })
    // o marcado true, mas que já estava aqui como cartão antes de ligar a opção, também continua cartão
    expect((await view(FU_OLD))).toMatchObject({ status: 'waiting', auto: null })
    expect(writes()).toBe(0)
    expect(repo.sends.listForJid(JID)).toHaveLength(0)
  })

  it('regra dos 30 dias barra o automático: "failed" fora_30_dias ao Copiloto, nada escrito', async () => {
    await startOpen()
    clock.advance(2 * DAY - 3 * 3_600_000) // quarta 10:00
    await withFollowups([item(FU_OLD, '5511988887777', true, 'Faz tempo! Tudo bem?')])
    await drain(90_000)
    expect(repo.followups.get(FU_OLD)).toMatchObject({ status: 'failed', reason: 'fora_30_dias' })
    await report()
    expect(updates).toContainEqual({ id: FU_OLD, status: 'failed', final_text: null, sent_at: null, reason: 'fora_30_dias' })
    expect(writes()).toBe(0)
  })

  it('fora do horário: agenda para a abertura + 7..25 min (gravado), não re-sorteia ao reiniciar e nunca sai na abertura', async () => {
    clock.advance(6 * 3_600_000) // segunda 19:00
    rngValue = 0.5
    await startOpen()
    await withFollowups([item(FU, '5547999998888', true, 'Oi! Como foi a semana?')])
    await drain(90_000)
    expect(repo.followups.get(FU)!.autoAt).toBe(local(25, 9, 16))
    expect((await view(FU))?.auto).toMatchObject({ state: 'scheduled', at: local(25, 9, 16) })
    // o app fecha e abre de novo com outro sorteio: o horário escolhido fica
    rngValue = 0.99
    await restart()
    await drain(60_000)
    expect(repo.followups.get(FU)!.autoAt).toBe(local(25, 9, 16))
    // abre o horário: nada na abertura nem antes do horário escolhido
    clock.advance(local(25, 8, 59) - clock.now())
    await drain(10 * MIN)
    expect(clock.now()).toBeGreaterThanOrEqual(local(25, 9, 9))
    expect(sentCount()).toBe(0)
    await drain(8 * MIN)
    expect(sentCount()).toBe(1)
    const sentAt = repo.sends.listForJid(JID)[0].startedAt!
    expect(sentAt).toBeGreaterThanOrEqual(local(25, 9, 16))
  })

  it('app fechado na hora marcada e aberto no minuto da abertura do dia seguinte: espera abertura + 7..25', async () => {
    await startOpen()
    await withFollowups([item(FU, '5547999998888', true, 'Oi! Como foi a semana?')])
    // o app fecha antes da conexão ficar estável; a hora marcada (ontem 09:16) passa com ele fechado
    await service.stop()
    repo.followups.setAutoAt(FU, local(24, 9, 16))
    clock.advance(local(25, 8, 59, 50) - clock.now())
    service = make()
    await startOpen()
    await drain(3 * MIN)
    expect(sentCount()).toBe(0)
    expect(repo.followups.get(FU)!.autoAt).toBe(local(25, 9, 7))
    await drain(6 * MIN)
    expect(sentCount()).toBe(1)
    expect(repo.sends.listForJid(JID)[0].startedAt!).toBeGreaterThanOrEqual(local(25, 9, 7))
  })

  it('limite de 30 automáticos por dia (contado no banco): o excedente fica para o dia seguinte', async () => {
    await startOpen()
    // 30 automáticos já saíram hoje (de outras conversas)
    for (let i = 0; i < 30; i++) {
      const { send } = repo.sends.enqueue({ idemKey: `avulsa:x${i}@s.whatsapp.net:d${i}aaaaaaaa:h`, kind: 'avulsa', replyId: null, jid: `x${i}@s.whatsapp.net`, text: 'x', address: `x${i}@s.whatsapp.net`, quotedId: null, auto: true })
      repo.sends.transition(send.id, 1, ['queued'], 'sent', { sentAt: NOW })
    }
    await withFollowups([item(FU, '5547999998888', true, 'Oi! Como foi a semana?')])
    await drain(90_000)
    expect(sentCount()).toBe(0)
    expect(repo.followups.get(FU)!.autoAt).toBe(local(25, 9, 7))
    clock.advance(local(25, 9, 6) - clock.now())
    await drain(60_000)
    expect(sentCount()).toBe(0)
    await drain(90_000)
    expect(sentCount()).toBe(1)
  })

  it('teto por hora do WhatsApp cheio: o automático espera sem pôr na fila (nunca expira lá)', async () => {
    await startOpen()
    for (let i = 0; i < 40; i++) service.limiters.wa_send.record()
    await withFollowups([item(FU, '5547999998888', true, 'Oi! Como foi a semana?')])
    await drain(5 * MIN)
    expect(repo.sends.listForJid(JID)).toHaveLength(0)
    expect(sentCount()).toBe(0)
    await drain(60 * MIN)
    expect(sentCount()).toBe(1)
  })

  it('opção desligada logo antes de enviar (no "digitando…"): não sai; integração desligada na fila: não sai', async () => {
    await startOpen()
    await withFollowups([item(FU, '5547999998888', true, 'Oi! Como foi a semana?')])
    let flipped = false
    last().spies.sendPresenceUpdate.mockImplementation(async (kind: string) => {
      if (kind === 'composing' && !flipped) {
        flipped = true
        // muda direto no banco: só a conferência logo antes de enviar pode pegar
        repo.setSetting('copiloto.autoFollowups', '0')
      }
    })
    await drain(90_000)
    expect(flipped).toBe(true)
    expect(sentCount()).toBe(0)
    expect(repo.sends.listForJid(JID)[0]).toMatchObject({ status: 'expired', error: 'envio automático desligado' })
    expect((await view(FU))).toMatchObject({ status: 'waiting', auto: null })
    // ligada de novo: sai (nova tentativa, as mesmas regras)
    repo.setSetting('copiloto.autoFollowups', '1')
    await drain(3 * MIN)
    expect(sentCount()).toBe(1)
  })

  it('integração desligada com o automático na fila: expira e nada sai', async () => {
    await startOpen()
    await withFollowups([item(FU, '5547999998888', true, 'Oi! Como foi a semana?')])
    last().spies.sendPresenceUpdate.mockImplementation(async (kind: string) => {
      if (kind === 'composing') repo.setSetting('copiloto.enabled', '0')
    })
    await drain(90_000)
    expect(sentCount()).toBe(0)
    expect(repo.sends.listForJid(JID)[0]).toMatchObject({ status: 'expired', error: 'envio automático desligado' })
  })

  it('estado desconhecido: nunca reenvia sozinho, nem depois de reiniciar/reconectar; volta ao cartão (Conferir)', async () => {
    await startOpen()
    await withFollowups([item(FU, '5547999998888', true, 'Oi! Como foi a semana?')])
    last().spies.sendMessage.mockImplementation(async () => {
      throw Object.assign(new Error('Connection Closed'), { name: 'Boom', output: { statusCode: 428 } })
    })
    await drain(90_000)
    expect(sentCount()).toBe(1)
    expect(repo.sends.listForJid(JID)[0].status).toBe('unknown')
    await drain(30_000)
    expect(repo.followups.get(FU)).toMatchObject({ status: 'sending', autoOff: true })
    expect((await view(FU))?.auto).toBeNull()
    await restart()
    await drain(10 * MIN)
    expect(sentCount()).toBe(1)
    expect(repo.followups.get(FU)!.status).toBe('sending')
  })

  it('"Não enviar" num agendado: vai como recusado_pelo_mentor e nada sai', async () => {
    clock.advance(6 * 3_600_000)
    await startOpen()
    await withFollowups([item(FU, '5547999998888', true, 'Oi! Como foi a semana?')])
    await drain(30_000)
    expect((await view(FU))?.auto).toMatchObject({ state: 'scheduled', canCancel: true })
    expect(await service.followupDecline(FU, null)).toBe(true)
    await report()
    expect(updates).toContainEqual({ id: FU, status: 'declined', final_text: null, sent_at: null, reason: 'recusado_pelo_mentor' })
    clock.advance(local(25, 10, 0) - clock.now())
    await drain(5 * MIN)
    expect(writes()).toBe(0)
  })

  it('sem conexão: espera; reconectou, só sai depois de estável', async () => {
    await startOpen()
    await emit('connection.update', { connection: 'close', lastDisconnect: { error: Object.assign(new Error('x'), { output: { statusCode: 408 } }) } })
    await withFollowups([item(FU, '5547999998888', true, 'Oi! Como foi a semana?')])
    await drain(2 * MIN)
    expect(repo.sends.listForJid(JID)).toHaveLength(0)
    expect((await view(FU))?.auto).toMatchObject({ state: 'scheduled', wait: 'connection' })
    // reconectou (socket novo): só depois de 1 min de pé
    expect(sockets.length).toBeGreaterThan(1)
    await emit('connection.update', { connection: 'open' })
    await drain(30_000)
    expect(sentCount()).toBe(0)
    await drain(90_000)
    expect(sentCount()).toBe(1)
  })

  it('desligar a opção nas Configurações com o automático na fila: expira na hora', async () => {
    await startOpen()
    await withFollowups([item(FU, '5547999998888', true, 'Oi! Como foi a semana?')])
    clock.advance(61_000)
    await (service as any).autoFollowups.tick()
    expect(repo.sends.listForJid(JID)[0]?.status).toBe('queued')
    await service.copilotoSave({ autoFollowups: false })
    expect(repo.sends.listForJid(JID)[0]).toMatchObject({ status: 'expired', error: 'envio automático desligado' })
    await drain(2 * MIN)
    expect(sentCount()).toBe(0)
    expect((await view(FU))).toMatchObject({ status: 'waiting', auto: null })
  })

  describe('v1.2.1: cancelados informados', () => {
    it('a cada consulta, os cancelados saem daqui (cartão e automático agendado), sem relatório', async () => {
      clock.advance(6 * 3_600_000) // fora do horário: o automático fica agendado
      await startOpen()
      await withFollowups([item(FU, '5547999998888', true, 'Oi! Como foi a semana?'), item(FU_OLD, '5511988887777', false, 'Faz tempo! Tudo bem?')])
      await drain(30_000)
      expect((await view(FU))?.auto).toMatchObject({ state: 'scheduled' })
      expect(await view(FU_OLD)).toMatchObject({ status: 'waiting', auto: null })
      cancelled = [FU, FU_OLD, 'nao-existe-aqui-123']
      service.copiloto.save({ enabled: true })
      ;(service.copiloto as any).followupPollAt = 0
      await report()
      expect(repo.followups.get(FU)!.status).toBe('cancelled')
      expect(repo.followups.get(FU_OLD)!.status).toBe('cancelled')
      expect(await service.listFollowups()).toEqual([])
      await report()
      expect(updates).toEqual([])
      clock.advance(local(25, 10, 0) - clock.now())
      await drain(5 * MIN)
      expect(writes()).toBe(0)
    })

    it('logo antes do envio automático: consulta nova; cancelado lá → não sai e não relata nada', async () => {
      await startOpen()
      await withFollowups([item(FU, '5547999998888', true, 'Oi! Como foi a semana?')])
      const before = pendingCalls
      // cancelado no Copiloto depois da última busca (a próxima busca normal só sairia em 5 min)
      cancelled = [FU]
      await drain(90_000)
      expect(pendingCalls).toBeGreaterThan(before)
      expect(sentCount()).toBe(0)
      expect(writes(['sendPresenceUpdate'])).toBe(0)
      // a consulta é antes de pôr na fila: nenhum envio criado, nenhuma vaga do limitador gasta
      expect(repo.sends.listForJid(JID)).toHaveLength(0)
      expect(service.limiters.wa_send.nextAllowedAt(clock.now())).toBeLessThanOrEqual(clock.now())
      expect(repo.followups.get(FU)!.status).toBe('cancelled')
      await report()
      expect(updates).toEqual([])
      await drain(10 * MIN)
      expect(sentCount()).toBe(0)
    })

    for (const fail of ['network', 503] as const) {
      it(`consulta antes de pôr na fila falhou (${fail}): nada na fila nem no limitador; todos esperam 5 → 10 → 20 → 30 min`, async () => {
        await startOpen()
        await withFollowups([item(FU, '5547999998888', true, 'Oi! Como foi a semana?'), item(FU_OLD, '5511988887777', true, 'Faz tempo! Tudo bem?')])
        pendingFail = fail
        await drain(90_000)
        expect(sentCount()).toBe(0)
        expect(writes(['sendPresenceUpdate'])).toBe(0)
        expect(repo.sends.listForJid(JID)).toHaveLength(0)
        expect(repo.sends.listForJid(OLD)).toHaveLength(0)
        expect(service.limiters.wa_send.nextAllowedAt(clock.now())).toBeLessThanOrEqual(clock.now())
        expect(repo.followups.get(FU)).toMatchObject({ status: 'waiting', autoAttempts: 0, autoOff: false })
        expect((await view(FU))?.auto).toMatchObject({ wait: 'copiloto' })
        expect((await view(FU_OLD))?.auto).toMatchObject({ wait: 'copiloto' })
        // cada falha: uma consulta só, e a espera de todos cresce (5 → 10 → 20 → 30 → 30 min)
        const backoffs = () => diag.filter(([k, d]) => k === 'copiloto_auto' && d.startsWith('Copiloto sem resposta')).map(([, d]) => Number(/(\d+) min/.exec(d)![1]))
        expect(backoffs()).toEqual([5])
        for (let i = 0; i < 4; i++) {
          const until = Number(repo.getSetting('copiloto.autoPollUntil'))
          await drain(until - clock.now() - 20_000)
          expect(backoffs()).toHaveLength(i + 1)
          await drain(40_000)
        }
        expect(backoffs()).toEqual([5, 10, 20, 30, 30])
        expect(repo.getSetting('copiloto.autoPollFailures')).toBe('5')
        expect(sentCount()).toBe(0)
        // o Copiloto voltou: cada um sai uma vez (com o intervalo normal), e a espera volta ao começo
        pendingFail = null
        await drain(32 * MIN)
        expect(sentCount()).toBe(2)
        expect(repo.sends.listForJid(JID)).toHaveLength(1)
        expect(repo.sends.listForJid(OLD)).toHaveLength(1)
        expect(repo.getSetting('copiloto.autoPollFailures')).toBe('0')
      })
    }

    it('código recusado (401): o automático para (nada de consultas em laço nem envios)', async () => {
      await startOpen()
      await withFollowups([item(FU, '5547999998888', true, 'Oi! Como foi a semana?')])
      repo.setSetting('copiloto.authFailed', '1')
      const calls = pendingCalls
      await drain(30 * MIN)
      expect(pendingCalls).toBe(calls)
      expect(sentCount()).toBe(0)
      expect((await view(FU))?.auto).toBeNull()
    })
  })
})
