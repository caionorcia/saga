import electronUpdater from 'electron-updater'
import type { UpdateState } from '../shared/api'

export interface UpdaterDeps {
  setUpdate: (u: UpdateState) => void
  log: (kind: string, detail: string) => void
}

export interface Updater {
  /** o usuário clicou em "Atualizar": baixa; a instalação acontece ao fechar o app */
  download: () => Promise<void>
  /** a nova versão já foi baixada */
  isReady: () => boolean
  /** "Reiniciar e atualizar": fecha, instala e abre de novo. `false` (nada feito) se ainda não foi baixada. */
  install: () => boolean
}

/** Atualizações só no app instalado, e podem ser desligadas com `SAGA_UPDATES=off` (ex.: repositório privado). */
export function updatesEnabled(env: NodeJS.ProcessEnv, packaged: boolean): boolean {
  return packaged && env['SAGA_UPDATES'] !== 'off'
}

export function startUpdater(deps: UpdaterDeps): Updater {
  const { autoUpdater } = electronUpdater
  let version: string | null = null
  let ready = false
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', (info) => {
    version = info.version
    deps.setUpdate({ status: 'available', version: info.version })
  })
  autoUpdater.on('update-downloaded', (info) => {
    ready = true
    deps.setUpdate({ status: 'ready', version: info.version })
  })
  autoUpdater.on('error', (err) => {
    deps.log('update_error', err instanceof Error ? err.message.slice(0, 300) : 'erro desconhecido')
    // se falhou no download, volta a oferecer o botão
    if (version) deps.setUpdate({ status: 'available', version })
  })

  const check = () => void autoUpdater.checkForUpdates().catch(() => {})
  setTimeout(check, 30_000)
  setInterval(check, 6 * 3_600_000).unref()

  return {
    async download() {
      if (!version) return
      deps.setUpdate({ status: 'downloading', version })
      await autoUpdater.downloadUpdate().catch(() => {})
    },
    isReady: () => ready,
    install() {
      if (!ready) return false
      // isSilent=false (mostra o instalador), isForceRunAfter=true (abre o Saga de novo)
      autoUpdater.quitAndInstall(false, true)
      return true
    }
  }
}

