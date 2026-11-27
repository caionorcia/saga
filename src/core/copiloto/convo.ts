/**
 * Follow-up de conversa (v0.10.0, contrato v2: onboarding e sumido). A IA conduz a conversa no grupo do mentorado rumo
 * ao objetivo que o Copiloto mandou; o mentor confirma CADA mensagem (o clique em "Enviar" é a confirmação dele; `auto`
 * vale como confirmação por enquanto).
 *
 * - **Cadência.** Dia 0 = o primeiro horário permitido depois da entrega. Em cada dia da cadência em que o mentorado não
 *   respondeu desde a última mensagem do mentor, a IA escreve a próxima tentativa (uma chamada à IA por tentativa
 *   vencida; nunca duas mensagens no mesmo dia). Modo de teste: 1 dia = 2 min, só nas recebidas com ele ligado.
 * - **Resposta.** Mensagem do mentorado (ou segunda cadeira: telefone do roster) no grupo depois da última tentativa →
 *   `responded` (com `replied_at`); a IA escreve a resposta como o mentor, rumo ao objetivo (uma chamada depois de 1 min
 *   de silêncio). Pedido que só o mentor decide (dinheiro, contrato, exceção, reclamação): sem rascunho, "Precisa de
 *   você". Mensagens de outras pessoas do grupo nunca contam como resposta.
 * - **No máximo um rascunho por conversa.** "Enviar" (com o texto editado) passa pelo caminho da mensagem avulsa, com
 *   todas as travas (horário de envio, +7..25 min fora dele, ritmo, limites, nunca duas vezes, desconhecido nunca
 *   reenviado, sem citação, marcar como lida). Um envio por vez, só com a conexão estável e o limitador livre.
 * - **Fim.** A IA só sugere ("parece que a reunião foi marcada", "item X parece cumprido"); o mentor confirma. Sumido:
 *   `scheduled` · `no_reply` depois da última tentativa + 2 dias sem resposta (ou 30 dias sem marcar, se respondeu) ·
 *   `declined` · `failed`. Onboarding: `completed` com tudo confirmado · `no_reply` aos 30 dias · `declined` · `failed`.
 * - **Relatórios** (`followup_update` v2): `running` a cada mensagem que sai (tentativas, última tentativa, resumo sem
 *   telefones), `responded`, e o final; fila própria, na ordem, com espera crescente.
 * - Registro: só contagens e estados. Nunca o texto das mensagens, nomes ou números.
 */
import { randomUUID } from 'node:crypto'
import type { Clock } from '../clock'
import type { MessageRow, Repo } from '../db/repo'
import { NO_DRAFT, type ConvoPatch, type ConvoRow } from '../db/convoRepo'
import type { PendingConvo } from './followups'
import { chatKey } from './identity'
import { autoPlan } from './autoSend'
import { findSentEcho } from '../send/logic'
import { SEND_ACTIVE } from '../../shared/send'
import { isWithinSendHours, nextSendWindow, type SendSchedule } from '../../shared/sendHours'
import {
  CONVO_FINAL,
  CONVO_LIMITS,
  CONVO_REASON,
  CONVO_TEST,
  type ConvoAction,
  type ConvoActionResult,
  type ConvoDraftView,
  type ConvoGoal,
  type ConvoStatus,
  type ConvoView
} from '../../shared/copiloto'
import { needsMentorDecision, type ConvoDraft, type ConvoPromptInput, type ConvoSpeaker } from '../ai/convoPrompt'

const DAY = 24 * 60 * 60_000
/** enviado sem o eco: espera ele até 2 min para a hora do envio (como no avulso) */
const ECHO_WAIT_MS = 2 * 60_000
const CONTENT_KINDS: ReadonlySet<MessageRow['kind']> = new Set(['text', 'audio', 'other'])

/** O tamanho do "dia" da cadência desta conversa. */
export const dayMsOf = (c: Pick<ConvoRow, 'testMode'>): number => (c.testMode ? CONVO_TEST.dayMs : DAY)

/** Dia 0: o próprio momento se estiver dentro do horário de envio (ou sem horário), senão a próxima abertura. */
export function firstWindow(s: SendSchedule, t: number): number {
  if (!s.enabled || isWithinSendHours(s, t)) return t
  return nextSendWindow(s, t) ?? t
}

/**
 * Quando a vaga `slot` da cadência vence: dia 0 + `cadence_days[slot]` dias; nunca menos de 1 dia depois da última
 * mensagem que saiu por esta conversa (um rascunho confirmado tarde não encosta no próximo). null = acabaram as vagas.
 */
