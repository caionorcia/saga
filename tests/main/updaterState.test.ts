import { describe, expect, it } from 'vitest'
import {
  CHECK_EVERY_MS,
  RETRY_AFTER_ERROR_MS,
  initialUpdaterModel,
  nextCheckDelay,
  progressBucket,
  reduceUpdater,
  shortError,
  shouldCheckOnActivity,
  updaterLogLine,
  type UpdaterEvent,
  type UpdaterModel
} from '../../src/main/updaterState'

const run = (events: UpdaterEvent[], m: UpdaterModel = initialUpdaterModel('0.2.3', true)) => events.reduce(reduceUpdater, m)

describe('reduceUpdater', () => {
  it('começa sem aviso e sem procura', () => {
    expect(initialUpdaterModel('0.2.3', true)).toEqual({
      update: { status: 'none' },
      check: { enabled: true, currentVersion: '0.2.3', checking: false, lastCheckAt: null, lastResult: null, latestVersion: null, lastError: null }
    })
  })

  it('procurando → versão nova: aviso "available" e o resultado da procura', () => {
    const m = run([{ type: 'checking' }])
    expect(m.check.checking).toBe(true)
    const n = reduceUpdater(m, { type: 'available', version: '0.2.4', at: 5 })
    expect(n.update).toEqual({ status: 'available', version: '0.2.4' })
    expect(n.check).toMatchObject({ checking: false, lastCheckAt: 5, lastResult: 'available', latestVersion: '0.2.4', lastError: null })
  })

  it('procurando → já na mais nova: sem aviso', () => {
    const m = run([{ type: 'checking' }, { type: 'not_available', version: '0.2.3', at: 7 }])
    expect(m.update).toEqual({ status: 'none' })
    expect(m.check).toMatchObject({ lastResult: 'up_to_date', latestVersion: '0.2.3', lastCheckAt: 7 })
  })

  it('erro na procura guarda o motivo e mantém o aviso que já havia', () => {
    const m = run([
      { type: 'available', version: '0.2.4', at: 1 },
      { type: 'checking' },
      { type: 'error', message: 'sem rede', at: 2 }
    ])
    expect(m.update).toEqual({ status: 'available', version: '0.2.4' })
    expect(m.check).toMatchObject({ checking: false, lastResult: 'error', lastError: 'sem rede', lastCheckAt: 2 })
  })

  it('erro no meio do download volta a oferecer "Atualizar"', () => {
    const m = run([{ type: 'available', version: '0.2.4', at: 1 }, { type: 'download_started' }, { type: 'progress', percent: 40 }])
    expect(m.update).toEqual({ status: 'downloading', version: '0.2.4', percent: 40 })
    expect(reduceUpdater(m, { type: 'error', message: 'x', at: 3 }).update).toEqual({ status: 'available', version: '0.2.4' })
  })

  it('baixada fica pronta mesmo se uma procura depois disser "já está na mais nova" ou achar a mesma versão', () => {
    const m = run([{ type: 'available', version: '0.2.4', at: 1 }, { type: 'download_started' }, { type: 'downloaded', version: '0.2.4' }])
    expect(m.update).toEqual({ status: 'ready', version: '0.2.4' })
    expect(reduceUpdater(m, { type: 'available', version: '0.2.4', at: 2 }).update.status).toBe('ready')
    expect(reduceUpdater(m, { type: 'not_available', version: '0.2.4', at: 2 }).update.status).toBe('ready')
    // uma versão ainda mais nova volta a oferecer "Atualizar"
    expect(reduceUpdater(m, { type: 'available', version: '0.2.5', at: 3 }).update).toEqual({ status: 'available', version: '0.2.5' })
  })

  it('download sem aviso não muda nada; progresso fica entre 0 e 100', () => {
    const m = initialUpdaterModel('0.2.3', true)
    expect(reduceUpdater(m, { type: 'download_started' })).toBe(m)
    expect(reduceUpdater(m, { type: 'progress', percent: 50 })).toBe(m)
    const d = run([{ type: 'available', version: '1.0.0', at: 1 }, { type: 'progress', percent: 140 }])
    expect(d.update).toEqual({ status: 'downloading', version: '1.0.0', percent: 100 })
  })
})

describe('updaterLogLine', () => {
  it('uma linha para cada evento; progresso só a cada 25%', () => {
    expect(updaterLogLine({ type: 'checking' })).toEqual(['update_checking', ''])
    expect(updaterLogLine({ type: 'available', version: '0.2.4', at: 1 })).toEqual(['update_available', 'versão 0.2.4'])
    expect(updaterLogLine({ type: 'not_available', version: '0.2.3', at: 1 })).toEqual(['update_not_available', 'mais nova publicada: 0.2.3'])
    expect(updaterLogLine({ type: 'error', message: 'falhou', at: 1 })).toEqual(['update_error', 'falhou'])
    expect(updaterLogLine({ type: 'downloaded', version: '0.2.4' })).toEqual(['update_downloaded', 'versão 0.2.4'])
    expect(updaterLogLine({ type: 'progress', percent: 30 }, -1)).toEqual(['update_download_progress', '25%'])
    expect(updaterLogLine({ type: 'progress', percent: 40 }, 25)).toBeNull()
    expect(progressBucket(99.9)).toBe(75)
    expect(progressBucket(100)).toBe(100)
  })
})

describe('shortError, quando procurar', () => {
  it('só a primeira linha do erro, curta', () => {
    expect(shortError(new Error('Cannot find latest.yml\n  at x\n  at y'))).toBe('Cannot find latest.yml')
    expect(shortError(new Error('a'.repeat(500)))).toHaveLength(200)
    expect(shortError(null)).toBe('erro desconhecido')
  })

  it('ao abrir a janela: nunca procurou ou procurou há 20 min ou mais; nunca durante uma procura nem desligado', () => {
    const c = initialUpdaterModel('0.2.3', true).check
    expect(shouldCheckOnActivity(c, 0)).toBe(true)
    expect(shouldCheckOnActivity({ ...c, lastCheckAt: 0 }, 19 * 60_000)).toBe(false)
    expect(shouldCheckOnActivity({ ...c, lastCheckAt: 0 }, 20 * 60_000)).toBe(true)
    expect(shouldCheckOnActivity({ ...c, checking: true }, 0)).toBe(false)
    expect(shouldCheckOnActivity({ ...c, enabled: false }, 0)).toBe(false)
  })

  it('próxima procura: 10 min depois de uma falha, senão 1 h', () => {
    expect(nextCheckDelay('error')).toBe(RETRY_AFTER_ERROR_MS)
    expect(nextCheckDelay('up_to_date')).toBe(CHECK_EVERY_MS)
    expect(nextCheckDelay(null)).toBe(CHECK_EVERY_MS)
  })
})
