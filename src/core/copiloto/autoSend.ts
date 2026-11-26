/**
 * Follow-up com envio automático (v0.8.0, contrato v1.2). Com a opção "Enviar follow-ups do Copiloto automaticamente"
 * ligada, um follow-up marcado `auto_send: true` sai sem a tela de confirmação, mas pelo MESMO caminho da mensagem
 * avulsa: a confirmação (token preso a jid + texto + destino + tipo, nunca "Forçar envio") é feita aqui dentro, e daí em
 * diante é a fila `send_message` e o `executeSend` de sempre (ritmo de 30–90 s, tetos por hora/dia, horário de envio,
 * regra dos 30 dias, "digitando…", marcar como lida, nunca cita, conferência pelo id no estado desconhecido).
 *
 * O que este módulo acrescenta:
 * - **Quando sai.** Dentro do horário, já (nunca nos primeiros 7 min da abertura). Fora dele, no próximo horário
 *   permitido + um atraso sorteado de 7 a 25 min, gravado no banco (reiniciar não sorteia de novo nem envia na abertura;
 *   o app fechado nessa hora envia depois de abrir, com as mesmas regras). Vários itens seguem o intervalo normal: só
 *   um envio automático por vez, e só quando nenhum outro envio está na fila.
 * - **Limite próprio:** 30 envios automáticos por dia (dia do computador, contado no banco); o excedente fica para o
 *   próximo dia, com o mesmo atraso sorteado.
 * - **Só com o WhatsApp conectado e estável** (de pé há 1 min, sem "Pausar tudo"); senão, espera.
 * - **Nunca reenvia no escuro:** um envio automático que ficou de estado desconhecido encerra o automático daquele
 *   item (volta ao cartão da v1.1, com "Conferir"); um que não chegou a sair (expirou, falhou antes do envio) tenta de
 *   novo no máximo 3 vezes, sempre com as mesmas regras.
 */
import type { Clock } from '../clock'
import type { Repo } from '../db/repo'
import type { FollowupRow } from '../db/followupRepo'
import type { SendRow } from '../db/sendRepo'
import { FOLLOWUP_AUTO, type FollowupAuto, type FollowupAutoWait } from '../../shared/copiloto'
import { isWithinSendHours, nextSendWindow, parseHHMM, type SendSchedule } from '../../shared/sendHours'

/** Atraso sorteado depois da abertura do horário: de 7 a 25 min. */
export function autoJitter(rng: () => number): number {
  const r = Math.max(0, Math.min(1, rng()))
  return FOLLOWUP_AUTO.jitterMinMs + Math.round(r * (FOLLOWUP_AUTO.jitterMaxMs - FOLLOWUP_AUTO.jitterMinMs))
}

/** Meia-noite (local) do dia de `now`. */
export function localDayStart(now: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** O começo do horário em que `now` está (hora local do dia), ou null se fora do horário (ou sem horário). */
export function currentWindowStart(s: SendSchedule, now: number): number | null {
  if (!s.enabled || !isWithinSendHours(s, now)) return null
  const d = new Date(now)
  const start = parseHHMM(s.days[d.getDay()]?.start)
  if (start === null) return null
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(start / 60), start % 60).getTime()
}

/**
 * O plano de um item: `due` = pode sair agora (as outras travas ainda valem); senão `at` = o horário escolhido (null =
 * nenhum dia liberado). Um horário já escolhido e ainda no futuro nunca é sorteado de novo.
 */
export function autoPlan(s: SendSchedule, now: number, storedAt: number | null, rng: () => number): { due: true } | { due: false; at: number | null } {
  if (storedAt !== null && storedAt > now) return { due: false, at: storedAt }
  if (!s.enabled) return { due: true }
  const open = currentWindowStart(s, now)
  if (open !== null) {
    // nunca no minuto da abertura: nos primeiros 7 min, espera a abertura + 7..25 min
    if (now < open + FOLLOWUP_AUTO.jitterMinMs) return { due: false, at: open + autoJitter(rng) }
    return { due: true }
  }
  const next = nextSendWindow(s, now)
  return { due: false, at: next === null ? null : next + autoJitter(rng) }
}

/** O limite do dia acabou: o próximo dia, na abertura do horário + 7..25 min. */
export function nextDayAt(s: SendSchedule, now: number, rng: () => number): number | null {
  const d = new Date(now)
  const tomorrow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  if (!s.enabled || isWithinSendHours(s, tomorrow)) return tomorrow + autoJitter(rng)
  const next = nextSendWindow(s, tomorrow)
  return next === null ? null : next + autoJitter(rng)
}

export type AutoDispatchResult = { ok: true; sendId: number } | { ok: false; code: string }

export interface AutoSendDeps {
  repo: Repo
  clock: Clock
  rng: () => number
  /** a opção ligada, a integração ligada e o envio direto ligado */
  active(): boolean
  schedule(): SendSchedule
  /** WhatsApp conectado e estável, sem "Pausar tudo" nem parada guardada */
  ready(): boolean
  /** algum envio na fila ou saindo (o automático nunca se sobrepõe a outro) */
  busy(): boolean
  /** quando o limitador do WhatsApp libera o próximo envio (epoch ms) */
  limiterAt(now: number): number
  /** a confirmação interna e a fila da mensagem avulsa (o serviço) */
  dispatch(f: FollowupRow & { jid: string }): AutoDispatchResult
  diag(kind: string, detail: string): void
  changed(): void
}

