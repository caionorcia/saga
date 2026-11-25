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
}

export interface ExportFeedbackOptions {
  /** troca o nome das conversas por "Contato 1", "Contato 2"… */
  anonymize: boolean
}

export type ExportFeedbackResult = { status: 'saved'; rows: number } | { status: 'canceled' } | { status: 'empty' }
