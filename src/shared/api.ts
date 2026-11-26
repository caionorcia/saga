/**
 * Contrato entre o processo principal e a interface (`window.saga`).
 * Só tipos e nomes de canais: nada daqui depende do Electron nem do core em tempo de execução.
 */
import type { AlertRow, AnalysisRow, ContactKind, ContactRow, TranscriptStatus } from '../core/db/repo'
import { ALERT_KINDS, type AlertKind } from './triage'
import type { QueueStats } from '../core/queue/queue'
import type { ConnState } from '../core/wa/client'
import type { KeyKind, Provider, Settings, SettingsPatch, ThemePref, TranscriberKind } from '../core/settings'
import type { KbChunkView, KbFilePatch, KbImportResult, KbPackageView, KbRole, KbSource } from './kb'
import type { SearchFilters, SearchResult, SearchSummaryResult } from './search'
import type {
  AutoBackupPatch,
  BackupExportOptions,
  BackupExportResult,
  BackupOpenResult,
  BackupRestoreMode,
  BackupRestoreResult,
  BackupStatus
} from './backup'
import type { PrepareSendInput, PrepareSendResult, SendAvulsaInput, SendKind, SendOptions, SendPreview, SendReplyInput, SendReplyResult, SendStatus, SendView } from './send'
import type { SendHoursInfo, SendSchedule } from './sendHours'
import type { CopilotoCodeResult, CopilotoPatch, CopilotoSaveResult, CopilotoStatus, CopilotoTestResult } from './copiloto'
import type { AlertQuality, ExportFeedbackOptions, ExportFeedbackResult, RateReason, ReplyDecision, ReplyReason } from './feedback'

export type { ConnState, QueueStats, Provider, TranscriberKind, KeyKind, ContactKind, AlertKind, ThemePref }
export type { AlertQuality, ExportFeedbackOptions, ExportFeedbackResult, RateReason, ReplyDecision, ReplyReason }
export type { KbChunkView, KbFilePatch, KbImportResult, KbPackageView, KbRole, KbSource }
export type { SearchFilters, SearchResult, SearchSummaryResult }
export type { AutoBackupPatch, BackupExportOptions, BackupExportResult, BackupOpenResult, BackupRestoreMode, BackupRestoreResult, BackupStatus }
export type { PrepareSendInput, PrepareSendResult, SendAvulsaInput, SendKind, SendOptions, SendPreview, SendReplyInput, SendReplyResult, SendStatus, SendView }
export type { SendHoursInfo, SendSchedule }
export type { CopilotoCodeResult, CopilotoPatch, CopilotoSaveResult, CopilotoStatus, CopilotoTestResult }
export { ALERT_KINDS }

/** Valores aceitos pelo filtro de `listContacts`. */
export const CONTACT_KINDS: ReadonlyArray<ContactKind> = ['all', 'individual', 'group']
export type Contact = ContactRow
/** Alerta ativo de uma conversa (ver `docs/.../design.md`, "Fila do dia e alertas"). */
export type Alert = AlertRow
export type Analysis = AnalysisRow
export type SettingsView = Settings
export type SaveSettingsInput = SettingsPatch

/**
 * Atualização do app: `available` → botão "Atualizar" (`downloadUpdate`);
 * `ready` → instala ao sair, ou já com "Reiniciar e atualizar" (`installUpdate`).
 */
export type UpdateState =
  | { status: 'none' }
  | { status: 'available' | 'ready'; version: string }
  /** `percent`: quanto já foi baixado (0–100), quando o atualizador informa */
  | { status: 'downloading'; version: string; percent?: number }

/** Resultado da última procura por atualização (Configurações › Atualizações). */
export type UpdateCheckResult = 'available' | 'up_to_date' | 'error'

