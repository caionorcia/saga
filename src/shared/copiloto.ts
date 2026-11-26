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
}

export interface CopilotoPatch {
  enabled?: boolean
  /** `''` apaga o endereço */
  url?: string
}

export type CopilotoSaveResult = { ok: true; status: CopilotoStatus } | { ok: false; message: string }

/** "Gerar código": o código aparece só esta vez. */
export type CopilotoCodeResult = { ok: true; code: string } | { ok: false; message: string }

/** "Testar conexão": quantos telefones de mentorados o Copiloto mandou e quantas conversas daqui são deles. */
export type CopilotoTestResult = { ok: true; phones: number; chats: number } | { ok: false; message: string }
