/**
 * Adendo v1.4 (contrato do Copiloto): conferência dos grupos da mentoria. O mentor escolhe, em Configurações › Copiloto
 * da Saga, qual grupo (ou comunidade) do WhatsApp é cada um; o SagaZap manda ao Copiloto só os hashes do roster de quem
 * participa. Sem dependências: core e interface importam.
 */

/** As quatro marcas do perfil no Copiloto: a chave do contrato e o nome na tela. */
export const MEMBERSHIP_SLOTS = [
  { key: 'comunidade_saga', label: 'Comunidade Saga' },
  { key: 'comunidade_legacy', label: 'Comunidade Legacy' },
  { key: 'grupo_avisos', label: 'Grupo de Avisos' },
  { key: 'grupo_sos_trafego', label: 'SOS Tráfego' }
] as const

export type MembershipKey = (typeof MEMBERSHIP_SLOTS)[number]['key']

export const MEMBERSHIP_KEYS: ReadonlyArray<MembershipKey> = MEMBERSHIP_SLOTS.map((s) => s.key)

export const isMembershipKey = (v: unknown): v is MembershipKey => typeof v === 'string' && (MEMBERSHIP_KEYS as readonly string[]).includes(v)

export const MEMBERSHIP_LIMITS = {
  /** hashes por grupo num pedido (acima disso, vão os primeiros 1500 e a tela avisa) */
  membersMax: 1500,
  /** "Conferir agora": no máximo uma vez a cada 10 min */
  manualEveryMs: 10 * 60_000,
  /** alguém entrou num grupo escolhido: espera 2 min sem entrada nova (no máximo 10 min desde a primeira) */
  joinDebounceMs: 2 * 60_000,
  joinMaxWaitMs: 10 * 60_000,
  /** a conferência diária: começo do horário de envio + 3 a 12 min (sorteado uma vez por dia) */
  jitterMinMs: 3 * 60_000,
  jitterMaxMs: 12 * 60_000,
  /** sem horário de envio ligado: o "começo do expediente" é 09:00 */
  defaultStartMin: 9 * 60,
  /** participantes de um grupo escolhido ainda desconhecidos: pede a consulta dele e espera até 5 min */
  metaWaitMs: 5 * 60_000
} as const

/** O que o Copiloto respondeu para um grupo na última conferência aceita (`status: "stored"`). */
export interface MembershipResult {
  /** epoch ms da conferência (`checked_at`) */
  at: number
  received: number
  matched: number
  marked: number
  /** reconhecidos que estão num grupo que não é deles (regra dos grupos oficiais, aplicada pelo Copiloto); null = não informado */
  outsideRule: number | null
  /** mais de 1500 participantes do roster: foram só os primeiros 1500 */
  capped: boolean
}

/** Um grupo ou comunidade de que a conta participa (para escolher na lista). */
export interface MembershipGroupOption {
  jid: string
  name: string
  kind: 'group' | 'community' | 'announce'
}

export interface MembershipSlotView {
  key: MembershipKey
  label: string
  /** o grupo escolhido (null = "Não conferir") */
  jid: string | null
  name: string | null
  last: MembershipResult | null
}

export interface MembershipView {
  slots: MembershipSlotView[]
  /** a última conferência que foi ao Copiloto (aceita ou não), epoch ms */
  lastAttemptAt: number | null
  /** o último problema (texto curto, sem dados de ninguém); null depois de uma conferência aceita */
  lastProblem: string | null
  /** quando o "Conferir agora" volta a valer (null = já vale) */
  manualAvailableAt: number | null
}

export type MembershipCheckResult = { ok: true; view: MembershipView } | { ok: false; message: string }

export const MEMBERSHIP_TEXT = {
  off: 'Ligue o envio para o Copiloto antes de conferir os grupos.',
  none: 'Escolha pelo menos um grupo antes de conferir.',
  wait: (min: number) => `Aguarde ${min} min para conferir de novo.`,
  invalid: 'O Copiloto recusou a última conferência (fora do contrato).',
  queued: 'Conferência pedida ✓ (sai em alguns segundos)'
} as const

const pad = (n: number) => String(n).padStart(2, '0')

/** "Última conferência DD/MM HH:MM — recebidos X, reconhecidos Y, marcados agora Z" (hora local). */
export function membershipLine(r: MembershipResult): string {
  const d = new Date(r.at)
  const line = `Última conferência ${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())} — recebidos ${r.received}, reconhecidos ${r.matched}, marcados agora ${r.marked}${r.outsideRule !== null ? `, fora da regra ${r.outsideRule}` : ''}`
  return r.capped ? `${line} (mais de ${MEMBERSHIP_LIMITS.membersMax} mentorados no grupo: só os primeiros ${MEMBERSHIP_LIMITS.membersMax} foram enviados)` : line
}