export function slotDueAt(c: Pick<ConvoRow, 'day0At' | 'slot' | 'lastSentAt' | 'goal' | 'testMode'>, slot = c.slot): number | null {
  const days = c.goal.cadenceDays
  if (slot >= days.length) return null
  const d = dayMsOf(c)
  const base = c.day0At + days[slot] * d
  return slot > 0 && c.lastSentAt !== null ? Math.max(base, c.lastSentAt + d) : base
}

/** O item do `followup_update` v2 (só o que o contrato pede; o resumo já vem sem telefones). */
export function convoReport(
  c: ConvoRow,
  status: string,
  extra: { finalText?: string | null; sentAt?: number | null; reason?: string | null } = {}
): Record<string, unknown> {
  const iso = (ms: number | null | undefined) => (typeof ms === 'number' ? new Date(ms).toISOString() : null)
  return {
    id: c.id,
    status,
    final_text: extra.finalText ?? null,
    sent_at: iso(extra.sentAt),
    reason: extra.reason ?? null,
    attempts: c.attempts,
    last_attempt_at: iso(c.lastAttemptAt),
    replied_at: iso(c.repliedAt),
    summary: c.summary ? [...c.summary].slice(0, CONVO_LIMITS.summaryChars).join('') : null
  }
}

/** Resumo de reserva (a IA não mandou): só contagens. */
function fallbackSummary(c: ConvoRow): string {
  const total = c.goal.cadenceDays.length
  const parts = [`${c.attempts} de ${total} tentativa(s) enviada(s)`]
  if (c.repliedAt !== null) parts.push('o mentorado respondeu')
  if (c.type === 'onboarding' && c.goal.pendingItems.length) parts.push(`${c.itemsDone.length} de ${c.goal.pendingItems.length} pendência(s) cumprida(s)`)
  return `${parts.join('; ')}.`
}

export type ConvoDispatch = { ok: true; sendId: number } | { ok: false; code: string; message: string }

export interface ConvoEngineDeps {
  repo: Repo
  clock: Clock
  rng: () => number
  /** a integração ligada, sem código recusado */
  active(): boolean
  /** "Modo de teste dos follow-ups" ligado agora (as que chegarem agora ficam aceleradas) */
  testMode(): boolean
  schedule(): SendSchedule
  /** o remetente (JID de pessoa) é mentorado ou segunda cadeira (telefone do roster) */
  isMentee(senderJid: string | null): boolean
  /** a regra dos 30 dias não vale: grupo de que o mentor participa e com mensagens dele guardadas */
  groupEligible(jid: string): { ok: true } | { ok: false; reason: string }
  /** WhatsApp conectado e estável, sem "Pausar tudo" */
  ready(): boolean
  /** algum envio na fila ou saindo */
  busy(): boolean
  limiterAt(now: number): number
  /** a IA (corrente, limitador e teto das sugestões); lança se não deu */
  draft(input: Omit<ConvoPromptInput, 'examples' | 'knowledge' | 'notes'> & { jid: string }): Promise<ConvoDraft>
  /** texto curto do erro da IA para o cartão */
  aiErrorText(e: unknown): string
  /** a confirmação e a fila da mensagem avulsa (o serviço); `forced` = "Forçar envio" do cartão */
  dispatch(c: ConvoRow & { jid: string }, draftId: string, text: string, forced: boolean): ConvoDispatch
  cancelSend(sendId: number): boolean
  diag(kind: string, detail: string): void
  /** os cartões mudaram */
  changed(): void
  /** há relatório novo: a fila do Copiloto roda */
  kick(): void
}

export class ConvoEngine {
  private running = false
  /** conversas com a IA escrevendo agora */
  private readonly drafting = new Set<string>()
  /** "Gerar mesmo assim" depois de "Precisa de você": a próxima resposta vai à IA sem a trava de palavras */
  private readonly forceAi = new Set<string>()

  constructor(private readonly deps: ConvoEngineDeps) {}

  // --- entrega (followups_pending v2) ---

