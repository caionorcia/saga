import { describe, expect, it, vi } from 'vitest'

vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }))
import { updatesEnabled } from '../../src/main/updater'

describe('updatesEnabled', () => {
  it('só no app instalado e sem SAGA_UPDATES=off', () => {
    expect(updatesEnabled({}, true)).toBe(true)
    expect(updatesEnabled({}, false)).toBe(false)
    expect(updatesEnabled({ SAGA_UPDATES: 'off' }, true)).toBe(false)
    expect(updatesEnabled({ SAGA_UPDATES: 'on' }, true)).toBe(true)
  })
})
