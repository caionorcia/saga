/**
 * Copiloto da Saga (v0.5.0): o SagaZap envia ao Copiloto o que acontece nas conversas dos mentorados cadastrados.
 * Contrato: `docs/superpowers/specs/2026-11-26-copiloto-integration.md`. Sem dependências: core e interface importam.
 */

/** Caminho obrigatório do endereço (a função do Copiloto que recebe os eventos). */
export const COPILOTO_PATH = '/functions/v1/sagazap-webhook'
export const COPILOTO_URL_MAX = 300

/** Endereço válido: https, sem usuário/senha, sem `?` nem `#`, terminando em `/functions/v1/sagazap-webhook`. */
export function isCopilotoUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > COPILOTO_URL_MAX) return false
  let u: URL
  try {
    u = new URL(v.trim())
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password || u.search || u.hash) return false
  return u.pathname.replace(/\/$/, '').endsWith(COPILOTO_PATH)
}

export const COPILOTO_TEXT = {
  invalidCode: 'Código do Copiloto inválido',
  invalidUrl: 'O endereço precisa começar com https:// e terminar em /functions/v1/sagazap-webhook.',
  needsSetup: 'Preencha o endereço e gere o código antes de ligar.',
  encryption: 'A criptografia do Windows não está disponível. O código não foi salvo.',
  network: 'Sem conexão com o Copiloto. Tente de novo.',
  server: 'O Copiloto não respondeu direito. Tente de novo mais tarde.'
} as const

/** O que a tela de configurações mostra. O código nunca volta para a interface: só se está configurado. */
export interface CopilotoStatus {
  enabled: boolean
  url: string | null
  hasCode: boolean
  /** eventos na fila esperando envio */
  pending: number
  /** epoch ms do último lote aceito pelo Copiloto */
  lastSentAt: number | null
  /** o último erro (texto curto, sem dados pessoais) e quando foi; null depois de um envio bem-sucedido */
  lastError: string | null
  lastErrorAt: number | null
  /** o Copiloto recusou o código (401): o envio está parado até gerar outro código ou testar de novo */
  authFailed: boolean
  /** telefones na lista de mentorados (cada celular vem nas duas formas, com e sem o 9) e quando ela chegou */
  rosterSize: number
  rosterAt: number | null
  /** conversas deste computador que são de mentorados (individuais e grupos) */
  chats: number
  /** v0.8.0 (contrato v1.2): "Enviar follow-ups do Copiloto automaticamente" (padrão: desligado) */
  autoFollowups: boolean
}

export interface CopilotoPatch {
  enabled?: boolean
  /** v0.8.0: "Enviar follow-ups do Copiloto automaticamente" */
  autoFollowups?: boolean
  /** `''` apaga o endereço */
  url?: string
}

export type CopilotoSaveResult = { ok: true; status: CopilotoStatus } | { ok: false; message: string }

/** "Gerar código": o código aparece só esta vez. */
export type CopilotoCodeResult = { ok: true; code: string } | { ok: false; message: string }

/** "Testar conexão": quantos telefones de mentorados o Copiloto mandou e quantas conversas daqui são deles. */
export type CopilotoTestResult = { ok: true; phones: number; chats: number } | { ok: false; message: string }

// --- v0.7.0: follow-up do Copiloto (contrato v1.1) ---

/**
 * Estado local de um follow-up escrito pela equipe no Copiloto:
 * - `waiting`: o aviso está na conversa, esperando o mentor ("Abrir para enviar" ou "Recusar");
 * - `sending`: o mentor confirmou o envio (mensagem avulsa na fila, enviando, ou de estado desconhecido);
 * - `sent`: saiu (o eco confirmou) · `declined`: o mentor recusou · `failed`: não dá para enviar (fora dos 30 dias,
 *   conversa não encontrada) · `cancelled`: a equipe cancelou no Copiloto antes do envio.
 */
export type FollowupStatus = 'waiting' | 'sending' | 'sent' | 'declined' | 'failed' | 'cancelled'

export const FOLLOWUP_LIMITS = {
  /** o servidor manda no máximo 50 por vez */
  pendingMax: 50,
  textChars: 4000,
  authorChars: 80,
  /** o motivo da recusa (digitado pelo mentor) vai com no máximo 200 caracteres */
  reasonChars: 200,
  /** atualizações por pedido (`followup_update`) */
  updatesMax: 100,
  /** a busca de follow-ups novos: a cada 5 min enquanto a integração está ligada */
  pollEveryMs: 5 * 60_000,
  /** o aviso de enviado/recusado/sem envio continua visível na conversa por este tempo */
  recentMs: 12 * 60 * 60_000
} as const