  /**
   * Guarda (ou atualiza) uma conversa que o Copiloto mandou. Nova: confere o grupo e começa (dia 0 = o primeiro horário
   * permitido). Já conhecida: o objetivo novo (ex.: menos pendências) substitui o antigo. `'new' | 'updated' | null`.
   */
  deliver(p: PendingConvo, jid: string | null): 'new' | 'updated' | null {
    const { repo, clock } = this.deps
    const cur = repo.convos.get(p.id)
    if (cur) return this.updateGoal(cur, p.goal) ? 'updated' : null
    const now = clock.now()
    const day0 = firstWindow(this.deps.schedule(), now)
    const testMode = this.deps.testMode()
    if (!jid) {
      if (!repo.convos.insert(p, null, 'failed', day0, { reason: CONVO_REASON.notFound, testMode })) return null
      this.report(repo.convos.get(p.id)!, 'failed', { reason: CONVO_REASON.notFound })
      return 'new'
    }
    const el = this.deps.groupEligible(jid)
    if (!el.ok) {
      if (!repo.convos.insert(p, jid, 'failed', day0, { reason: el.reason, testMode })) return null
      this.report(repo.convos.get(p.id)!, 'failed', { reason: el.reason })
      return 'new'
    }
    if (!repo.convos.insert(p, jid, 'active', day0, { testMode })) return null
    this.deps.diag('copiloto_convo', `nova tipo=${p.type} tentativas=${p.goal.cadenceDays.length} pendencias=${p.goal.pendingItems.length}${testMode ? ' teste' : ''}`)
    return 'new'
  }

  /** O mesmo id voltou com outro objetivo: vale o novo (o que já foi confirmado e ainda existe continua confirmado). */
  private updateGoal(c: ConvoRow, goal: ConvoGoal): boolean {
    if (CONVO_FINAL.has(c.status) || JSON.stringify(c.goal) === JSON.stringify(goal)) return false
    const keep = new Set(goal.pendingItems)
    const ok = this.deps.repo.convos.patch(
      c.id,
      { goal, itemsDone: c.itemsDone.filter((x) => keep.has(x)), suggestItems: c.suggestItems.filter((x) => keep.has(x)) },
      ['active', 'responded']
    )
    if (ok) this.deps.diag('copiloto_convo', `objetivo atualizado pendencias=${goal.pendingItems.length}`)
    return ok
  }

  /** A equipe parou no Copiloto (`stopped`, `cancelled_ids`, ou relatório `cancelled`/`duplicate`): para já, sem relatório. */
  stop(id: string, why: 'cancelled' | 'duplicate'): boolean {
    const { repo } = this.deps
    const c = repo.convos.get(id)
    if (!c || CONVO_FINAL.has(c.status)) return false
    this.dropDraft(c)
    const ok = repo.convos.patch(id, { status: 'cancelled', reason: why === 'duplicate' ? 'encerrado_no_copiloto' : 'parado_pela_equipe', needsYou: null, ...NO_DRAFT }, ['active', 'responded'])
    repo.convos.dropReports(id, why)
    if (ok) {
      this.deps.diag('copiloto_convo', `parada pela equipe (${why})`)
      this.deps.changed()
    }
    return ok
  }

  /** O envio do rascunho ainda pode ser desfeito? Cancela o que só está na fila. */
  private dropDraft(c: ConvoRow): void {
    if (c.draftState === 'sending' && c.draftSendId !== null) {
      const s = this.deps.repo.sends.get(c.draftSendId)
      if (s?.status === 'queued') this.deps.cancelSend(s.id)
    }
  }

  // --- a volta (a cada 15 s, mensagem nova, envio que mudou) ---

  /** Uma volta: confere envios, respostas, prazos e finais; escreve no máximo um rascunho; põe no máximo um envio na fila. */
  async tick(): Promise<void> {
    if (!this.deps.active()) return
    // a parte sem rede roda sempre (um envio confirmado não espera a IA escrever outro rascunho)
    const job = this.advance()
    this.dispatchApproved()
    if (!job || this.running) return
    // um rascunho por vez (a IA tem limitador e teto próprios)
    this.running = true
    try {
      await this.runDraft(job.c, job.mode)
    } finally {
      this.running = false
    }
  }

  /** As mensagens do grupo: a última do mentor, a última do mentorado e as dele ainda sem resposta (últimos 30 dias). */
  private activity(c: ConvoRow & { jid: string }) {
    const msgs = this.deps.repo.listMessages(c.jid, 300)
    let lastMentor: MessageRow | null = null
    let lastMentee: MessageRow | null = null
    for (const m of msgs) {
      if (m.fromMe) lastMentor = m
      else if (CONTENT_KINDS.has(m.kind) && this.deps.isMentee(m.senderJid)) lastMentee = m
    }
    // só as dos últimos 30 dias esperam resposta (uma pergunta antiga sem resposta não vira rascunho)
    const since = Math.max(lastMentor?.ts ?? -Infinity, this.deps.repo.recentSince())
    const waiting = msgs.filter((m) => !m.fromMe && m.ts > since && CONTENT_KINDS.has(m.kind) && this.deps.isMentee(m.senderJid))
    return { msgs, lastMentor, lastMentee, waiting }
  }

