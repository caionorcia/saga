/**
 * Contrato entre o processo principal e a interface (`window.saga`).
 * Só tipos e nomes de canais: nada daqui depende do Electron nem do core em tempo de execução.
 */
import type { AnalysisRow, ContactRow, TranscriptStatus } from '../core/db/repo'
import type { QueueStats } from '../core/queue/queue'
import type { ConnState } from '../core/wa/client'
import type { KeyKind, Provider, Settings, SettingsPatch, TranscriberKind } from '../core/settings'

export type { ConnState, QueueStats, Provider, TranscriberKind, KeyKind }
export type Contact = ContactRow
export type Analysis = AnalysisRow
export type SettingsView = Settings
export type SaveSettingsInput = SettingsPatch

/**
 * Atualização do app: `available` → botão "Atualizar" (`downloadUpdate`);
 * `ready` → instala ao sair, ou já com "Reiniciar e atualizar" (`installUpdate`).
 */
export type UpdateState =
  | { status: 'none' }
  | { status: 'available' | 'downloading' | 'ready'; version: string }

export interface AppState {
  /**
   * Botões da interface:
   * `needs_qr` → mostrar `qr`; `manual_retry_needed` e `stopped_*` → "Tentar de novo" (`manualReconnect`).
   */
  conn: ConnState
  /** data URL (PNG) do QR enquanto `conn === 'needs_qr'` */
  qr: string | null
  /** `conn === 'waiting_retry'`: quando a próxima tentativa acontece (epoch ms); senão null */
  retryAt: number | null
  /** `queue.failed > 0` → "Tentar de novo" (`retryFailedJobs`) */
  queue: QueueStats
  /** pausado pelo usuário (ou por desconexão definitiva) → "Retomar" (`resumeAll`) */
  paused: boolean
  /** menos de 1 GB livre: downloads pausados → "Retomar" (`resumeAll`) re-checa o disco */
  diskLow: boolean
  /** transcrições pausadas (chave, teto de gasto ou sem internet) → configurar a chave ou "Retomar" */
  transcribePaused: boolean
  /**
   * por que as transcrições estão pausadas (null = não estão): `key` chave ausente/recusada,
   * `budget` teto diário de gasto atingido (OpenAI; volta amanhã), `network` sem internet (volta em 2 min)
   */
  transcribePausedReason: 'key' | 'budget' | 'network' | null
  /** áudios a baixar no lote atual: `remaining` pendentes/rodando, `done` concluídos desde que o lote começou */
  downloads: { remaining: number; done: number }
  costTodayUsd: number
  /** chave Groq configurada e o WhatsApp já conectou alguma vez */
  setupDone: boolean
  provider: Provider
  update: UpdateState
  /** o início do app falhou (mensagem curta, sem dados sensíveis): mostrar com "Tentar de novo" (`manualReconnect`) */
  startError?: string
}

export interface MessageView {
  id: string
  jid: string
  fromMe: boolean
  /** epoch ms (horário do WhatsApp) */
  ts: number
  kind: 'text' | 'audio' | 'other'
  text: string | null
  durationSec: number | null
  /** o áudio original já foi baixado (`audioUrl(id)` devolve a URL) */
  hasAudio: boolean
  transcript: string | null
  transcriptStatus: TranscriptStatus | null
}

export type AiErrorCode =
  | 'missing_key'
  | 'invalid_key'
  | 'budget_exceeded'
  | 'rate_limited'
  | 'refusal'
  | 'invalid_output'
  | 'no_messages'
  | 'model_unavailable'
  | 'unknown'

export type AnalysisResult =
  | { ok: true; analysis: Analysis }
  | { ok: false; code: AiErrorCode; message: string; provider: Provider }

export type SaveSettingsResult =
  | { ok: true; settings: SettingsView }
  | { ok: false; code: 'encryption_unavailable' | 'invalid'; message: string }

export interface SaveReplyInput {
  jid: string
  /** a sugestão da IA de onde a resposta partiu (null = escrita do zero) */
  originalSuggestion: string | null
  finalText: string
  /** `lastMsgId` da análise que gerou a sugestão: o contexto salvo é o daquela análise */
  analysisLastMsgId?: string | null
}

