import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ autoUpdater: null as any }))
vi.mock('electron-updater', () => ({ default: fake }))
import { startUpdater, updatesEnabled } from '../../src/main/updater'
import type { UpdaterModel } from '../../src/main/updaterState'

describe('updatesEnabled', () => {
  it('só no app instalado e sem SAGA_UPDATES=off', () => {
    expect(updatesEnabled({}, true)).toBe(true)
    expect(updatesEnabled({}, false)).toBe(false)
    expect(updatesEnabled({ SAGA_UPDATES: 'off' }, true)).toBe(false)
    expect(updatesEnabled({ SAGA_UPDATES: 'on' }, true)).toBe(true)
  })
})

describe('startUpdater', () => {
  let models: UpdaterModel[]
  let diag: Array<[string, string]>
  let events: Array<[string, string]>
  let clock: number
  let result: 'available' | 'none' | 'error' | 'null'

  const start = () =>
    startUpdater({
      currentVersion: '0.2.3',
      setModel: (m) => models.push(m),
      diag: (k, d) => diag.push([k, d]),
      event: (k, d) => events.push([k, d]),
      now: () => clock
    })
  const last = () => models.at(-1)!

  beforeEach(() => {
    vi.useFakeTimers()
    models = []
    diag = []
    events = []
    clock = 1_000_000
    result = 'none'
    const au: any = Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn(async () => {
        au.emit('checking-for-update')
        if (result === 'null') return null
        if (result === 'error') {
          const e = new Error('net::ERR_INTERNET_DISCONNECTED\nstack…')
          au.emit('error', e)
          throw e
        }
        if (result === 'available') au.emit('update-available', { version: '0.2.4' })
        else au.emit('update-not-available', { version: '0.2.3' })
        return { updateInfo: { version: result === 'available' ? '0.2.4' : '0.2.3' } }
      }),
      downloadUpdate: vi.fn(async () => []),
      quitAndInstall: vi.fn()
    })
    fake.autoUpdater = au
  })
  afterEach(() => vi.useRealTimers())

  it('install só depois de baixada; chama quitAndInstall e avisa o estado', () => {
    const u = start()
    expect(u.install()).toBe(false)
    fake.autoUpdater.emit('update-available', { version: '0.2.0' })
    expect(u.install()).toBe(false)
    fake.autoUpdater.emit('update-downloaded', { version: '0.2.0' })
    expect(last().update).toEqual({ status: 'ready', version: '0.2.0' })
    expect(u.isReady()).toBe(true)
    expect(u.install()).toBe(true)
    expect(fake.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('procura 30 s depois de abrir e depois a cada 1 h; registra cada procura no diagnóstico', async () => {
    start()
    expect(last().check).toMatchObject({ enabled: true, currentVersion: '0.2.3', lastCheckAt: null })
    await vi.advanceTimersByTimeAsync(29_000)
    expect(fake.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fake.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(last().check).toMatchObject({ checking: false, lastResult: 'up_to_date', latestVersion: '0.2.3', lastCheckAt: clock })
    expect(diag.map(([k]) => k)).toEqual(['update_checking', 'update_not_available'])
    await vi.advanceTimersByTimeAsync(59 * 60_000)
    expect(fake.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('versão nova: aviso na barra, evento em "Eventos recentes"', async () => {
    result = 'available'
    const u = start()
    const c = await u.checkNow()
    expect(c).toMatchObject({ lastResult: 'available', latestVersion: '0.2.4' })
    expect(last().update).toEqual({ status: 'available', version: '0.2.4' })
    expect(events).toEqual([['update_available', 'versão 0.2.4']])
  })

  it('falha (sem internet): guarda o motivo curto, registra e tenta de novo em 10 min', async () => {
    result = 'error'
    const u = start()
    const c = await u.checkNow()
    expect(c).toMatchObject({ lastResult: 'error', lastError: 'net::ERR_INTERNET_DISCONNECTED', checking: false })
    expect(events).toEqual([['update_error', 'net::ERR_INTERNET_DISCONNECTED']])
    result = 'none'
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(fake.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(last().check.lastResult).toBe('up_to_date')
  })

  it('atualizador inativo (checkForUpdates devolve null) não fica "procurando" para sempre', async () => {
    result = 'null'
    const c = await start().checkNow()
    expect(c).toMatchObject({ checking: false, lastResult: 'error' })
  })

  it('"Verificar agora" duas vezes seguidas faz uma procura só', async () => {
    const u = start()
    await Promise.all([u.checkNow(), u.checkNow()])
    expect(fake.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('abrir a janela procura só se a última procura foi há mais de 20 min', async () => {
    const u = start()
    await u.checkNow()
    clock += 5 * 60_000
    u.onActivity()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    clock += 20 * 60_000
    u.onActivity()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('download: progresso no estado e no registro a cada 25%; baixada → pronta', async () => {
    result = 'available'
    const u = start()
    await u.checkNow()
    await u.download()
    expect(last().update).toEqual({ status: 'downloading', version: '0.2.4' })
    for (const p of [3, 10, 26, 30, 51, 99]) fake.autoUpdater.emit('download-progress', { percent: p })
    expect(last().update).toEqual({ status: 'downloading', version: '0.2.4', percent: 99 })
    expect(diag.filter(([k]) => k === 'update_download_progress').map(([, d]) => d)).toEqual(['0%', '25%', '50%', '75%'])
    fake.autoUpdater.emit('update-downloaded', { version: '0.2.4' })
    expect(last().update).toEqual({ status: 'ready', version: '0.2.4' })
    expect(events.at(-1)).toEqual(['update_downloaded', 'versão 0.2.4'])
  })
})