  /** A parte sem rede: devolve a conversa que precisa de um rascunho agora (se precisa). */
  private advance(): { c: ConvoRow & { jid: string }; mode: 'attempt' | 'reply' } | null {
    const { repo, clock } = this.deps
    let job: { c: ConvoRow & { jid: string }; mode: 'attempt' | 'reply' } | null = null
    let changed = false
    for (const c0 of repo.convos.listActive()) {
      let c: (ConvoRow & { jid: string }) | null = c0
      if (this.reconcileSend(c)) {
        changed = true
        c = repo.convos.get(c.id) as (ConvoRow & { jid: string }) | null
        if (!c || CONVO_FINAL.has(c.status)) continue
      }
      // o envio está saindo (ou ficou desconhecido): nada muda até ele terminar
      if (c.draftState === 'sending') continue
      const now = clock.now()
      const day = dayMsOf(c)
      const a = this.activity(c)
      const p: ConvoPatch = {}
      // resposta: mensagem do mentorado depois da última tentativa (ou, antes de qualquer tentativa, depois da entrega)
      // (ou, antes da primeira tentativa, uma mensagem dele dos últimos 30 dias ainda sem resposta do mentor)
      const after = c.lastAttemptAt ?? c.receivedAt
      const pendingReply = c.status === 'active' && c.attempts === 0 ? (a.waiting[a.waiting.length - 1] ?? null) : null
      const replied = a.lastMentee && a.lastMentee.ts > after ? a.lastMentee : pendingReply
      if (replied && (c.awaitingReply || c.status === 'active')) {
        p.status = 'responded'
        p.repliedAt = replied.ts
        p.awaitingReply = false
        Object.assign(c, p)
        repo.convos.patch(c.id, p, ['active', 'responded'])
        this.report(c, 'responded')
        changed = true
      }
      // finais por tempo
      const fin = this.timeFinal(c, now, day)
      if (fin !== undefined) {
        this.finish(c, 'no_reply', fin)
        changed = true
        continue
      }
      // o mentor respondeu por conta própria: o rascunho de resposta e o "precisa de você" de antes perdem o sentido
      const mentorTs = a.lastMentor?.ts ?? -Infinity
      if (mentorTs > c.handledTs && c.handledTs > 0 && (c.needsYou || (c.draftKind === 'reply' && c.draftState === 'ready'))) {
        repo.convos.patch(c.id, { needsYou: null, ...(c.draftKind === 'reply' && c.draftState === 'ready' ? NO_DRAFT : {}) })
        changed = true
        continue
      }
      const newest = a.waiting[a.waiting.length - 1] ?? null
      if (newest && newest.ts > c.handledTs) {
        // mensagem nova do mentorado: a tentativa da cadência que esperava (mesmo confirmada, ainda não saiu) perde o
        // sentido e a vaga dela não vira tentativa; um rascunho de resposta ainda não confirmado é refeito
        if (c.draftId && c.draftKind === 'attempt' && (c.draftState === 'ready' || c.draftState === 'approved')) {
          repo.convos.patchDraft(c.id, c.draftId, ['ready', 'approved'], { ...NO_DRAFT, slot: Math.max(c.slot, (c.draftSlot ?? c.slot) + 1) })
          Object.assign(c, repo.convos.get(c.id))
          changed = true
        } else if (c.draftId && c.draftKind === 'reply' && c.draftState === 'ready') {
          repo.convos.patchDraft(c.id, c.draftId, ['ready'], NO_DRAFT)
          Object.assign(c, repo.convos.get(c.id))
          changed = true
        }
        if (c.draftState === 'approved') continue
        if (now - newest.ts < CONVO_LIMITS.replyDebounceMs) continue
        const texts = a.waiting.map((m) => (m.kind === 'text' ? m.text : m.transcriptStatus === 'done' ? m.transcript : null) ?? '')
        if (!this.forceAi.has(c.id) && needsMentorDecision(texts)) {
          repo.convos.patch(c.id, { handledTs: newest.ts, needsYou: 'A pessoa pediu algo que só você pode decidir (dinheiro, contrato ou exceção). Responda você mesmo.', aiError: null })
          this.deps.diag('copiloto_convo', 'precisa de você (palavras)')
          changed = true
          continue
        }
        // a IA está ocupada com outro rascunho: esta fica para a próxima volta (nada marcado como tratado)
        if (job || this.running) continue
        repo.convos.patch(c.id, { handledTs: newest.ts, aiError: null, needsYou: null })
        job = { c: repo.convos.get(c.id) as ConvoRow & { jid: string }, mode: 'reply' }
        changed = true
        continue
      }
      if (c.draftState === 'approved') continue
      // a pessoa está esperando resposta (já tratada): nenhuma tentativa por cima
      if (newest) {
        const due = slotDueAt(c)
        if (due !== null && due <= now && !c.draftId) {
          repo.convos.patch(c.id, { slot: c.slot + 1 })
          changed = true
        }
        continue
      }
      if (c.draftId || c.needsYou || c.aiError) continue
      const due = slotDueAt(c)
      if (due !== null && due <= now && !job && !this.running) job = { c, mode: 'attempt' }
    }
    if (changed) this.deps.changed()
    return job
  }

