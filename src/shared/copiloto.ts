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
  server: 'O Copiloto não respondeu direito. Tente de novo mais tarde.',
  repairOff: 'Ligue o envio para o Copiloto antes de reenviar o histórico dos grupos.',
  historyOff: 'Ligue o envio para o Copiloto antes de buscar o histórico dos mentorados.',
  historyNoRoster: 'A lista de mentorados ainda não chegou do Copiloto. Clique em "Testar conexão" e tente de novo.',
  historyUnavailable: 'Esta versão do WhatsApp não permite buscar o histórico no celular.'
} as const

/** dd/mm (hora local) */
function dayMonth(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * v0.8.3: o histórico dos grupos dos mentorados no Copiloto (só contagens, nunca nomes): a mensagem mais antiga já aceita
 * pelo Copiloto, em quantos grupos e quantas mensagens; e quantas ainda estão na fila.
 */
export interface CopilotoGroupHistory {
  /** epoch ms da mensagem de grupo mais antiga já aceita pelo Copiloto (null = nenhuma ainda) */
  oldestTs: number | null
  groups: number
  messages: number
  /** mensagens de grupo ainda na fila deste computador */
  pending: number
}

export function groupHistoryLine(h: CopilotoGroupHistory): string {
  const queued = h.pending > 0 ? ` (${h.pending} na fila)` : ''
  if (h.oldestTs === null || h.messages === 0) return `Histórico dos grupos: nenhuma mensagem de grupo enviada ao Copiloto ainda${queued}`
  return `Histórico dos grupos: mensagem mais antiga em ${dayMonth(h.oldestTs)}; ${h.groups} grupo(s), ${h.messages} mensagem(ns) enviadas ao Copiloto${queued}`
}

/**
 * v0.8.3: "Buscar no celular o histórico dos grupos" (pedidos ao celular, um a cada 20 s, no máximo 60 por dia).
 * v0.9.0: "Buscar no celular o histórico completo dos mentorados": conversas individuais e grupos, até o celular não ter mais.
 * - `running`: pedindo (ou esperando o ritmo, a conexão ou o dia seguinte, quando `capped`);
 * - `waiting_phone`: o celular não respondeu três vezes seguidas (desligado ou sem internet): para até clicar de novo;
 * - `done`: o celular não tinha mais nada antes da mais antiga de cada conversa.
 */
export interface GroupHistoryFetchView {
  state: 'running' | 'waiting_phone' | 'done'
  startedAt: number
  finishedAt: number | null
  /** conversas de mentorados (individuais e grupos) com mensagem guardada aqui (dá para pedir as anteriores) */
  groups: number
  /** desses, quantos já terminaram */
  done: number
  requests: number
  /** mensagens novas guardadas com as respostas do celular */
  received: number
  /** grupos de mentorados sem nenhuma mensagem aqui: sem ponto de partida, só reconectando o aparelho */
  noAnchor: number
  /** o limite do dia (60 pedidos) acabou: continua amanhã */
  capped: boolean
}

export function historyFetchLine(v: GroupHistoryFetchView): string {
  const progress = `${v.done} de ${v.groups} conversa(s) concluída(s) · ${v.requests} pedido(s) ao celular · ${v.received} mensagem(ns) nova(s)`
  if (v.state === 'done') return `Busca no celular concluída: ${progress}`
  if (v.state === 'waiting_phone') return `Busca no celular parada: o celular não respondeu. Deixe o celular ligado e com internet e clique de novo. ${progress}`
  return `Buscando no celular: ${progress}${v.capped ? ' · limite de pedidos de hoje atingido, continua amanhã' : ''}`
}

export function noAnchorLine(n: number): string {
  return `${n} grupo(s) precisam reconectar o aparelho para trazer o histórico`
}

/** v0.8.1: o último "Reenviar histórico dos grupos" (só contagens). */
export interface CopilotoGroupRepair {
  /** epoch ms */
  at: number
  /** grupos de mentorados com mensagens postas na fila */
  groups: number
  messages: number
  /** grupos de mentorados sem nenhuma mensagem guardada neste computador (nada a mandar) */
  empty: number
}

/** A linha que Configurações › Copiloto da Saga mostra depois do reenvio. */
export function groupRepairLine(r: CopilotoGroupRepair): string {
  return `Grupos: ${r.groups} grupo(s) e ${r.messages} mensagem(ns) colocados na fila para o Copiloto (${r.empty} grupo(s) sem nenhuma mensagem neste computador)`
}

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
  /** v0.8.1: o último reenvio do histórico dos grupos (null = ainda não rodou) e se há um pedido esperando o roster */
  groupRepair: CopilotoGroupRepair | null
  groupRepairPending: boolean
  /** v0.8.3: o histórico dos grupos dos mentorados que já está no Copiloto */
  groupHistory: CopilotoGroupHistory
  /** v0.8.3: a última "Buscar no celular o histórico dos grupos" (null = nunca) */
  historyFetch: GroupHistoryFetchView | null
}

/** v0.8.1: "Reenviar histórico dos grupos". */
export type CopilotoRepairResult = { ok: true; status: CopilotoStatus } | { ok: false; message: string }

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
  /**
   * v1.2.1: a conferência com o Copiloto antes de pôr um automático na fila falhou (rede, 5xx): todos os automáticos
   * esperam 5 → 10 → 20 → 30 min (no máximo); volta ao começo na primeira resposta boa
   */
  pollBackoffMinMs: 5 * 60_000,
  pollBackoffMaxMs: 30 * 60_000
} as const

/** Por que um envio automático ainda não saiu (a linha de estado na conversa). */
export type FollowupAutoWait = 'connection' | 'daily_cap' | 'no_hours' | 'busy' | 'copiloto' | null

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
