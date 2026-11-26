import { app, BrowserWindow, Menu, nativeImage, nativeTheme, net, powerMonitor, protocol, screen, shell, Tray } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { arch, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openDb } from '../core/db/db'
import { Repo } from '../core/db/repo'
import { MEDIA_SCHEME, resolveMediaPath } from '../core/media'
import { SagaService } from '../core/service'
import { createDiagLog, diagnosticsText, type DiagLog } from './diagLog'
import { isAppUrl, isExternalHttpUrl, type AppOrigin } from './guards'
import { registerIpc } from './ipc'
import { THEME_ARG, type ThemePref } from '../shared/api'
import { createSettingsStore, safeStorageCipher } from './settings'
import { startUpdater, updatesEnabled, type Updater } from './updater'
import { initialUpdaterModel } from './updaterState'
import { MIN_SIZE, WINDOW_STATE_KEY, parseWindowState, serializeWindowState, windowCreateOptions } from './windowState'

// círculo verde 16x16 (sem arquivo de recurso para empacotar)
const TRAY_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAaUlEQVR4nGNQXZjNgAMbqC7MjoJiA1zqsAm2qi7M/o8Dt+IzgF11YfZdPJph+C5ULYYBxGhGNgTFAHzOxusdmAGkaoZhBlhok2uAAQM0msg1IIoqBlDsBYoDkSrRSHFCokpSpjgzkZWdAS3a2/Bb52t3AAAAAElFTkSuQmCC'

protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }
])

let win: BrowserWindow | null = null
let tray: Tray | null = null
let service: SagaService | null = null
let quitting = false
let stopped = false

/** registro de diagnóstico em `<userData>/logs/saga.log` (nunca chaves, mensagens ou o QR) */
const diagLog: DiagLog = createDiagLog(join(app.getPath('userData'), 'logs'))
const errDetail = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e)).slice(0, 1500)

function versionsHeader(): Record<string, string> {
  return {
    Saga: app.getVersion(),
    Electron: process.versions.electron ?? '?',
    Node: process.versions.node,
    Chrome: process.versions.chrome ?? '?',
    Sistema: `${process.platform} ${release()} ${arch()}`,
    Empacotado: app.isPackaged ? 'sim' : 'não'
  }
}

// erros que escapariam sem deixar rastro: vão para o registro (o app continua de pé)
process.on('uncaughtException', (e) => {
  diagLog.write('uncaught_exception', errDetail(e))
  console.error('[saga] exceção não tratada:', e)
})
process.on('unhandledRejection', (e) => {
  diagLog.write('unhandled_rejection', errDetail(e))
  console.error('[saga] promessa rejeitada sem tratamento:', e)
})

const appOrigin: AppOrigin = {
  devUrl: process.env['ELECTRON_RENDERER_URL'],
  indexFile: join(import.meta.dirname, '../renderer/index.html')
}

function showWindow(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** Fundo da janela antes de a interface pintar (sem clarão branco no tema escuro). */
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#0e1517' : '#f0f2f3')

/**
 * Tema salvo → moldura da janela, barras de rolagem e `prefers-color-scheme` da interface
 * (`system` = Automático, segue o Windows).
 */
function applyNativeTheme(theme: ThemePref): void {
  nativeTheme.themeSource = theme
  if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground())
}

/** Onde o tamanho/posição da janela fica guardado (no banco, `settings_kv`). */
interface WindowStore {
  get(): string | null
  set(v: string): void
}