  /** `no_reply` por tempo, com o motivo, ou null. */
  private timeFinal(c: ConvoRow, now: number, day: number): string | null | undefined {
    const len = c.goal.cadenceDays.length
    if (c.type === 'onboarding') return now >= c.day0At + CONVO_LIMITS.maxDays * day ? null : undefined
    if (c.slot < len) return undefined
    if (c.status === 'active' || c.awaitingReply) {
      const lastSlotAt = c.day0At + c.goal.cadenceDays[len - 1] * day
      return now >= Math.max(c.lastAttemptAt ?? -Infinity, lastSlotAt) + CONVO_LIMITS.graceDays * day ? null : undefined
    }
    return now >= c.day0At + CONVO_LIMITS.maxDays * day ? CONVO_REASON.noSchedule : undefined
  }

  /** Confere o envio do rascunho: saiu (eco ou 2 min) → conta; não saiu → o rascunho volta a esperar o mentor. */
  private reconcileSend(c: ConvoRow & { jid: string }): boolean {
    if (c.draftState !== 'sending' || c.draftSendId === null || !c.draftId) return false
    const { repo, clock } = this.deps
    const s = repo.sends.get(c.draftSendId)
    if (!s) return repo.convos.patchDraft(c.id, c.draftId, ['sending'], { draftState: 'ready', draftSendId: null, draftError: 'não chegou a enviar' })
    if (s.status === 'sent') {
      const now = clock.now()
      const echo = findSentEcho(s.msgIds, (id) => repo.getMessage(id))
      const sentAt = echo?.ts ?? (now - (s.sentAt ?? now) >= ECHO_WAIT_MS ? s.sentAt : null)
      if (sentAt === null) return false
      const attempt = c.draftKind === 'attempt'
      const p: ConvoPatch = {
        ...NO_DRAFT,
        lastSentAt: sentAt,
        summary: c.draftSummary ?? c.summary,
        ...(attempt ? { attempts: c.attempts + 1, lastAttemptAt: sentAt, awaitingReply: true, slot: Math.max(c.slot, (c.draftSlot ?? c.slot) + 1) } : {})
      }
      if (!repo.convos.patchDraft(c.id, c.draftId, ['sending'], p)) return false
      const after = repo.convos.get(c.id)!
      if (!after.summary) repo.convos.patch(c.id, { summary: fallbackSummary(after) })
      this.report(repo.convos.get(c.id)!, 'running', { finalText: s.text, sentAt })
      this.deps.diag('copiloto_convo', `send #${s.id} enviado ${attempt ? `tentativa=${after.attempts}` : 'resposta'}`)
      return true
    }
    if (s.status === 'unknown' || SEND_ACTIVE.has(s.status)) return false
    return repo.convos.patchDraft(c.id, c.draftId, ['sending'], { draftState: 'ready', draftSendId: null, draftError: s.error ?? 'não chegou a enviar' })
  }