/**
 * v0.8.0 (contrato v1.2): envio automático dos follow-ups marcados `auto_send: true`, com a opção ligada. Sai pelo mesmo
 * caminho da mensagem avulsa (todas as travas), sem a tela de confirmação e nunca com "Forçar envio".
 */
export const FOLLOWUP_AUTO = {
  /** envios automáticos por dia (dia do computador); o excedente fica para o dia seguinte */
  perDay: 30,
  /** fora do horário: sai no próximo horário permitido + um atraso sorteado entre 7 e 25 min (nunca na abertura) */
  jitterMinMs: 7 * 60_000,
  jitterMaxMs: 25 * 60_000,
  /** a conexão precisa estar de pé há este tempo (estável) */
  stableMs: 60_000,
  /** tentativas automáticas de um mesmo item que não chegaram a sair (conexão caiu antes etc.); depois, o cartão */
  maxAttempts: 3,
  /** um limitador do WhatsApp (hora/dia) que só libera depois disso: espera, sem pôr na fila (expiraria lá) */
  limiterSlackMs: 2 * 60_000,
  /** v1.2.1: a conferência com o Copiloto antes do envio falhou (rede, 5xx): tenta de novo depois disso */
  postponeMs: 5 * 60_000
} as const

/** Por que um envio automático ainda não saiu (a linha de estado na conversa). */
export type FollowupAutoWait = 'connection' | 'daily_cap' | 'no_hours' | 'busy' | null

/** v0.8.0: o envio automático de um follow-up, como a interface vê; null no follow-up = cartão da v1.1. */
export interface FollowupAuto {
  /** `scheduled`: espera o horário (`at`) · `sending`: na fila/digitando/enviando · `sent`: saiu */
  state: 'scheduled' | 'sending' | 'sent'
  /** epoch ms do envio escolhido (em `scheduled`); null = ainda sem horário (ex.: nenhum dia liberado) */
  at: number | null
  wait: FollowupAutoWait
  /** em `sending`: ainda na fila (dá para "Não enviar") */
  canCancel: boolean
}

/** Motivos curtos do contrato (`reason` do `followup_update`). */
export const FOLLOWUP_REASON = {
  declined: 'recusado_pelo_mentor',
  outside30: 'fora_30_dias',
  notFound: 'conversa_nao_encontrada'
} as const

/** Um follow-up, como a interface vê (o alvo do Copiloto não sai do processo principal). */
export interface FollowupView {
  id: string
  /** a conversa local deste follow-up */
  jid: string
  text: string
  author: string | null
  /** epoch ms: quando a equipe escreveu */
  createdAt: number
  status: FollowupStatus
  /** a mensagem avulsa que leva este follow-up (o mesmo id do rascunho) */
  sendId: number | null
  /** o texto que saiu (o mentor pode ter editado) */
  finalText: string | null
  sentAt: number | null
  /** motivo curto da recusa ou do "não dá para enviar" (o que vai ao Copiloto) */
  reason: string | null
  /** o último envio deste follow-up não saiu (falhou, expirou, cancelado): o motivo; o aviso volta a esperar */
  sendError: string | null
  /** v0.8.0: envio automático (opção ligada e item marcado pelo Copiloto); null = cartão "Abrir para enviar" */
  auto: FollowupAuto | null
}

export const FOLLOWUP_TEXT = {
  outside30: 'O SagaZap só envia para quem mandou mensagem nos últimos 30 dias. Esta mensagem do Copiloto foi devolvida à equipe.',
  done: 'Esta mensagem do Copiloto já foi enviada, recusada ou cancelada.',
  notFound: 'Mensagem do Copiloto não encontrada.'
} as const

export type FollowupOpenResult = { ok: true; followup: FollowupView } | { ok: false; code: 'fora_30_dias' | 'done' | 'not_found' | 'disabled'; message: string }

/** Texto do motivo para o mentor (os códigos do contrato viram frases). */
export function followupReasonText(reason: string | null): string | null {
  if (!reason) return null
  if (reason === FOLLOWUP_REASON.outside30) return 'fora dos 30 dias (o mentorado não escreveu no último mês)'
  if (reason === FOLLOWUP_REASON.notFound) return 'conversa não encontrada neste computador'
  if (reason === FOLLOWUP_REASON.declined) return 'recusada por você'
  return reason
}
