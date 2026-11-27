import { app, clipboard, dialog, ipcMain, type BrowserWindow } from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SagaService } from '../core/service'
import { EVENTS, INVOKE_METHODS, invokeChannel, type InvokeMethod, type SagaApi, type UpdateCheck } from '../shared/api'
import { validateIpcArgs } from './guards'
import type { ConvoAction } from '../shared/copiloto'
import { SINGLE_FILE_EXT } from '../core/kb/importer'
import { backupFileName } from '../core/backup/manager'
import { BACKUP_ERROR_TEXT, BACKUP_EXT } from '../shared/backup'

/** maior arquivo de cópia que o SagaZap abre */
const BACKUP_MAX_BYTES = 900 * 1024 * 1024

type Handlers = { [M in InvokeMethod]: (...args: Parameters<SagaApi[M]>) => ReturnType<SagaApi[M]> }

export interface IpcOptions {
  getWindow: () => BrowserWindow | null
  /** só a interface do próprio app pode chamar (URL do frame que enviou) */
  isTrustedSender: (frameUrl: string) => boolean
  /** registra cada chamada recusada (só método e URL do remetente, nunca os argumentos) */
  onRefused?: (method: string, frameUrl: string | null) => void
  /** depois de salvar as configurações (ex.: abrir com o Windows) */
  onSettingsSaved?: () => void
  /** o usuário clicou em "Atualizar" */
  onDownloadUpdate?: () => Promise<void>
  /** "Verificar agora" (Configurações › Atualizações); sem atualizador, devolve a situação atual */
  onCheckForUpdates?: () => Promise<UpdateCheck>
  /** o usuário clicou em "Reiniciar e atualizar" */
  onInstallUpdate?: () => Promise<void>
  /** texto do "Copiar diagnóstico" e quantas linhas do registro ele tem */
  getDiagnostics?: () => { text: string; lines: number }
  /** "Abrir pasta de registros" */
  openLogsFolder?: () => Promise<void>
  /** a cópia automática foi ligada/desligada (o processo principal confere se já está na hora) */
  onAutoBackupChanged?: () => void
}

/** Liga cada método de `window.saga` ao serviço e repassa os eventos do serviço para a janela. */
/** Só os campos do tipo (os argumentos já passaram por `isConvoAction`). */
function sanitizeConvoAction(a: ConvoAction): ConvoAction {
  if (a.kind === 'send') return { kind: 'send', draftId: String(a.draftId), text: String(a.text), ...(a.forced === true ? { forced: true } : {}) }
  if (a.kind === 'item') return { kind: 'item', item: String(a.item), done: a.done === true }
  return { kind: a.kind }
}

