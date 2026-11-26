/**
 * Fila do dia e alertas (v0.2.0): constantes usadas pelo core e pela interface.
 * Sem dependências: pode ser importado dos dois lados.
 */

/** Tipos de alerta, do mais grave para o menos grave (ordem de "Com alerta"). */
export const ALERT_KINDS = ['urgente', 'desanimo', 'travado', 'reuniao', 'esperando'] as const
export type AlertKind = (typeof ALERT_KINDS)[number]
/** Tipos que a IA pode marcar; `esperando` vem de regra (sem IA). */
export const AI_ALERT_KINDS: ReadonlyArray<AlertKind> = ['urgente', 'desanimo', 'travado', 'reuniao']

/** 0 = mais grave. */
export const alertSeverity = (k: AlertKind): number => ALERT_KINDS.indexOf(k)

const HOUR = 3_600_000
/**
 * "Respondido no grupo": num grupo com até este número de participantes conhecidos (o grupo do mentorado), qualquer
 * mensagem do mentor conta como resposta; em grupos maiores (ou de tamanho desconhecido), só se mencionar (@) o contato
 * ou citar uma mensagem dele.
 */
export const GROUP_ANSWER_MAX_MEMBERS = 10

/** espera a partir da qual o selo fica âmbar */
export const WAIT_AMBER_MS = 24 * HOUR
/** espera a partir da qual o selo fica vermelho e nasce o alerta "esperando" */
export const WAIT_RED_MS = 48 * HOUR