/** Situação da procura por atualizações: versão atual, quando procurou pela última vez e o que achou. */
export interface UpdateCheck {
  /** false no app de desenvolvimento ou com `SAGA_UPDATES=off`: o SagaZap não procura sozinho */
  enabled: boolean
  /** versão instalada */
  currentVersion: string
  /** procurando agora */
  checking: boolean
  /** epoch ms (relógio do PC) do fim da última procura; null = ainda não procurou */
  lastCheckAt: number | null
  lastResult: UpdateCheckResult | null
  /** a versão mais nova publicada, quando a última procura respondeu */
  latestVersion: string | null
  /** com `lastResult === 'error'`: o motivo, curto (sem dados pessoais) */
  lastError: string | null
}

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
  /** procura por atualizações (Configurações › Atualizações) */
  updateCheck: UpdateCheck
  /** conversas (fora as escondidas) em "Para responder" e conversas com algum alerta ativo */
  triage: { awaiting: number; withAlerts: number }
  /**
   * v0.4.1: envio direto ligado com horário de envio e agora fora dele: a barra mostra "Fora do horário de envio"
   * (clique abre Configurações › Envio direto). null/ausente = dentro do horário, sem horário ou envio desligado
   */
  sendHours?: SendHoursInfo | null
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
  /** grupo: quem mandou (para juntar mensagens seguidas da mesma pessoa); null nas minhas e em conversas individuais */
  senderJid: string | null
  /** grupo: nome de quem mandou (personalizado, agenda, pushName ou número); null nas minhas e em individuais */
  senderName: string | null
  /** grupo: a mensagem menciona o mentor ou cita uma mensagem dele */
  mentionsMe: boolean
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
  /** v0.3.1: abertura automática de uma conversa que não precisa de resposta: a IA não foi chamada */
  | 'not_needed'

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
  /** posição (0, 1, …) da sugestão escolhida na análise atual; o serviço guarda a escolha e as não escolhidas */
  chosenIndex?: number
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
  /**
   * O tema salvo nas configurações quando a janela abriu (vem do processo principal antes da primeira pintura, para a
   * interface já nascer com as cores certas). Mudanças depois: `saveSettings({ theme })`.
   */
  readonly initialTheme: ThemePref
  getState(): Promise<AppState>
  onState(cb: (s: AppState) => void): Unsubscribe
  /** a lista de contatos mudou: chamar `listContacts` de novo */
  onContactsChanged(cb: () => void): Unsubscribe
  /** chegou mensagem (ou transcrição) desse contato: chamar `listMessages(jid)` de novo */
  onMessages(jid: string, cb: () => void): Unsubscribe
  /** um envio dessa conversa mudou de estado: chamar `listSends(jid)` de novo */
  onSends(jid: string, cb: () => void): Unsubscribe

  /**
   * `kind`: todas (padrão), só individuais ou só grupos. `includeHidden`: desde a v0.3.0 a interface não esconde mais
   * conversas (telefone só profissional) e sempre passa `false`; os escondidos antigos foram mostrados de novo.
   */
  listContacts(includeHidden: boolean, kind?: ContactKind): Promise<Contact[]>
  listMessages(jid: string): Promise<MessageView[]>
  /** alertas ativos de uma conversa, ou de todas as não escondidas (mais graves primeiro) */
  listAlerts(jid?: string): Promise<Alert[]>
  /** "Resolver": tira o alerta ativo deste tipo; a lista de contatos é avisada (`onContactsChanged`) */
  dismissAlert(jid: string, kind: AlertKind): Promise<void>
  /**
   * 👍 ('up') ou 👎 ('down', com o motivo) num alerta (da IA ou marcado pelo mentor). Uma avaliação por alerta (mudar
   * de ideia atualiza). O 👎 resolve o alerta e, com `reason.correctKind`, cria esse tipo (marcado como do mentor).
   * No "esperando", 👍 = precisa responder mesmo; o 👎 dele é `setNeedsReply(jid, false, motivo)`.
   */
  rateAlert(alertId: number, verdict: 'up' | 'down', reason?: RateReason): Promise<void>
  /**
   * "Para responder": `false` = "Não precisa responder" (motivo obrigatório; tira da lista e resolve o "esperando");
   * `true` = "Precisa sim" (devolve à lista). Vale até chegar outra mensagem do contato; vira exemplo para a IA.
   */
  setNeedsReply(jid: string, needed: boolean, reason?: ReplyReason): Promise<void>
  /** 👍 no "O SagaZap acha que esta conversa não precisa de resposta" */
  confirmNoReply(jid: string): Promise<void>
  /** "Faltou um alerta?": registra o exemplo e cria o alerta (opcional: a mensagem e um texto do mentor) */
  reportMissedAlert(jid: string, kind: AlertKind, msgId?: string | null, text?: string | null): Promise<void>
  /** contagens de 👍/👎/faltou por tipo, últimos 30 dias */
  alertQuality(): Promise<AlertQuality>
  /** abre "Salvar como" e grava o CSV das avaliações (UTF-8 com BOM, ";"); o arquivo traz trechos das mensagens */
  exportAlertFeedback(opts: ExportFeedbackOptions): Promise<ExportFeedbackResult>
  /**
   * gera se necessário (usa o cache quando a última mensagem não mudou). `onlyIfNeeded` (v0.3.1, o caminho automático
   * da interface): conversa que não precisa de resposta não gera nada (devolve o cache válido ou `not_needed`)
   */
  getAnalysis(jid: string, opts?: { onlyIfNeeded?: boolean }): Promise<AnalysisResult>
  regenerate(jid: string): Promise<AnalysisResult>

  /** grava em `approved_replies`; devolve o id */
  saveReply(input: SaveReplyInput): Promise<number>
  copyToClipboard(text: string): Promise<void>

  // --- envio direto (v0.4.0): só com a confirmação do mentor a cada envio ---
  /**
   * O diálogo "Enviar" abriu: confere as regras (envio direto ligado, o contato falou nos últimos 30 dias) e devolve
   * para quem vai, a citação (grupos) e uma confirmação de uso único para exatamente este jid + texto (5 min). Não envia.
   */
  prepareSend(input: PrepareSendInput): Promise<PrepareSendResult>
  /** "Enviar" no diálogo: exige o token do `prepareSend` (mesmo jid e texto); escolhe a sugestão e põe na fila */
  sendReply(input: SendReplyInput): Promise<SendReplyResult>
  /**
   * v0.6.0 "Enviar mensagem avulsa": exige o token do `prepareSend({ kind: 'avulsa' })` (mesmo jid e texto); mesma fila e
   * mesmas regras das respostas, sem citação e sem gravar na memória. O mesmo rascunho com o mesmo texto não envia duas vezes
   */
  sendAvulsa(input: SendAvulsaInput): Promise<SendReplyResult>
  /** "Cancelar envio" (só enquanto está na fila); `true` se cancelou */
  cancelSend(id: number): Promise<boolean>
  /** os envios recentes da conversa, mais novos primeiro */
  listSends(jid: string): Promise<SendView[]>
  /** "Conferir": procura de novo na conversa um envio de estado desconhecido */
  checkSend(id: number): Promise<SendView | null>

  renameContact(jid: string, name: string): Promise<void>
  setNotes(jid: string, text: string): Promise<void>

  pauseAll(): Promise<void>
  resumeAll(): Promise<void>
  manualReconnect(): Promise<void>
  /** devolve quantos jobs voltaram para a fila */
  retryFailedJobs(): Promise<number>
  /** baixa a nova versão (instala ao fechar o app); sem efeito se não houver atualização */
  downloadUpdate(): Promise<void>
  /** "Verificar agora": procura uma versão nova já e devolve o resultado (espera a procura terminar) */
  checkForUpdates(): Promise<UpdateCheck>
  /** com a atualização baixada (`ready`): fecha o SagaZap com cuidado, instala e abre de novo; senão nada */
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

  // --- base de conhecimento (Configurações › Base de conhecimento) ---
  /** pacotes importados e os "Arquivos avulsos", com os arquivos */
  kbList(): Promise<KbPackageView[]>
  /**
   * "Importar pacote / skill": abre o diálogo do sistema (`archive` = .zip/.skill; `folder` = uma pasta) e importa.
   * Um pacote com o mesmo nome é substituído de uma vez.
   */
  kbImport(kind: 'archive' | 'folder'): Promise<KbImportResult>
  /** "Adicionar arquivo": abre o diálogo (.md, .txt, .docx) e põe nos "Arquivos avulsos" */
  kbAddFile(): Promise<KbImportResult>
  /** "Colar texto": título + texto para os "Arquivos avulsos" */
  kbAddText(title: string, text: string): Promise<KbImportResult>
  /** troca o papel e/ou liga/desliga um arquivo */
  kbUpdateFile(fileId: number, patch: KbFilePatch): Promise<void>
  kbSetPackageEnabled(packageId: number, enabled: boolean): Promise<void>
  kbRemovePackage(packageId: number): Promise<void>
  /** o texto de um trecho ("Baseado em"); null se ele não existe mais (pacote reimportado ou removido) */
  kbGetChunk(chunkId: number): Promise<KbChunkView | null>

  // --- busca geral (v0.3.1) ---
  /** procura em todas as conversas e transcrições (só neste computador); agrupa por conversa */
  searchMessages(query: string, filters?: SearchFilters): Promise<SearchResult>
  /** "Resumir com IA": só quando o mentor clica; manda no máximo 30 trechos à IA das sugestões (dentro do teto diário) */
  summarizeSearch(query: string, filters?: SearchFilters): Promise<SearchSummaryResult>

  // --- cópia de segurança (v0.3.1, Configurações › Cópia de segurança) ---
  /** última cópia e a cópia automática */
  backupStatus(): Promise<BackupStatus>
  /** "Exportar cópia": abre "Salvar como" (`SagaZap-copia-AAAA-MM-DD.sagabackup`) e grava */
  exportBackup(opts: BackupExportOptions): Promise<BackupExportResult>
  /** "Restaurar cópia": abre o diálogo, lê o arquivo e mostra as contagens (ou pede a senha) */
  restoreOpen(): Promise<BackupOpenResult>
  restoreUnlock(token: string, password: string): Promise<BackupOpenResult>
  /** aplica a cópia aberta: `merge` junta com o que existe; `replace` troca (a interface confirma antes) */
  restoreApply(token: string, mode: BackupRestoreMode): Promise<BackupRestoreResult>
  /** escolhe a pasta da cópia automática (diálogo do sistema) */
  chooseBackupFolder(): Promise<BackupStatus>
  setAutoBackup(patch: AutoBackupPatch): Promise<BackupStatus>

  // --- Copiloto da Saga (v0.5.0, Configurações › Copiloto da Saga) ---
  /** ligado, endereço, se há código (nunca o código), pendentes, último envio e último erro */
  copilotoStatus(): Promise<CopilotoStatus>
  /** liga/desliga e o endereço (https, terminando em /functions/v1/sagazap-webhook); desligar apaga a fila local */
  copilotoSave(patch: CopilotoPatch): Promise<CopilotoSaveResult>
  /** "Gerar código": 32 bytes aleatórios; o código volta só nesta resposta (guardado cifrado) */
  copilotoGenerateCode(): Promise<CopilotoCodeResult>
  /** "Testar conexão": busca a lista de mentorados e diz quantos telefones e conversas daqui casaram */
  copilotoTest(): Promise<CopilotoTestResult>
}

