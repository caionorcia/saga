import electronUpdater from 'electron-updater'
import type { UpdateCheck } from '../shared/api'
import {
  FIRST_CHECK_MS,
  initialUpdaterModel,
  nextCheckDelay,
  progressBucket,
  reduceUpdater,
  shortError,
  shouldCheckOnActivity,
  updaterLogLine,
  type UpdaterEvent,
  type UpdaterModel
} from './updaterState'

export interface UpdaterDeps {
  currentVersion: string
  /** o estado mudou: vai para a interface (`AppState.update` e `AppState.updateCheck`) */
  setModel: (m: UpdaterModel) => void
  /** registro de diagnóstico (arquivo): todos os eventos do atualizador */
  diag: (kind: string, detail: string) => void
  /** eventos que também aparecem em "Eventos recentes" (versão nova, erro, baixada) */
  event: (kind: string, detail: string) => void
  now?: () => number
}

export interface Updater {
  /** o usuário clicou em "Atualizar": baixa; a instalação acontece ao fechar o app */
  download: () => Promise<void>
  /** a nova versão já foi baixada */
  isReady: () => boolean
  /** "Reiniciar e atualizar": fecha, instala e abre de novo. `false` (nada feito) se ainda não foi baixada. */
  install: () => boolean
  /** "Verificar agora": procura já e devolve o resultado */
  checkNow: () => Promise<UpdateCheck>
  /** a janela foi aberta ou o PC voltou da suspensão: procura se a última procura foi há algum tempo */
  onActivity: () => void
}

/** Atualizações só no app instalado, e podem ser desligadas com `SAGA_UPDATES=off` (ex.: repositório privado). */
export function updatesEnabled(env: NodeJS.ProcessEnv, packaged: boolean): boolean {
  return packaged && env['SAGA_UPDATES'] !== 'off'
}

const IN_EVENTS = new Set(['update_available', 'update_error', 'update_downloaded'])

/**
 * Liga o `electron-updater` (GitHub Releases, `app-update.yml` gerado pelo electron-builder). Procura 30 s depois de
 * abrir, depois a cada 1 h (10 min depois de uma falha), ao abrir a janela e ao voltar da suspensão (se a última
 * procura foi há mais de 20 min) e quando o usuário pede ("Verificar agora"). Cada evento vai para o registro.
 */
export function startUpdater(deps: UpdaterDeps): Updater {
  const { autoUpdater } = electronUpdater
  const now = deps.now ?? Date.now
  let model = initialUpdaterModel(deps.currentVersion, true)
  let lastBucket = -1
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<UpdateCheck> | null = null

  const apply = (e: UpdaterEvent) => {
    const line = updaterLogLine(e, lastBucket)
    if (e.type === 'progress') {
      if (line) lastBucket = progressBucket(e.percent)
    } else if (e.type === 'download_started' || e.type === 'downloaded') lastBucket = -1
    if (line) {
      const [kind, detail] = line
      try {
        if (IN_EVENTS.has(kind)) deps.event(kind, detail)
        else deps.diag(kind, detail)
      } catch {
        // registrar nunca derruba o atualizador
      }
    }
    model = reduceUpdater(model, e)
    deps.setModel(model)
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => apply({ type: 'checking' }))
  autoUpdater.on('update-available', (info) => apply({ type: 'available', version: String(info?.version ?? '?'), at: now() }))
  autoUpdater.on('update-not-available', (info) =>
    apply({ type: 'not_available', version: info?.version ? String(info.version) : null, at: now() })
  )
  autoUpdater.on('download-progress', (p) => apply({ type: 'progress', percent: Number(p?.percent ?? 0) }))
  autoUpdater.on('update-downloaded', (info) => apply({ type: 'downloaded', version: String(info?.version ?? '?') }))
  autoUpdater.on('error', (err) => apply({ type: 'error', message: shortError(err), at: now() }))

  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void check(), ms)
    timer.unref?.()
  }

  const check = (): Promise<UpdateCheck> => {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        const r = await autoUpdater.checkForUpdates()
        // `null` = o atualizador se recusou a procurar (ex.: sem app-update.yml): nunca deixa "procurando" preso
        if (r === null) apply({ type: 'error', message: 'o atualizador não está ativo neste app', at: now() })
      } catch (err) {
        // o `electron-updater` já emitiu 'error'; garante o estado se não emitiu
        if (model.check.checking) apply({ type: 'error', message: shortError(err), at: now() })
      } finally {
        inFlight = null
        schedule(nextCheckDelay(model.check.lastResult))
      }
      return model.check
    })()
    return inFlight
  }

  deps.setModel(model)
  schedule(FIRST_CHECK_MS)

  return {
    async download() {
      if (model.update.status !== 'available') return
      apply({ type: 'download_started' })
      await autoUpdater.downloadUpdate().catch(() => {})
    },
    isReady: () => model.update.status === 'ready',
    install() {
      if (model.update.status !== 'ready') return false
      // isSilent=false (mostra o instalador), isForceRunAfter=true (abre o SagaZap de novo)
      autoUpdater.quitAndInstall(false, true)
      return true
    },
    checkNow: () => check(),
    onActivity() {
      if (!inFlight && shouldCheckOnActivity(model.check, now())) void check()
    }
  }
}
