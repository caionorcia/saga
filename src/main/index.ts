import { app, BrowserWindow, Menu, nativeImage, net, powerMonitor, protocol, shell, Tray } from 'electron'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openDb } from '../core/db/db'
import { Repo } from '../core/db/repo'
import { MEDIA_SCHEME, resolveMediaPath } from '../core/media'
import { SagaService } from '../core/service'
import { isAppUrl, isExternalHttpUrl, type AppOrigin } from './guards'
import { registerIpc } from './ipc'
import { createSettingsStore } from './settings'

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

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: {
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
  w.once('ready-to-show', () => w.show())
  // fechar a janela só esconde: o app continua lendo o WhatsApp na bandeja
  w.on('close', (e) => {
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

  app.whenReady().then(async () => {
    // `SAGA_FAKE_WA=1`: sem rede, com dados de demonstração num banco temporário (nunca no banco real)
    const fake = process.env['SAGA_FAKE_WA'] === '1'
    const FakeWa = fake ? (await import('./fakeWa')).FakeWaClient : null
    const data = fake ? mkdtempSync(join(tmpdir(), 'saga-fake-')) : app.getPath('userData')
    const mediaDir = join(data, 'media')
    const db = openDb(join(data, 'saga.db'))
    const repo = new Repo(db)
    const settings = createSettingsStore(repo)
    const svc = new SagaService({
      repo,
      settings,
      paths: { authDir: join(data, 'auth'), backupDir: join(data, 'auth-backup'), mediaDir },
      waClientFactory: FakeWa ? () => new FakeWa(repo) : undefined
    })
    service = svc

    protocol.handle(MEDIA_SCHEME, (req) => {
      const file = resolveMediaPath(mediaDir, req.url)
      if (!file || !existsSync(file)) return new Response('não encontrado', { status: 404 })
      return net.fetch(pathToFileURL(file).toString())
    })

    registerIpc(svc, {
      getWindow: () => win,
      isTrustedSender: (url) => isAppUrl(url, appOrigin),
      onRefused: (method, url) => {
        // só o método e a URL do remetente (sem argumentos: podem conter chaves ou mensagens)
        const detail = `${method} de ${url === null ? '(sem frame)' : url.slice(0, 300)}`
        console.warn(`[saga] IPC recusado: ${detail}`)
        repo.logEvent('ipc_refused', detail)
      },
      onSettingsSaved: () => applyLoginItem(settings.get().startWithWindows)
    })
    applyLoginItem(settings.get().startWithWindows)

    win = createWindow()
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
    })

    // ao sair: para a fila (espera o job atual por até 5 s), desconecta o WhatsApp (até 5 s) e fecha o banco
    let shuttingDown = false
    app.on('before-quit', (e) => {
      quitting = true
      if (stopped) return
      e.preventDefault()
      if (shuttingDown) return
      shuttingDown = true
      void svc
        .stop({ timeoutMs: 5_000 })
        .catch(() => {})
        .finally(() => {
          stopped = true
          try {
            db.close()
          } catch {
            // já fechado
          }
          app.quit()
        })
    })

    svc.start().catch((err) => {
      try {
        repo.logEvent('start_error', err instanceof Error ? err.message : String(err))
      } catch {
        // banco já fechado (saindo)
      }
    })
  })

  // com a janela fechada o app segue na bandeja; sair é pelo menu "Sair"
  app.on('window-all-closed', () => {})
}

main()