function createWindow(theme: ThemePref, store: WindowStore): BrowserWindow {
  // padrão: maximizada; se o mentor tirou do maximizado, volta como deixou (encaixado numa tela que existe agora)
  const saved = parseWindowState(store.get())
  const place = windowCreateOptions(
    saved,
    screen.getAllDisplays().map((d) => d.workArea)
  )
  const w = new BrowserWindow({
    width: place.width,
    height: place.height,
    ...(place.x !== undefined && place.y !== undefined ? { x: place.x, y: place.y } : {}),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    backgroundColor: windowBackground(),
    webPreferences: {
      // o tema já vai junto (o preload aplica antes da primeira pintura)
      additionalArguments: [`${THEME_ARG}${theme}`],
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // a janela nunca sai da interface do app: links de mensagens abrem no navegador padrão
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e, url) => {
    if (isAppUrl(url, appOrigin)) return
    e.preventDefault()
    if (isExternalHttpUrl(url)) void shell.openExternal(url)
  })
  w.webContents.on('will-redirect', (e, url) => {
    if (!isAppUrl(url, appOrigin)) e.preventDefault()
  })
  w.webContents.on('will-attach-webview', (e) => e.preventDefault())
  // maximiza antes de mostrar (sem piscar no tamanho normal); `maximize()` já mostra a janela
  w.once('ready-to-show', () => {
    if (place.maximize) w.maximize()
    w.show()
  })
  // guarda maximizada ou não + o tamanho normal (com uma pausa: arrastar dispara muitos eventos)
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const saveNow = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    if (w.isDestroyed() || w.isFullScreen() || w.isMinimized()) return
    try {
      store.set(serializeWindowState({ maximized: w.isMaximized(), bounds: w.getNormalBounds() }))
    } catch {
      // banco fechado (saindo): fica o último estado salvo
    }
  }
  const saveSoon = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(saveNow, 400)
  }
  w.on('maximize', saveNow)
  w.on('unmaximize', saveNow)
  w.on('resize', saveSoon)
  w.on('move', saveSoon)
  // fechar a janela só esconde: o app continua lendo o WhatsApp na bandeja
  w.on('close', (e) => {
    saveNow()
    if (!quitting) {
      e.preventDefault()
      w.hide()
    }
  })
  if (appOrigin.devUrl) void w.loadURL(appOrigin.devUrl)
  else void w.loadFile(appOrigin.indexFile)
  return w
}

function updateTrayMenu(paused: boolean): void {
  if (!tray) return
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir', click: showWindow },
      {
        label: paused ? 'Retomar' : 'Pausar',
        click: () => void (paused ? service?.resumeAll() : service?.pauseAll())?.catch(() => {})
      },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() }
    ])
  )
}

function applyLoginItem(openAtLogin: boolean): void {
  // em desenvolvimento registraria o electron.exe; só no app instalado
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin })
}