/** Recusas em que o automático espera (tenta de novo na próxima volta, com as mesmas regras). */
const WAIT_CODES: ReadonlySet<string> = new Set(['offline', 'disabled', 'in_flight', 'outside_hours'])

export class FollowupAutoSender {
  constructor(private readonly deps: AutoSendDeps) {}

  /** O envio (mais recente) que leva este follow-up. */
  private sendOf(f: FollowupRow): SendRow | null {
    const { repo } = this.deps
    if (f.sendId !== null) return repo.sends.get(f.sendId)
    if (!f.jid) return null
    const ids = repo.followups.sendIdsOf(f.id, f.jid)
    return ids.length ? repo.sends.get(ids[0]) : null
  }

  /** Uma volta: encerra o automático dos que ficaram desconhecidos, escolhe horários e põe no máximo um na fila. */
  tick(): void {
    const { repo, clock, rng } = this.deps
    if (!this.deps.active()) return
    const now = clock.now()
    let changed = false
    // nunca reenviar no escuro: desconhecido = acabou o automático deste item (o mentor confere no cartão)
    for (const f of repo.followups.listByStatus('sending')) {
      if (!f.autoSend || f.autoOff) continue
      const s = this.sendOf(f)
      if (s && (s.status === 'unknown' || !s.auto) && repo.followups.setAutoOff(f.id)) {
        this.deps.diag('copiloto_auto', `send #${s.id} ${s.status === 'unknown' ? 'estado desconhecido: sem novo envio automático' : 'enviado pela confirmação'}`)
        changed = true
      }
    }
    const items = repo.followups.listAutoWaiting()
    if (items.length > 0) {
      const schedule = this.deps.schedule()
      let today = repo.sends.autoCountSince(localDayStart(now))
      let dispatched = false
      for (const f of items) {
        if (f.autoAttempts >= FOLLOWUP_AUTO.maxAttempts) {
          if (repo.followups.setAutoOff(f.id)) {
            this.deps.diag('copiloto_auto', `tentativas=${f.autoAttempts}: volta para a confirmação`)
            changed = true
          }
          continue
        }
        const plan = autoPlan(schedule, now, f.autoAt, rng)
        if (!plan.due) {
          if (plan.at !== f.autoAt) {
            repo.followups.setAutoAt(f.id, plan.at)
            changed = true
          }
          continue
        }
        if (today >= FOLLOWUP_AUTO.perDay) {
          // o limite do dia acabou: o excedente fica para o próximo dia
          repo.followups.setAutoAt(f.id, nextDayAt(schedule, now, rng))
          this.deps.diag('copiloto_auto', `limite de ${FOLLOWUP_AUTO.perDay} por dia: fica para amanhã`)
          changed = true
          continue
        }
        // um por vez; só com a conexão estável, nada na fila e o limitador livre (senão expiraria na fila)
        if (dispatched || !this.deps.ready() || this.deps.busy() || this.deps.limiterAt(now) > now + FOLLOWUP_AUTO.limiterSlackMs) continue
        dispatched = true
        const r = this.deps.dispatch(f)
        changed = true
        if (r.ok) {
          repo.followups.addAutoAttempt(f.id)
          today++
          continue
        }
        if (r.code === 'outside_hours') repo.followups.setAutoAt(f.id, null)
        else if (!WAIT_CODES.has(r.code) && repo.followups.get(f.id)?.status === 'waiting' && repo.followups.setAutoOff(f.id)) {
          this.deps.diag('copiloto_auto', `recusado (${r.code}): volta para a confirmação`)
        }
      }
    }
    if (changed) this.deps.changed()
  }

  /** O envio automático de um follow-up para a interface; null = cartão da v1.1. */
  view(f: FollowupRow): FollowupAuto | null {
    if (!f.autoSend || f.autoOff || !this.deps.active()) return null
    const now = this.deps.clock.now()
    if (f.status === 'waiting') {
      const due = f.autoAt === null || f.autoAt <= now
      let wait: FollowupAutoWait = null
      if (f.autoAt === null && this.deps.schedule().enabled && !isWithinSendHours(this.deps.schedule(), now) && nextSendWindow(this.deps.schedule(), now) === null) wait = 'no_hours'
      else if (due && !this.deps.ready()) wait = 'connection'
      else if (due && this.deps.busy()) wait = 'busy'
      else if (due && this.deps.repo.sends.autoCountSince(localDayStart(now)) >= FOLLOWUP_AUTO.perDay) wait = 'daily_cap'
      return { state: 'scheduled', at: f.autoAt, wait, canCancel: true }
    }
    const s = this.sendOf(f)
    if (!s?.auto) return null
    if (f.status === 'sending') return s.status === 'unknown' ? null : { state: 'sending', at: null, wait: null, canCancel: s.status === 'queued' }
    if (f.status === 'sent') return { state: 'sent', at: f.sentAt, wait: null, canCancel: false }
    return null
  }
}
