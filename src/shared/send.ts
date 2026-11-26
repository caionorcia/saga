/**
 * Envio direto das respostas (v0.4.0). Tipos e constantes compartilhados entre o núcleo, o processo principal e a
 * interface. Regras (ver o spec, "Envio de mensagens"): só com confirmação explícita a cada envio, só para quem mandou
 * mensagem nos últimos 30 dias, nada automático depois de reiniciar, nunca reenviar no escuro.
 */

/**
 * Estado de um envio:
 * - `queued`: confirmado, esperando a vez na fila (ritmo de 30 a 90 s entre envios);
 * - `typing`: mostrando "digitando…" (a mensagem ainda não saiu);
 * - `sending`: o pedido de envio foi feito ao WhatsApp e a resposta ainda não chegou;
 * - `sent`: o WhatsApp aceitou a mensagem (ou ela apareceu na conversa);
 * - `failed`: não saiu (nada foi enviado); pode tentar de novo, com nova confirmação;
 * - `unknown`: caiu no meio do envio e a mensagem não apareceu na conversa: "Não sei se foi enviada — conferir";
 * - `expired`: esperou demais (mais de 10 min) ou o app fechou antes: volta a "aguardando confirmação";
 * - `canceled`: o mentor clicou em "Cancelar envio".
 */
export type SendStatus = 'queued' | 'typing' | 'sending' | 'sent' | 'failed' | 'unknown' | 'expired' | 'canceled'

export const SEND_STATUSES: ReadonlyArray<SendStatus> = ['queued', 'typing', 'sending', 'sent', 'failed', 'unknown', 'expired', 'canceled']

/** Estados em que o envio ainda vai acontecer (ou está acontecendo). */
export const SEND_ACTIVE: ReadonlySet<SendStatus> = new Set(['queued', 'typing', 'sending'])

export const SEND_LIMITS = {
  /** maior texto que o app envia */
  textChars: 4096,
  /** o contato precisa ter mandado mensagem nesse período (responder, nunca iniciar conversa) */
  recentContactMs: 30 * 86_400_000,
  /** a confirmação (token do `prepareSend`) vale por 5 min e uma vez só */
  tokenTtlMs: 5 * 60_000,
  /** envio na fila há mais que isso volta a "aguardando confirmação" (nunca sai atrasado) */
  queuedMaxMs: 10 * 60_000,
  /** janela para achar a mensagem na conversa quando o estado ficou desconhecido */
  verifyWindowMs: 10 * 60_000
} as const

/** "Digitando…": 1,5 s + 35 ms por caractere, no máximo 8 s (mais um sorteio pequeno de até 0,5 s). */
export function typingMs(text: string, rnd = 0): number {
  return Math.min(8_000, 1_500 + 35 * [...text].length) + Math.round(Math.max(0, Math.min(1, rnd)) * 500)
}

import { DEFAULT_SEND_SCHEDULE, cloneSchedule, type SendHoursInfo, type SendSchedule } from './sendHours'

export interface SendOptions {
  /** "Envio direto" ligado (padrão). Desligado, o botão Enviar some e envios na fila expiram */
  enabled: boolean
  /** mostrar "digitando…" antes de enviar (padrão: sim) */
  typing: boolean
  /** marcar como lidas as mensagens dessa conversa ao responder (padrão: sim; só a conversa respondida) */
  markRead: boolean
  /** nos grupos, citar a mensagem que está sendo respondida (padrão: sim; nas individuais nunca cita) */
  quoteInGroups: boolean
  /** v0.4.1: dias e horários em que o envio pode sair (fora deles, só com "Forçar envio") */
  schedule: SendSchedule
}

export const DEFAULT_SEND_OPTIONS: SendOptions = { enabled: true, typing: true, markRead: true, quoteInGroups: true, schedule: cloneSchedule(DEFAULT_SEND_SCHEDULE) }

/**
 * v0.6.0: o que o envio leva. `reply` = a resposta a uma sugestão (vira resposta aprovada na memória); `avulsa` = uma
 * mensagem escrita pelo mentor fora das sugestões ("Enviar mensagem avulsa"): nunca cita, nunca entra na memória.
 */
export type SendKind = 'reply' | 'avulsa'

/** Um envio, como a interface vê (nunca o jid de quem mandou a mensagem citada). */
export interface SendView {
  id: number
  jid: string
  kind: SendKind
  /** a resposta aprovada (memória) que este envio leva; null na mensagem avulsa */
  replyId: number | null
  text: string
  status: SendStatus
  /** epoch ms: quando foi confirmado */
  queuedAt: number
  /** só em `queued`: estimativa de quando sai (epoch ms; a contagem regressiva do cartão) */
  etaAt: number | null
  /** só em `queued`: por que ainda não sai (pausado, sem conexão); null = está só esperando a vez */
  waitingFor: 'paused' | 'connection' | null
  /** epoch ms (horário do WhatsApp quando conferido na conversa) */
  sentAt: number | null
  /** motivo curto (sem conteúdo de mensagens) em `failed`/`unknown`/`expired` */
  error: string | null
}