  /** Os rascunhos confirmados que já podem sair: no máximo um por volta, pelo caminho da mensagem avulsa. */
  private dispatchApproved(): void {
    const { repo, clock, rng } = this.deps
    const schedule = this.deps.schedule()
    let changed = false
    let sent = false
    for (const c of repo.convos.listActive()) {
      if (c.draftState !== 'approved' || !c.draftId || !c.draftText) continue
      const now = clock.now()
      if (!c.draftForced) {
        const plan = autoPlan(schedule, now, c.draftAt, rng)
        if (!plan.due) {
          if (plan.at !== c.draftAt) {
            repo.convos.patch(c.id, { draftAt: plan.at })
            changed = true
          }
          continue
        }
      }
      if (sent || !this.deps.ready() || this.deps.busy() || this.deps.limiterAt(now) > now) continue
      const r = this.deps.dispatch(c, c.draftId, c.draftText, c.draftForced)
      if (r.ok) {
        repo.convos.patchDraft(c.id, c.draftId, ['approved'], { draftState: 'sending', draftSendId: r.sendId, draftError: null })
        sent = true
      } else if (r.code === 'outside_hours') {
        repo.convos.patch(c.id, { draftAt: null })
      } else if (r.code === 'no_recent_contact') {
        this.finish(c, 'failed', CONVO_REASON.noHistory)
      } else if (r.code !== 'offline' && r.code !== 'in_flight' && r.code !== 'disabled') {
        repo.convos.patchDraft(c.id, c.draftId, ['approved'], { draftState: 'ready', draftError: r.message })
        this.deps.diag('copiloto_convo', `envio recusado (${r.code}): volta para a confirmação`)
      }
      changed = true
    }
    if (changed) this.deps.changed()
  }

  private async runDraft(c: ConvoRow & { jid: string }, mode: 'attempt' | 'reply'): Promise<void> {
    const { repo } = this.deps
    this.drafting.add(c.id)
    this.deps.changed()
    const a = this.activity(c)
    const since = repo.recentSince()
    const messages = a.msgs.filter((m) => m.ts >= since).slice(-CONVO_LIMITS.contextMessages)
    const speaker = (m: MessageRow): ConvoSpeaker => (m.fromMe ? 'mentor' : this.deps.isMentee(m.senderJid) ? 'mentorado' : 'outro')
    const slot = c.slot
    try {
      const out = await this.deps.draft({
        jid: c.jid,
        type: c.type,
        goal: c.goal,
        itemsDone: c.itemsDone,
        mode,
        attempt: mode === 'attempt' ? slot + 1 : null,
        attemptTotal: c.goal.cadenceDays.length,
        messages,
        speaker
      })
      this.forceAi.delete(c.id)
      const cur = repo.convos.get(c.id)
      // mudou enquanto a IA escrevia (encerrada, outro rascunho, mensagem nova): descarta
      if (!cur || CONVO_FINAL.has(cur.status) || cur.draftState === 'approved' || cur.draftState === 'sending') return
      if (mode === 'attempt' && (cur.slot !== slot || cur.draftId)) return
      if (mode === 'reply' && cur.handledTs !== c.handledTs) return
      const sugItems = out.items.filter((x) => !cur.itemsDone.includes(x))
      const suggest: ConvoPatch = {
        suggestScheduled: cur.type === 'sumido' && (out.scheduled || cur.suggestScheduled),
        suggestItems: [...new Set([...cur.suggestItems, ...sugItems])]
      }
      if (out.action === 'needs_you') {
        repo.convos.patch(c.id, { ...NO_DRAFT, ...suggest, needsYou: out.reason, summary: out.summary ?? cur.summary, aiError: null })
        this.deps.diag('copiloto_convo', 'precisa de você (IA)')
        return
      }
      repo.convos.patch(c.id, {
        ...suggest,
        draftId: randomUUID(),
        draftKind: mode,
        draftSlot: mode === 'attempt' ? slot : null,
        draftText: [...out.text].slice(0, CONVO_LIMITS.draftChars).join(''),
        draftState: 'ready',
        draftAt: null,
        draftForced: false,
        draftSendId: null,
        draftError: null,
        draftSummary: out.summary,
        needsYou: null,
        aiError: null
      })
      this.deps.diag('copiloto_convo', `rascunho pronto modo=${mode}${mode === 'attempt' ? ` tentativa=${slot + 1}` : ''}`)
    } catch (e) {
      repo.convos.patch(c.id, { aiError: this.deps.aiErrorText(e) })
      this.deps.diag('copiloto_convo', `IA falhou: ${e instanceof Error ? e.name : 'erro'}`)
    } finally {
      this.drafting.delete(c.id)
      this.deps.changed()
    }
  }

  // --- finais e relatórios ---

  private report(c: ConvoRow, status: string, extra: { finalText?: string | null; sentAt?: number | null; reason?: string | null } = {}): void {
    this.deps.repo.convos.addReport(c.id, status, convoReport(c, status, extra))
    this.deps.kick()
  }

