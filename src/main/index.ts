import { app, BrowserWindow, Menu, nativeImage, net, powerMonitor, protocol, Tray } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openDb } from '../core/db/db'
import { Repo } from '../core/db/repo'
import { MEDIA_SCHEME, resolveMediaPath } from '../core/media'
import { SagaService } from '../core/service'
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
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  w.once('ready-to-show', () => w.show())
  // fechar a janela só esconde: o app continua lendo o WhatsApp na bandeja
  w.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      w.hide()
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) void w.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void w.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  return w
}

function updateTrayMenu(paused: boolean): void {
  if (!tray) return
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir', click: showWindow },
      {
        label: paused ? 'Retomar' : 'Pausar',
        click: () => void (paused ? service?.resumeAll() : service?.pauseAll())
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

  app.whenReady().then(() => {
    const data = app.getPath('userData')
    const mediaDir = join(data, 'media')
    const db = openDb(join(data, 'saga.db'))
    const repo = new Repo(db)
    const settings = createSettingsStore(repo)
    const svc = new SagaService({
      repo,
      settings,
      paths: { authDir: join(data, 'auth'), backupDir: join(data, 'auth-backup'), mediaDir }
    })
    service = svc

    protocol.handle(MEDIA_SCHEME, (req) => {
      const file = resolveMediaPath(mediaDir, req.url)
      if (!file || !existsSync(file)) return new Response('não encontrado', { status: 404 })
      return net.fetch(pathToFileURL(file).toString())
    })

    registerIpc(svc, {
      getWindow: () => win,
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
      svc.onResumeFromSleep(slept)
    })

    // ao sair: para a fila (espera o job atual por até 5 s) e desconecta o WhatsApp
    app.on('before-quit', (e) => {
      quitting = true
      if (stopped) return
      e.preventDefault()
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
      repo.logEvent('start_error', err instanceof Error ? err.message : String(err))
    })
  })

  // com a janela fechada o app segue na bandeja; sair é pelo menu "Sair"
  app.on('window-all-closed', () => {})
}

main()
