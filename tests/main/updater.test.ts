import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ autoUpdater: null as any }))
vi.mock('electron-updater', () => ({ default: fake }))
import { startUpdater, updatesEnabled } from '../../src/main/updater'

describe('updatesEnabled', () => {
  it('só no app instalado e sem SAGA_UPDATES=off', () => {
    expect(updatesEnabled({}, true)).toBe(true)
    expect(updatesEnabled({}, false)).toBe(false)
    expect(updatesEnabled({ SAGA_UPDATES: 'off' }, true)).toBe(false)
    expect(updatesEnabled({ SAGA_UPDATES: 'on' }, true)).toBe(true)
  })
})

describe('startUpdater: reiniciar e atualizar', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fake.autoUpdater = Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn(async () => null),
      downloadUpdate: vi.fn(async () => []),
      quitAndInstall: vi.fn()
    })
  })
  afterEach(() => vi.useRealTimers())

  it('install só depois de baixada; chama quitAndInstall e avisa o estado', () => {
    const states: unknown[] = []
    const u = startUpdater({ setUpdate: (s) => states.push(s), log: () => {} })
    expect(u.install()).toBe(false)
    expect(fake.autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    fake.autoUpdater.emit('update-available', { version: '0.2.0' })
    expect(u.install()).toBe(false)
    fake.autoUpdater.emit('update-downloaded', { version: '0.2.0' })
    expect(states.at(-1)).toEqual({ status: 'ready', version: '0.2.0' })
    expect(u.isReady()).toBe(true)
    expect(u.install()).toBe(true)
    expect(fake.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})