/** O que mostrar no diálogo de confirmação. */
export interface SendPreview {
  /** confirmação de uso único para exatamente este jid + texto (vale 5 min) */
  token: string
  expiresAt: number
  jid: string
  text: string
  /** v0.6.0: resposta a uma sugestão ou mensagem avulsa (a confirmação de uma não vale para a outra) */
  kind: SendKind
  recipient: { name: string; phone: string | null; isGroup: boolean }
  /** grupo: a mensagem que vai ser citada (quem mandou e o começo do texto); a avulsa nunca cita */
  quote: { senderName: string; text: string } | null
  options: SendOptions
  /** v0.4.1: confirmação com "Forçar envio" (pode sair fora do horário de envio) */
  forced: boolean
  /** v0.4.1: agora está fora do horário de envio (só chega aqui com `forced`); null = dentro ou sem horário */
  outsideHours: SendHoursInfo | null
}

/** O que a confirmação mostra quando está fora do horário e ainda sem "Forçar envio" (sem token: nada pode sair). */
export type SendDraft = Omit<SendPreview, 'token' | 'expiresAt' | 'forced' | 'outsideHours'>

export type SendRefusal = 'outside_hours' | 'disabled' | 'empty' | 'too_long' | 'no_recent_contact' | 'unknown_chat' | 'offline' | 'in_flight' | 'followup_done'

export const SEND_REFUSAL_TEXT: Record<SendRefusal, string> = {
  disabled: 'O envio direto está desligado nas Configurações.',
  empty: 'A mensagem está vazia.',
  too_long: 'A mensagem é longa demais para enviar de uma vez.',
  no_recent_contact: 'O SagaZap só envia para quem mandou mensagem nos últimos 30 dias (responder, nunca iniciar conversa).',
  unknown_chat: 'Conversa não encontrada.',
  offline: 'O WhatsApp não está conectado. Envie quando ele voltar (a faixa de cima mostra "Conectado").',
  in_flight: 'O envio anterior desta mensagem ainda está em andamento. Espere um pouco e clique em Conferir.',
  outside_hours: 'Fora do horário de envio. Marque "Forçar envio" para enviar agora mesmo assim.',
  followup_done: 'Esta mensagem do Copiloto já foi enviada, recusada ou cancelada.'
}

/** Motivo gravado quando a conexão cai (ou é refeita) com o envio ainda na fila ou no "digitando…". */
export const CONN_LOST_REASON = 'a conexão caiu antes de enviar'
/** Motivo gravado quando "Pausar tudo" é clicado durante o "digitando…". */
export const PAUSED_REASON = 'pausado'

export type PrepareSendResult =
  | { ok: true; preview: SendPreview }
  /** fora do horário e sem "Forçar envio": a confirmação mostra o aviso e o que iria sair, mas não há token */
  | { ok: false; code: 'outside_hours'; message: string; nextAllowedAt: number | null; hours: SendHoursInfo; draft: SendDraft }
  | { ok: false; code: Exclude<SendRefusal, 'outside_hours'>; message: string }

export interface PrepareSendInput {
  jid: string
  text: string
  /** v0.4.1: "Forçar envio" marcado: a confirmação vale fora do horário de envio (fica presa ao token) */
  forced?: boolean
  /** v0.6.0: `avulsa` = mensagem escrita fora das sugestões (sem citação); padrão `reply` */
  kind?: SendKind
}

export interface SendReplyInput {
  /** o token do `prepareSend` para exatamente este jid + texto */
  token: string
  jid: string
  text: string
  /** resposta já salva com este mesmo texto (Salvar/Copiar antes): reaproveita, sem duplicar na memória */
  replyId?: number | null
  /** como no `saveReply`: a sugestão de origem, a análise e a posição (escolhe a sugestão e guarda as não escolhidas) */
  originalSuggestion?: string | null
  analysisLastMsgId?: string | null
  chosenIndex?: number
}

/** v0.6.0: limite do id do rascunho da mensagem avulsa (gerado na interface; letras, números e hífen) */
export const DRAFT_ID_RE = /^[A-Za-z0-9-]{8,64}$/

/** "Enviar" de uma mensagem avulsa (v0.6.0). */
export interface SendAvulsaInput {
  /** o token do `prepareSend({ kind: 'avulsa' })` para exatamente este jid + texto */
  token: string
  jid: string
  text: string
  /**
   * id do rascunho, gerado pela interface quando a caixa abre: o mesmo rascunho com o mesmo texto nunca vira dois
   * envios (a chave de idempotência é conversa + rascunho + impressão do texto)
   */
  draftId: string
}

export type SendReplyResult =
  | { ok: true; send: SendView }
  | { ok: false; code: SendRefusal | 'not_confirmed'; message: string }

export const NOT_CONFIRMED_TEXT = 'A confirmação expirou. Abra o envio de novo e confirme.'