export function registerIpc(service: SagaService, opts: IpcOptions): () => void {
  const h: Handlers = {
    getState: () => service.getState(),
    listContacts: (includeHidden, kind) => service.listContacts(!!includeHidden, kind ?? 'all'),
    listMessages: (jid) => service.listMessages(String(jid)),
    listMessagesPage: (jid, limit, includeId) => service.listMessagesPage(String(jid), Number(limit), includeId ? String(includeId) : null),
    transcribeAudio: (id) => service.transcribeAudio(String(id)),
    listAlerts: (jid) => service.listAlerts(jid === undefined ? undefined : String(jid)),
    dismissAlert: (jid, kind) => service.dismissAlert(String(jid), kind),
    rateAlert: (id, verdict, reason) => service.rateAlert(Number(id), verdict, reason),
    setNeedsReply: (jid, needed, reason) => service.setNeedsReply(String(jid), needed === true, reason),
    confirmNoReply: (jid) => service.confirmNoReply(String(jid)),
    reportMissedAlert: (jid, kind, msgId, text) => service.reportMissedAlert(String(jid), kind, msgId ?? null, text ?? null),
    alertQuality: () => service.alertQuality(),
    exportAlertFeedback: async (o) => {
      const { csv, rows } = service.alertFeedbackCsv({ anonymize: o.anonymize === true })
      if (rows === 0) return { status: 'empty' }
      const day = new Date().toISOString().slice(0, 10)
      const w = opts.getWindow()
      const dlgOpts = {
        title: 'Exportar avaliações dos alertas',
        defaultPath: join(app.getPath('documents'), `saga-avaliacoes-alertas-${day}.csv`),
        filters: [{ name: 'Planilha CSV', extensions: ['csv'] }]
      }
      const r = w ? await dialog.showSaveDialog(w, dlgOpts) : await dialog.showSaveDialog(dlgOpts)
      if (r.canceled || !r.filePath) return { status: 'canceled' }
      // o caminho vem do diálogo do sistema (escolha do usuário), nunca da interface
      await writeFile(r.filePath, csv, 'utf8')
      return { status: 'saved', rows }
    },
    getAnalysis: (jid, o) => service.getAnalysis(String(jid), { onlyIfNeeded: o?.onlyIfNeeded === true }),
    regenerate: (jid) => service.regenerate(String(jid)),
    saveReply: (input) => service.saveReply(input),
    copyToClipboard: async (text) => clipboard.writeText(String(text)),
    prepareSend: (input) =>
      service.prepareSend({ jid: String(input.jid), text: String(input.text), forced: input.forced === true, kind: input.kind === 'avulsa' ? 'avulsa' : 'reply' }),
    sendReply: (input) => service.sendReply(input),
    sendAvulsa: (input) => service.sendAvulsa({ token: String(input.token), jid: String(input.jid), text: String(input.text), draftId: String(input.draftId) }),
    cancelSend: (id) => service.cancelSend(Number(id)),
    listSends: (jid) => service.listSends(String(jid)),
    checkSend: (id) => service.checkSend(Number(id)),
    renameContact: (jid, name) => service.renameContact(String(jid), String(name)),
    setNotes: (jid, text) => service.setNotes(String(jid), String(text)),
    pauseAll: () => service.pauseAll(),
    resumeAll: () => service.resumeAll(),
    manualReconnect: () => service.manualReconnect(),
    retryFailedJobs: () => service.retryFailedJobs(),
    downloadUpdate: async () => {
      await opts.onDownloadUpdate?.()
    },
    checkForUpdates: async () => (await opts.onCheckForUpdates?.()) ?? service.state().updateCheck,
    installUpdate: async () => {
      await opts.onInstallUpdate?.()
    },
    getSettings: () => service.getSettings(),
    saveSettings: async (patch) => {
      const r = await service.saveSettings(patch ?? {})
      if (!r.ok && r.code === 'encryption_unavailable') {
        dialog.showErrorBox('SagaZap', 'A criptografia do Windows não está disponível. A chave não foi salva.')
      }
      if (r.ok) opts.onSettingsSaved?.()
      return r
    },
    testKey: (kind, key) => service.testKey(kind, String(key)),
    recentEvents: (n) => service.recentEvents(Number(n)),
    copyDiagnostics: async () => {
      const d = opts.getDiagnostics?.()
      if (!d) return 0
      clipboard.writeText(d.text)
      return d.lines
    },
    openLogsFolder: async () => {
      await opts.openLogsFolder?.()
    },
    audioUrl: (id) => service.audioUrl(String(id)),
    kbList: () => service.kbList(),
    kbImport: async (kind) => {
      const w = opts.getWindow()
      const dlgOpts: Electron.OpenDialogOptions =
        kind === 'folder'
          ? { title: 'Escolha a pasta do pacote', properties: ['openDirectory'] }
          : { title: 'Escolha o pacote ou a skill', properties: ['openFile'], filters: [{ name: 'Pacote ou skill', extensions: ['zip', 'skill'] }] }
      const r = w ? await dialog.showOpenDialog(w, dlgOpts) : await dialog.showOpenDialog(dlgOpts)
      // o caminho vem do diálogo do sistema (escolha do usuário), nunca da interface
      if (r.canceled || !r.filePaths[0]) return { status: 'canceled' }
      return service.kbImportPackage(r.filePaths[0], kind === 'folder' ? 'folder' : 'archive')
    },
    kbAddFile: async () => {
      const w = opts.getWindow()
      const dlgOpts: Electron.OpenDialogOptions = {
        title: 'Adicionar arquivo à base de conhecimento',
        properties: ['openFile'],
        filters: [{ name: 'Texto (.md, .txt, .docx)', extensions: [...SINGLE_FILE_EXT] }]
      }
      const r = w ? await dialog.showOpenDialog(w, dlgOpts) : await dialog.showOpenDialog(dlgOpts)
      if (r.canceled || !r.filePaths[0]) return { status: 'canceled' }
      return service.kbAddFile(r.filePaths[0])
    },
    kbAddText: (title, text) => service.kbAddText(String(title), String(text)),
    kbUpdateFile: (id, patch) => service.kbUpdateFile(Number(id), patch),
    kbSetPackageEnabled: (id, enabled) => service.kbSetPackageEnabled(Number(id), enabled === true),
    kbRemovePackage: (id) => service.kbRemovePackage(Number(id)),
    kbGetChunk: (id) => service.kbGetChunk(Number(id)),
    searchMessages: (q, f) => service.searchMessages(String(q), f ?? {}),
    summarizeSearch: (q, f) => service.summarizeSearch(String(q), f ?? {}),
    backupStatus: async () => service.backup.status(),
    exportBackup: async (o) => {
      const w = opts.getWindow()
      const dlgOpts = {
        title: 'Exportar cópia de segurança',
        defaultPath: join(app.getPath('documents'), backupFileName(Date.now())),
        filters: [{ name: 'Cópia de segurança do SagaZap', extensions: [BACKUP_EXT] }]
      }
      const r = w ? await dialog.showSaveDialog(w, dlgOpts) : await dialog.showSaveDialog(dlgOpts)
      if (r.canceled || !r.filePath) return { status: 'canceled' }
      try {
        // o caminho vem do diálogo do sistema (escolha do usuário), nunca da interface
        const out = service.backup.exportTo(r.filePath, { includeMessages: o.includeMessages === true, password: o.password || undefined, uiPrefs: o.uiPrefs })
        return { status: 'saved', counts: out.counts, bytes: out.bytes, encrypted: !!o.password }
      } catch {
        return { status: 'error', message: 'Não foi possível gravar a cópia nesse lugar. Escolha outra pasta.' }
      }
    },
    restoreOpen: async () => {
      const w = opts.getWindow()
      const dlgOpts: Electron.OpenDialogOptions = {
        title: 'Restaurar cópia de segurança',
        properties: ['openFile'],
        filters: [{ name: 'Cópia de segurança do SagaZap', extensions: [BACKUP_EXT, 'zip'] }]
      }
      const r = w ? await dialog.showOpenDialog(w, dlgOpts) : await dialog.showOpenDialog(dlgOpts)
      if (r.canceled || !r.filePaths[0]) return { status: 'canceled' }
      try {
        if ((await stat(r.filePaths[0])).size > BACKUP_MAX_BYTES) return { status: 'error', code: 'invalid', message: BACKUP_ERROR_TEXT.invalid }
        return service.backup.open(await readFile(r.filePaths[0]))
      } catch {
        return { status: 'error', code: 'invalid', message: BACKUP_ERROR_TEXT.invalid }
      }
    },
    restoreUnlock: async (token, password) => service.backup.unlock(String(token), String(password)),
    restoreApply: async (token, mode) => {
      const r = service.backup.restore(String(token), mode === 'replace' ? 'replace' : 'merge')
      // o tema e as outras configurações restauradas valem já (moldura da janela etc.)
      if (r.status === 'restored') opts.onSettingsSaved?.()
      return r
    },
    chooseBackupFolder: async () => {
      const w = opts.getWindow()
      const dlgOpts: Electron.OpenDialogOptions = { title: 'Pasta das cópias automáticas', properties: ['openDirectory', 'createDirectory'] }
      const r = w ? await dialog.showOpenDialog(w, dlgOpts) : await dialog.showOpenDialog(dlgOpts)
      if (r.canceled || !r.filePaths[0]) return service.backup.status()
      return service.backup.setAutoFolder(r.filePaths[0])
    },
    setAutoBackup: async (patch) => {
      const st = service.backup.setAuto(patch)
      opts.onAutoBackupChanged?.()
      return st
    },
    copilotoStatus: () => service.copilotoStatus(),
    copilotoSave: (patch) =>
      service.copilotoSave({
        ...(patch.enabled !== undefined ? { enabled: patch.enabled === true } : {}),
        ...(patch.url !== undefined ? { url: String(patch.url) } : {}),
        ...(patch.autoFollowups !== undefined ? { autoFollowups: patch.autoFollowups === true } : {}),
        ...(patch.followupTest !== undefined ? { followupTest: patch.followupTest === true } : {})
      }),
    copilotoGenerateCode: () => service.copilotoGenerateCode(),
    copilotoTest: () => service.copilotoTest(),
    copilotoRepairGroups: () => service.copilotoRepairGroups(),
    copilotoFetchGroupHistory: () => service.copilotoFetchGroupHistory(),
    copilotoMembershipGroups: () => service.copilotoMembershipGroups(),
    copilotoSetMembershipGroup: (key, jid) => service.copilotoSetMembershipGroup(key, jid === null ? null : String(jid)),
    copilotoCheckMembership: () => service.copilotoCheckMembership(),
    listFollowups: () => service.listFollowups(),
    followupOpen: (id) => service.followupOpen(String(id)),
    followupDecline: (id, reason) => service.followupDecline(String(id), reason === null ? null : String(reason)),
    listConvos: () => service.listConvos(),
    convoAction: (id, action) => service.convoAction(String(id), sanitizeConvoAction(action))
  }

  for (const m of INVOKE_METHODS) {
    const fn = h[m] as (...args: unknown[]) => unknown
    ipcMain.handle(invokeChannel(m), (e, ...args: unknown[]) => {
      const url = e.senderFrame?.url
      if (!url || !opts.isTrustedSender(url)) {
        try {
          opts.onRefused?.(m, url ?? null)
        } catch {
          // registrar nunca pode quebrar a recusa
        }
        throw new Error(`chamada recusada: origem não confiável (${m})`)
      }
      validateIpcArgs(m, args)
      return fn(...args)
    })
  }

  const send = (channel: string, ...args: unknown[]) => {
    const w = opts.getWindow()
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...args)
  }
  const offs = [
    service.onState((s) => send(EVENTS.state, s)),
    service.onContactsChanged(() => send(EVENTS.contacts))
  ]
  const onMsg = (jid: string) => send(EVENTS.messages, jid)
  service.on('messages', onMsg)
  const onSends = (jid: string) => send(EVENTS.sends, jid)
  service.on('sends', onSends)
  const onFollowups = () => send(EVENTS.followups)
  service.on('followups', onFollowups)

  return () => {
    for (const m of INVOKE_METHODS) ipcMain.removeHandler(invokeChannel(m))
    for (const off of offs) off()
    service.off('messages', onMsg)
    service.off('sends', onSends)
    service.off('followups', onFollowups)
  }
}