function main(): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', showWindow)

  diagLog.write(
    'startup',
    Object.entries(versionsHeader())
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
  )

  app.whenReady().then(async () => {
    // `SAGA_FAKE_WA=1`: sem rede, com dados de demonstração num banco temporário (nunca no banco real)
    const fake = process.env['SAGA_FAKE_WA'] === '1' && !app.isPackaged
    const FakeWa = fake ? (await import('./fakeWa')).FakeWaClient : null
    const data = fake ? mkdtempSync(join(tmpdir(), 'saga-fake-')) : app.getPath('userData')
    const mediaDir = join(data, 'media')
    const db = openDb(join(data, 'saga.db'))
    const repo = new Repo(db)
    // todo evento do app também vai para o registro de diagnóstico (menos os que trazem números de contato)
    const logEventToDb = repo.logEvent.bind(repo)
    repo.logEvent = (kind: string, detail: string) => {
      if (kind !== 'fetch_profile_skipped') diagLog.write(`event:${kind}`, detail)
      logEventToDb(kind, detail)
    }
    const settings = createSettingsStore(repo)
    const svc = new SagaService({
      repo,
      settings,
      paths: { authDir: join(data, 'auth'), backupDir: join(data, 'auth-backup'), mediaDir },
      waClientFactory: FakeWa ? () => new FakeWa(repo) : undefined,
      diag: (kind, detail) => diagLog.write(kind, detail),
      appVersion: app.getVersion(),
      cipher: safeStorageCipher
    })
    service = svc

    protocol.handle(MEDIA_SCHEME, (req) => {
      const file = resolveMediaPath(mediaDir, req.url)
      if (!file || !existsSync(file)) return new Response('não encontrado', { status: 404 })
      return net.fetch(pathToFileURL(file).toString())
    })

    let updater: Updater | null = null

    // para a fila (espera o job atual por até 5 s), desconecta o WhatsApp (até 5 s) e fecha o banco; uma vez só
    let shutdown: Promise<void> | null = null
    const shutdownOnce = (): Promise<void> =>
      (shutdown ??= svc
        .stop({ timeoutMs: 5_000 })
        .catch(() => {})
        .finally(() => {
          stopped = true
          try {
            db.close()
          } catch {
            // já fechado
          }
          if (fake) rmSync(data, { recursive: true, force: true })
        }))

    // cópia automática semanal (Configurações › Cópia de segurança): confere de vez em quando e só roda com o
    // computador parado há uns minutos ou a janela escondida, para não pesar enquanto o mentor usa
    const AUTO_BACKUP_CHECK_MS = 30 * 60_000
    const tryAutoBackup = () => {
      if (quitting || stopped) return
      const idle = powerMonitor.getSystemIdleTime() >= 120 || !win || !win.isVisible()
      if (!idle) return
      try {
        svc.backup.runAutoIfDue()
      } catch (err) {
        diagLog.write('auto_backup', `erro ${err instanceof Error ? err.name : 'desconhecido'}`)
      }
    }
    setTimeout(tryAutoBackup, 3 * 60_000).unref?.()
    setInterval(tryAutoBackup, AUTO_BACKUP_CHECK_MS).unref?.()

    registerIpc(svc, {
      onAutoBackupChanged: () => setTimeout(tryAutoBackup, 5_000),
      onDownloadUpdate: async () => updater?.download(),
      onCheckForUpdates: async () => (updater ? updater.checkNow() : svc.state().updateCheck),
      onInstallUpdate: async () => {
        const u = updater
        if (!u?.isReady()) return
        // fecha tudo com cuidado antes: o instalador encontra o banco e a sessão do WhatsApp gravados
        quitting = true
        try {
          await shutdownOnce()
          if (!u.install()) app.quit()
        } catch (err) {
          // o banco já pode estar fechado: nunca deixar o app aberto assim
          console.warn('[saga] falha ao instalar a atualização:', err instanceof Error ? err.message.slice(0, 300) : err)
          app.quit()
        }
      },
      getWindow: () => win,
      isTrustedSender: (url) => isAppUrl(url, appOrigin),
      onRefused: (method, url) => {
        // só o método e a URL do remetente (sem argumentos: podem conter chaves ou mensagens)
        const detail = `${method} de ${url === null ? '(sem frame)' : url.slice(0, 300)}`
        console.warn(`[saga] IPC recusado: ${detail}`)
        repo.logEvent('ipc_refused', detail)
      },
      onSettingsSaved: () => {
        const s = settings.get()
        applyLoginItem(s.startWithWindows)
        applyNativeTheme(s.theme)
      },
      getDiagnostics: () => {
        const lines = diagLog.tail(200).length
        return { text: diagnosticsText(diagLog, versionsHeader(), 200), lines }
      },
      openLogsFolder: async () => {
        mkdirSync(diagLog.dir, { recursive: true })
        const err = await shell.openPath(diagLog.dir)
        if (err) diagLog.write('open_logs_error', err)
      }
    })
    applyLoginItem(settings.get().startWithWindows)
    const updates = updatesEnabled(process.env, app.isPackaged)
    diagLog.write('update_config', updates ? 'ativas' : `desligadas (empacotado=${app.isPackaged ? 'sim' : 'não'}, SAGA_UPDATES=${process.env['SAGA_UPDATES'] ?? '-'})`)
    svc.setUpdateCheck(initialUpdaterModel(app.getVersion(), false).check)
    if (updates) {
      updater = startUpdater({
        currentVersion: app.getVersion(),
        setModel: (m) => {
          svc.setUpdateCheck(m.check)
          svc.setUpdate(m.update)
        },
        diag: (k, d) => diagLog.write(k, d),
        event: (k, d) => repo.logEvent(k, d)
      })
    }

    const theme = settings.theme()
    applyNativeTheme(theme)
    win = createWindow(theme, {
      get: () => repo.getSetting(WINDOW_STATE_KEY),
      set: (v) => repo.setSetting(WINDOW_STATE_KEY, v)
    })
    // abrir a janela (inclusive pela bandeja) também procura uma versão nova, se a última procura foi há um tempo
    win.on('show', () => updater?.onActivity())
    win.on('focus', () => updater?.onActivity())
    tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON))
    tray.setToolTip('Saga')
    tray.on('click', showWindow)
    updateTrayMenu(false)
    let lastPaused = false
    svc.onState((s) => {
      if (s.paused !== lastPaused) {
        lastPaused = s.paused
        updateTrayMenu(s.paused)
      }
    })

    let suspendedAt: number | null = null
    powerMonitor.on('suspend', () => {
      suspendedAt = Date.now()
    })
    powerMonitor.on('resume', () => {
      const slept = suspendedAt === null ? 0 : Date.now() - suspendedAt
      suspendedAt = null
      if (!quitting) svc.onResumeFromSleep(slept)
      if (!quitting) updater?.onActivity()
    })

    // ao sair: desliga tudo com cuidado (shutdownOnce) e só então deixa o app fechar
    app.on('before-quit', (e) => {
      quitting = true
      if (stopped) return
      e.preventDefault()
      if (shutdown) return
      void shutdownOnce().then(() => app.quit())
    })

    // falha no início: o serviço registra (evento + arquivo) e mostra `startError` na interface
    svc.start().catch((err) => diagLog.write('start_failed', errDetail(err)))
  })

  // com a janela fechada o app segue na bandeja; sair é pelo menu "Sair"
  app.on('window-all-closed', () => {})
}

main()
