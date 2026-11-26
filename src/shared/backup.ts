/**
 * Cópia de segurança (v0.3.1): exportar e restaurar o que o Saga aprendeu (respostas aprovadas, nomes e notas,
 * avaliações, base de conhecimento e configurações sem segredo). Só tipos e constantes.
 */

export const BACKUP_EXT = 'sagabackup'
/** quantas cópias automáticas ficam na pasta (as mais velhas são apagadas) */
export const AUTO_BACKUP_KEEP = 5
export const AUTO_BACKUP_EVERY_MS = 7 * 86_400_000
export const BACKUP_PASSWORD_MIN = 6
export const BACKUP_PASSWORD_MAX = 200

/** Quanto de cada coisa há numa cópia (ou foi restaurado). */
export interface BackupCounts {
  approvedReplies: number
  contacts: number
  alertFeedback: number
  replyFeedback: number
  kbPackages: number
  kbFiles: number
  settings: number
  messages: number
}

/** Preferências da interface (filtros da lista, Foco), guardadas no navegador da janela; vão e voltam na cópia. */
export type UiPrefs = Record<string, string>

export interface BackupExportOptions {
  /** "Proteger com senha" (recomendado); vazio/ausente = sem senha */
  password?: string
  /** "Incluir mensagens e transcrições (arquivo maior)" */
  includeMessages: boolean
  uiPrefs?: UiPrefs
}

export type BackupExportResult =
  | { status: 'saved'; counts: BackupCounts; bytes: number; encrypted: boolean }
  | { status: 'canceled' }
  | { status: 'error'; message: string }

export interface BackupPreview {
  /** epoch ms de quando a cópia foi feita */
  createdAt: number
  appVersion: string
  encrypted: boolean
  counts: BackupCounts
}

export type BackupOpenResult =
  | { status: 'canceled' }
  /** a cópia tem senha: chamar `restoreUnlock(token, senha)` */
  | { status: 'needs_password'; token: string; createdAt: number }
  | { status: 'preview'; token: string; preview: BackupPreview }
  | { status: 'error'; code: BackupErrorCode; message: string }

export type BackupRestoreMode = 'merge' | 'replace'

export type BackupRestoreResult =
  | { status: 'restored'; mode: BackupRestoreMode; counts: BackupCounts; uiPrefs: UiPrefs }
  | { status: 'error'; code: BackupErrorCode; message: string }

export type BackupErrorCode = 'invalid' | 'corrupted' | 'version' | 'wrong_password' | 'expired' | 'failed'

export const BACKUP_ERROR_TEXT: Record<BackupErrorCode, string> = {
  invalid: 'Este arquivo não é uma cópia de segurança do Saga.',
  corrupted: 'A cópia está danificada ou incompleta. Tente outra cópia.',
  version: 'Esta cópia foi feita por uma versão mais nova do Saga. Atualize o Saga e tente de novo.',
  wrong_password: 'Senha incorreta. Confira e tente de novo.',
  expired: 'Escolha o arquivo da cópia de novo.',
  failed: 'Não foi possível restaurar a cópia. Nada foi alterado.'
}

export interface BackupStatus {
  /** última cópia feita (manual ou automática), epoch ms */
  lastAt: number | null
  auto: {
    enabled: boolean
    /** pasta escolhida (para mostrar) */
    folder: string | null
    /** as cópias automáticas têm senha */
    hasPassword: boolean
    lastAt: number | null
    /** a última tentativa automática falhou (motivo curto) */
    lastError: string | null
  }
}

export interface AutoBackupPatch {
  enabled?: boolean
  /** senha das cópias automáticas; '' tira a senha */
  password?: string
}