  /** Encerra (o rascunho na fila é cancelado; um que já está saindo impede o fim). `true` se encerrou. */
  private finish(c: ConvoRow, status: Exclude<ConvoStatus, 'active' | 'responded' | 'cancelled'>, reason: string | null): boolean {
    const { repo } = this.deps
    if (c.draftState === 'sending' && c.draftSendId !== null) {
      const s = repo.sends.get(c.draftSendId)
      if (s && s.status !== 'queued') return false
      if (s) this.deps.cancelSend(s.id)
    }
    const summary = c.summary ?? c.draftSummary ?? fallbackSummary(c)
    if (!repo.convos.patch(c.id, { status, reason, needsYou: null, suggestScheduled: false, suggestItems: [], summary, ...NO_DRAFT }, ['active', 'responded'])) return false
    this.report(repo.convos.get(c.id)!, status, { reason })
    this.deps.diag('copiloto_convo', `final ${status}${reason ? ` ${reason}` : ''}`)
    this.deps.changed()
    return true
  }

  /** O Copiloto respondeu a um relatório: `cancelled`/`duplicate` param a conversa. */
  onReportResult(convoId: string, result: string): void {
    if (result === 'cancelled' || result === 'duplicate') this.stop(convoId, result)
  }

  // --- botões do cartão ---

  action(id: string, a: ConvoAction): ConvoActionResult {
    const r = this.applyAction(id, a)
    if (typeof r === 'string') return { ok: false, message: r }
    this.deps.changed()
    const v = this.view(id)
    return v ? { ok: true, convo: v } : { ok: false, message: 'Follow-up não encontrado.' }
  }

  private applyAction(id: string, a: ConvoAction): true | string {
    const { repo } = this.deps
    const c = repo.convos.get(id)
    if (!c || !c.jid) return 'Follow-up não encontrado.'
    if (CONVO_FINAL.has(c.status)) return 'Este follow-up já foi encerrado.'
    switch (a.kind) {
      case 'send': {
        if (!c.draftId || c.draftId !== a.draftId || c.draftState !== 'ready') return 'Este rascunho mudou. Confira o cartão de novo.'
        const text = a.text.trim()
        if (!text) return 'Escreva a mensagem antes de enviar.'
        if ([...text].length > CONVO_LIMITS.draftChars) return 'Mensagem longa demais.'
        // o texto editado é o que sai (e o que vai ao Copiloto como `final_text`)
        if (!repo.convos.patchDraft(id, c.draftId, ['ready'], { draftText: text, draftState: 'approved', draftAt: null, draftForced: a.forced === true, draftError: null })) {
          return 'Este rascunho mudou. Confira o cartão de novo.'
        }
        this.deps.diag('copiloto_convo', `confirmado pelo mentor${a.forced ? ' (forçar envio)' : ''}`)
        return true
      }
      case 'cancel_send': {
        if (!c.draftId) return 'Nada para cancelar.'
        if (c.draftState === 'approved') return repo.convos.patchDraft(id, c.draftId, ['approved'], { draftState: 'ready', draftAt: null, draftForced: false }) || 'Não dá mais para cancelar.'
        if (c.draftState === 'sending' && c.draftSendId !== null && this.deps.cancelSend(c.draftSendId)) {
          return repo.convos.patchDraft(id, c.draftId, ['sending'], { draftState: 'ready', draftSendId: null, draftAt: null, draftForced: false }) || 'Não dá mais para cancelar.'
        }
        return 'Não dá mais para cancelar: o envio já começou.'
      }
      case 'skip': {
        if (!c.draftId || c.draftState !== 'ready') return 'Não há rascunho para pular.'
        const slot = c.draftKind === 'attempt' && c.draftSlot !== null ? { slot: Math.max(c.slot, c.draftSlot + 1) } : {}
        repo.convos.patchDraft(id, c.draftId, ['ready'], { ...NO_DRAFT, ...slot })
        this.deps.diag('copiloto_convo', `rascunho pulado (${c.draftKind})`)
        return true
      }
      case 'decline':
        return this.finish(c, 'declined', CONVO_REASON.declined) || 'Não dá para encerrar agora: uma mensagem está saindo.'
      case 'scheduled':
        if (c.type !== 'sumido') return 'Só o follow-up de sumido termina com reunião marcada.'
        return this.finish(c, 'scheduled', null) || 'Não dá para encerrar agora: uma mensagem está saindo.'
      case 'item': {
        if (c.type !== 'onboarding' || !c.goal.pendingItems.includes(a.item)) return 'Pendência não encontrada.'
        const done = a.done ? [...new Set([...c.itemsDone, a.item])] : c.itemsDone.filter((x) => x !== a.item)
        repo.convos.patch(id, { itemsDone: done, suggestItems: c.suggestItems.filter((x) => x !== a.item) })
        const all = c.goal.pendingItems.every((x) => done.includes(x))
        if (all) this.finish({ ...c, itemsDone: done }, 'completed', null)
        return true
      }
      case 'complete': {
        if (c.type !== 'onboarding') return 'Só o onboarding é concluído.'
        if (!c.goal.pendingItems.every((x) => c.itemsDone.includes(x))) return 'Marque as pendências cumpridas antes de concluir.'
        return this.finish(c, 'completed', null) || 'Não dá para encerrar agora: uma mensagem está saindo.'
      }
      case 'dismiss_suggestion':
        repo.convos.patch(id, { suggestScheduled: false, suggestItems: [] })
        return true
      case 'dismiss_needs_you':
        repo.convos.patch(id, { needsYou: null })
        return true
      case 'retry': {
        // "Tentar de novo" (erro da IA) ou "Gerar rascunho mesmo assim" (depois de "Precisa de você")
        if (c.needsYou) this.forceAi.add(id)
        repo.convos.patch(id, { aiError: null, needsYou: null, ...(c.needsYou || c.handledTs > 0 ? { handledTs: Math.max(0, c.handledTs - 1) } : {}) })
        return true
      }
    }
  }

