/**
 * Avaliação dos alertas (v0.2.1): 👍/👎 em cada alerta da IA e "Faltou um alerta?".
 * Sem dependências: pode ser importado pelo core e pela interface.
 */
import type { AlertKind } from './triage'

export const VERDICTS = ['up', 'down', 'missed'] as const
export type Verdict = (typeof VERDICTS)[number]

/** Motivos rápidos do 👎, na ordem do diálogo. */
export const REASON_CODES = ['tipo_errado', 'brincadeira', 'resolvido', 'nao_comigo', 'exagerado', 'outro'] as const
export type ReasonCode = (typeof REASON_CODES)[number]

export const REASON_LABELS: Record<ReasonCode, string> = {
  tipo_errado: 'Não é esse tipo de alerta',
  brincadeira: 'Era brincadeira/ironia',
  resolvido: 'Já foi resolvido',
  nao_comigo: 'Não era comigo',
  exagerado: 'Exagerado — não é tão grave',
  outro: 'Outro'
}

/** "Explique com suas palavras": até este tamanho. */
export const REASON_TEXT_MAX = 1000

export const KIND_LABELS: Record<AlertKind, string> = {
  urgente: 'Urgente',
  desanimo: 'Desânimo',
  reuniao: 'Reunião',
  travado: 'Travado',
  esperando: 'Esperando'
}

export const VERDICT_LABELS: Record<Verdict, string> = { up: 'Correto', down: 'Errado', missed: 'Faltou' }

/** 👎: o motivo (obrigatório), o tipo certo (só com `tipo_errado`; null = "Nenhum") e o texto livre. */
export interface RateReason {
  code: ReasonCode
  /** com `tipo_errado`: o tipo que seria o certo, ou null ("Nenhum") */
  correctKind?: AlertKind | null
  text?: string
}

/** Contagens de um tipo de alerta nos últimos 30 dias. */
export interface AlertQualityRow {
  kind: AlertKind
  up: number
  down: number
  missed: number
  /** 👍/(👍+👎), de 0 a 1; null sem avaliações */
  correctRate: number | null
}

export interface AlertQuality {
  /** início do período (epoch ms) */
  since: number
  days: number
  kinds: AlertQualityRow[]
  /** "Para responder": quantas vezes o mentor corrigiu ou confirmou o SagaZap */
  reply: ReplyQuality
}

export interface ExportFeedbackOptions {
  /** troca o nome das conversas por "Contato 1", "Contato 2"… */
  anonymize: boolean
}

export type ExportFeedbackResult = { status: 'saved'; rows: number } | { status: 'canceled' } | { status: 'empty' }

// --- "Para responder" (v0.2.2): o mentor corrige quando o SagaZap erra se a conversa precisa de resposta ---

/** O que o mentor disse: tirou da lista, devolveu à lista (ou confirmou o "esperando"), ou 👍 no "não precisa" do SagaZap. */
export const REPLY_VERDICTS = ['reply_not_needed', 'reply_needed', 'reply_ok'] as const
export type ReplyVerdict = (typeof REPLY_VERDICTS)[number]

/** Motivos rápidos de "Não precisa responder", na ordem do diálogo. */
export const REPLY_REASON_CODES = ['agradecimento', 'respondi_grupo', 'ligacao', 'grupo_nao_comigo', 'encerrada', 'outro'] as const
export type ReplyReasonCode = (typeof REPLY_REASON_CODES)[number]

export const REPLY_REASON_LABELS: Record<ReplyReasonCode, string> = {
  agradecimento: 'Era só agradecimento / ok / emoji',
  respondi_grupo: 'Respondi no grupo dele',
  ligacao: 'Respondi por ligação/pessoalmente',
  grupo_nao_comigo: 'Mensagem de grupo que não é comigo',
  encerrada: 'Conversa encerrada',
  outro: 'Outro'
}

export const REPLY_VERDICT_LABELS: Record<ReplyVerdict, string> = {
  reply_not_needed: 'Não precisa responder',
  reply_needed: 'Precisa responder',
  reply_ok: 'Correto'
}

/** "Não precisa responder": o motivo (obrigatório) e o texto livre. */
export interface ReplyReason {
  code: ReplyReasonCode
  text?: string
}

/**
 * Quem decidiu se a conversa precisa de resposta: a regra (agradecimento/emoji), a IA, o mentor, ou a regra do grupo
 * (`group`: depois da mensagem do contato, o mentor escreveu num grupo de que o contato participa).
 */
export type ReplyDecisionSource = 'rule' | 'ai' | 'user' | 'group'

/** "Respondido no grupo": em que grupo e quando o mentor escreveu lá (a mensagem mais recente dele depois da espera). */
export interface GroupAnswer {
  /** o grupo (`@g.us`) */
  jid: string
  name: string
  /** epoch ms (horário do WhatsApp) da mensagem do mentor no grupo */
  ts: number
}

/** A decisão atual para a última mensagem do contato (some quando chega outra mensagem dele). */
export interface ReplyDecision {
  needed: boolean
  by: ReplyDecisionSource
  /** por quê, em pt-BR (até 100 caracteres); null quando o mentor decidiu */
  reason: string | null
  /** com `by === 'group'`: o grupo onde o mentor respondeu */
  group?: GroupAnswer
}

/** "Para responder" nos últimos 30 dias. */
export interface ReplyQuality {
  /** o mentor tirou da lista ("Não precisa responder") */
  removed: number
  /** o SagaZap tinha tirado e o mentor devolveu ("Precisa sim") */
  restored: number
  /** o mentor confirmou a decisão do SagaZap (👍 no "esperando" ou no "não precisa") */
  confirmed: number
  /** decisões do SagaZap que o mentor confirmou / todas as avaliadas; null sem avaliações */
  correctRate: number | null
}