export interface RecentEvent {
  id: number
  /** epoch ms */
  ts: number
  kind: string
  detail: string
}

export type Unsubscribe = () => void

export interface SagaApi {
  getState(): Promise<AppState>
  onState(cb: (s: AppState) => void): Unsubscribe
  /** a lista de contatos mudou: chamar `listContacts` de novo */
  onContactsChanged(cb: () => void): Unsubscribe
  /** chegou mensagem (ou transcrição) desse contato: chamar `listMessages(jid)` de novo */
  onMessages(jid: string, cb: () => void): Unsubscribe

  listContacts(includeHidden: boolean): Promise<Contact[]>
  listMessages(jid: string): Promise<MessageView[]>
  /** gera se necessário (usa o cache quando a última mensagem não mudou) */
  getAnalysis(jid: string): Promise<AnalysisResult>
  regenerate(jid: string): Promise<AnalysisResult>

  /** grava em `approved_replies`; devolve o id */
  saveReply(input: SaveReplyInput): Promise<number>
  copyToClipboard(text: string): Promise<void>

  renameContact(jid: string, name: string): Promise<void>
  setHidden(jid: string, hidden: boolean): Promise<void>
  setNotes(jid: string, text: string): Promise<void>

  pauseAll(): Promise<void>
  resumeAll(): Promise<void>
  manualReconnect(): Promise<void>
  /** devolve quantos jobs voltaram para a fila */
  retryFailedJobs(): Promise<number>
  /** baixa a nova versão (instala ao fechar o app); sem efeito se não houver atualização */
  downloadUpdate(): Promise<void>
  /** com a atualização baixada (`ready`): fecha o Saga com cuidado, instala e abre de novo; senão nada */
  installUpdate(): Promise<void>

  getSettings(): Promise<SettingsView>
  saveSettings(patch: SaveSettingsInput): Promise<SaveSettingsResult>
  testKey(kind: KeyKind, key: string): Promise<boolean>
  /** eventos recentes do app (mais novos primeiro), para a tela de configurações */
  recentEvents(limit: number): Promise<RecentEvent[]>
  /**
   * Copia para a área de transferência as versões do app e as últimas ~200 linhas do registro de diagnóstico
   * (sem chaves, mensagens nem QR), para mandar ao suporte. Devolve quantas linhas do registro foram copiadas.
   */
  copyDiagnostics(): Promise<number>
  /** abre a pasta dos registros de diagnóstico no Explorador */
  openLogsFolder(): Promise<void>

  /** `saga-media://audio/<id>` do áudio original, ou null se ainda não foi baixado */
  audioUrl(id: string): Promise<string | null>
}

/** Métodos chamados por `ipcRenderer.invoke('saga:<nome>')`. */
export const INVOKE_METHODS = [
  'getState',
  'listContacts',
  'listMessages',
  'getAnalysis',
  'regenerate',
  'saveReply',
  'copyToClipboard',
  'renameContact',
  'setHidden',
  'setNotes',
  'pauseAll',
  'resumeAll',
  'manualReconnect',
  'retryFailedJobs',
  'downloadUpdate',
  'installUpdate',
  'getSettings',
  'saveSettings',
  'testKey',
  'recentEvents',
  'copyDiagnostics',
  'openLogsFolder',
  'audioUrl'
] as const satisfies ReadonlyArray<keyof SagaApi>

export type InvokeMethod = (typeof INVOKE_METHODS)[number]

/** Erro de compilação se algum método de `SagaApi` (fora os `on*`) faltar em INVOKE_METHODS. */
type MissingInvoke = Exclude<Exclude<keyof SagaApi, `on${string}`>, InvokeMethod>
export const INVOKE_COMPLETE: [MissingInvoke] extends [never] ? true : MissingInvoke = true

export const invokeChannel = (m: InvokeMethod) => `saga:${m}`

/** Eventos main → interface. */
export const EVENTS = {
  state: 'saga:event:state',
  contacts: 'saga:event:contacts',
  /** argumento: jid */
  messages: 'saga:event:messages'
} as const