  // --- interface ---

  view(id: string): ConvoView | null {
    const c = this.deps.repo.convos.get(id)
    return c?.jid ? this.toView(c as ConvoRow & { jid: string }) : null
  }

  list(recentMs: number): ConvoView[] {
    return this.deps.repo.convos.listVisible(recentMs).map((c) => this.toView(c))
  }

  private toView(c: ConvoRow & { jid: string }): ConvoView {
    const now = this.deps.clock.now()
    let draft: ConvoDraftView | null = null
    if (c.draftId && c.draftText !== null && c.draftState && c.draftKind) {
      const s = c.draftSendId !== null ? this.deps.repo.sends.get(c.draftSendId) : null
      draft = {
        id: c.draftId,
        kind: c.draftKind,
        attempt: c.draftKind === 'attempt' && c.draftSlot !== null ? c.draftSlot + 1 : null,
        text: c.draftText,
        state: c.draftState === 'sending' && s?.status === 'unknown' ? 'unknown' : c.draftState,
        at: c.draftState === 'approved' ? c.draftAt : null,
        sendError: c.draftError,
        forced: c.draftForced
      }
    }
    const total = c.goal.cadenceDays.length
    const active = !CONVO_FINAL.has(c.status)
    const schedule = this.deps.schedule()
    return {
      id: c.id,
      jid: c.jid,
      type: c.type,
      author: c.author,
      createdAt: c.createdAt,
      status: c.status,
      goal: c.goal,
      itemsDone: c.itemsDone,
      attemptsSent: c.attempts,
      nextAttempt: active && c.slot < total ? c.slot + 1 : null,
      attemptTotal: total,
      nextAttemptAt: active ? slotDueAt(c) : null,
      lastAttemptAt: c.lastAttemptAt,
      repliedAt: c.repliedAt,
      draft,
      drafting: this.drafting.has(c.id),
      needsYou: c.needsYou,
      aiError: c.aiError,
      suggestScheduled: c.suggestScheduled,
      suggestItems: c.suggestItems,
      summary: c.summary,
      reason: c.reason,
      outsideHours: schedule.enabled && !isWithinSendHours(schedule, now)
    }
  }

  /** O grupo tem uma conversa de follow-up andando? (as sugestões normais não geram sozinhas nele) */
  activeIn(jid: string): boolean {
    return this.deps.repo.convos.listActive().some((c) => c.jid === jid)
  }

  /** Este envio é o rascunho de uma conversa andando? (a regra dos 30 dias pode não valer para ele) */
  isConvoSend(sendId: number): boolean {
    const c = this.deps.repo.convos.bySendId(sendId)
    return !!c && !CONVO_FINAL.has(c.status)
  }
}

/** O chat.key de um grupo (para casar o alvo do Copiloto). */
export const convoChatKey = chatKey
