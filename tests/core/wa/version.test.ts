import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../../src/core/clock'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { WA_VERSION_KEY, WaVersionResolver, type WaWebVersion, type WaVersionFetcher } from '../../../src/core/wa/version'

const NOW = 1_764_000_000_000
const HOUR = 3_600_000
const BUNDLED: WaWebVersion = [2, 3000, 1043857760]
const FRESH: WaWebVersion = [2, 3000, 1099999999]

function setup(fetcher: WaVersionFetcher) {
  const clock = new FakeClock(NOW)
  const repo = new Repo(openDb(':memory:'), clock)
  const f = vi.fn(fetcher)
  return { clock, repo, f, r: new WaVersionResolver(repo, clock, f) }
}

const ok = async () => ({ version: FRESH, isLatest: true })
const fail = async () => ({ version: BUNDLED, isLatest: false, error: new Error('Failed to fetch sw.js: Forbidden') })

describe('WaVersionResolver', () => {
  it('busca, guarda no settings_kv e usa o cache por 24 h', async () => {
    const { r, f, clock, repo } = setup(ok)
    expect(await r.resolve()).toEqual({ version: FRESH, source: 'fetched' })
    expect(JSON.parse(repo.getSetting(WA_VERSION_KEY)!)).toEqual({ version: FRESH, at: NOW })
    clock.advance(23 * HOUR)
    expect(await r.resolve()).toEqual({ version: FRESH, source: 'cache' })
    expect(f).toHaveBeenCalledTimes(1)
    clock.advance(2 * HOUR)
    expect((await r.resolve()).source).toBe('fetched')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('force ignora o cache', async () => {
    const { r, f } = setup(ok)
    await r.resolve()
    expect((await r.resolve({ force: true })).source).toBe('fetched')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('falha sem cache: versão embutida do Baileys (undefined) com o motivo', async () => {
    const { r, repo } = setup(fail)
    const v = await r.resolve()
    expect(v).toMatchObject({ version: undefined, source: 'default' })
    expect(v.error).toMatch(/sw\.js/)
    expect(repo.getSetting(WA_VERSION_KEY)).toBeNull()
  })

  it('falha (resultado ou exceção) com cache velho: usa o cache velho', async () => {
    let mode: 'ok' | 'fail' | 'throw' = 'ok'
    const { r, clock } = setup(async () => {
      if (mode === 'throw') throw new Error('offline')
      return mode === 'ok' ? ok() : fail()
    })
    await r.resolve()
    clock.advance(48 * HOUR)
    mode = 'fail'
    expect(await r.resolve()).toMatchObject({ version: FRESH, source: 'stale_cache' })
    mode = 'throw'
    expect(await r.resolve({ force: true })).toMatchObject({ version: FRESH, source: 'stale_cache', error: 'offline' })
  })

  it('cache corrompido ou versão inválida são ignorados', async () => {
    const { r, repo } = setup(async () => ({ version: [2, 3000, 0] as WaWebVersion, isLatest: true }))
    repo.setSetting(WA_VERSION_KEY, '{lixo')
    expect(await r.resolve()).toMatchObject({ version: undefined, source: 'default' })
  })

  it('relógio do PC voltou no tempo: busca de novo', async () => {
    const { r, f, repo } = setup(ok)
    repo.setSetting(WA_VERSION_KEY, JSON.stringify({ version: FRESH, at: NOW + 10 * HOUR }))
    await r.resolve()
    expect(f).toHaveBeenCalledTimes(1)
  })
})