/** Métodos chamados por `ipcRenderer.invoke('saga:<nome>')`. */
export const INVOKE_METHODS = [
  'getState',
  'listContacts',
  'listMessages',
  'listAlerts',
  'dismissAlert',
  'rateAlert',
  'reportMissedAlert',
  'setNeedsReply',
  'confirmNoReply',
  'alertQuality',
  'exportAlertFeedback',
  'getAnalysis',
  'regenerate',
  'saveReply',
  'copyToClipboard',
  'prepareSend',
  'sendReply',
  'sendAvulsa',
  'cancelSend',
  'listSends',
  'checkSend',
  'renameContact',
  'setNotes',
  'pauseAll',
  'resumeAll',
  'manualReconnect',
  'retryFailedJobs',
  'downloadUpdate',
  'checkForUpdates',
  'installUpdate',
  'getSettings',
  'saveSettings',
  'testKey',
  'recentEvents',
  'copyDiagnostics',
  'openLogsFolder',
  'audioUrl',
  'kbList',
  'kbImport',
  'kbAddFile',
  'kbAddText',
  'kbUpdateFile',
  'kbSetPackageEnabled',
  'kbRemovePackage',
  'kbGetChunk',
  'searchMessages',
  'summarizeSearch',
  'backupStatus',
  'exportBackup',
  'restoreOpen',
  'restoreUnlock',
  'restoreApply',
  'chooseBackupFolder',
  'setAutoBackup',
  'copilotoStatus',
  'copilotoSave',
  'copilotoGenerateCode',
  'copilotoTest'
] as const satisfies ReadonlyArray<keyof SagaApi>

export type InvokeMethod = (typeof INVOKE_METHODS)[number]

/** Erro de compilação se algum método de `SagaApi` (fora os `on*`) faltar em INVOKE_METHODS. */
type MissingInvoke = Exclude<Exclude<keyof SagaApi, `on${string}` | 'initialTheme'>, InvokeMethod>
export const INVOKE_COMPLETE: [MissingInvoke] extends [never] ? true : MissingInvoke = true

export const invokeChannel = (m: InvokeMethod) => `saga:${m}`

/** Argumento de linha de comando com o tema inicial (`--saga-theme=dark`), lido pelo preload. */
export const THEME_ARG = '--saga-theme='

/** O tema da linha de comando do preload (padrão: Automático). */
export function themeFromArgv(argv: readonly string[]): ThemePref {
  const v = argv.find((a) => a.startsWith(THEME_ARG))?.slice(THEME_ARG.length)
  return v === 'light' || v === 'dark' ? v : 'system'
}

/** Eventos main → interface. */
export const EVENTS = {
  state: 'saga:event:state',
  contacts: 'saga:event:contacts',
  /** argumento: jid */
  messages: 'saga:event:messages',
  /** argumento: jid (um envio dessa conversa mudou) */
  sends: 'saga:event:sends'
} as const
