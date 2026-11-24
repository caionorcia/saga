import type { Clock } from '../clock'
import type { Repo } from '../db/repo'

/** Versão do WhatsApp Web que o socket anuncia: `[2, 3000, revisão]`. */
export type WaWebVersion = [number, number, number]

/**
 * Formato do `fetchLatestWaWebVersion()` do Baileys: ele nunca lança; em falha devolve
 * a versão embutida com `isLatest: false` e `error`.
 */
export type WaVersionFetcher = () => Promise<{ version: WaWebVersion; isLatest: boolean; error?: unknown }>

export type WaVersionSource = 'cache' | 'fetched' | 'stale_cache' | 'default'

export interface ResolvedWaVersion {
  /** undefined = deixar o Baileys usar a versão embutida */
  version: WaWebVersion | undefined
  source: WaVersionSource
  /** por que a busca falhou (sem dados sensíveis), quando falhou */
  error?: string
}

export const WA_VERSION_KEY = 'wa.webVersion'
export const WA_VERSION_TTL_MS = 24 * 3_600_000

const isVersion = (v: unknown): v is WaWebVersion =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0) && v[2] > 0

const errText = (e: unknown): string => {
  if (e instanceof Error) return e.message
  const m = (e as { message?: unknown } | null)?.message
  return typeof m === 'string' ? m : String(e)
}

export const formatWaVersion = (v: WaWebVersion | undefined): string => (v ? v.join('.') : 'padrão do Baileys')

/**
 * Descobre a versão atual do WhatsApp Web (a embutida no Baileys envelhece e o WhatsApp passa a recusar a
 * conexão com 405 antes de mostrar o QR). Guarda no `settings_kv` por 24 h; se a busca falhar usa o último
 * valor guardado (mesmo velho) e, sem nada guardado, a versão embutida.
 */
export class WaVersionResolver {
  constructor(
    private readonly repo: Repo,
    private readonly clock: Clock,
    private readonly fetcher: WaVersionFetcher
  ) {}

  private cached(): { version: WaWebVersion; at: number } | null {
    try {
      const raw = this.repo.getSetting(WA_VERSION_KEY)
      if (!raw) return null
      const p = JSON.parse(raw) as { version?: unknown; at?: unknown }
      if (!isVersion(p.version) || typeof p.at !== 'number') return null
      return { version: p.version, at: p.at }
    } catch {
      return null
    }
  }

  /** `force`: ignora o cache e busca de novo (depois de um 405). */
  async resolve(opts: { force?: boolean } = {}): Promise<ResolvedWaVersion> {
    const cached = this.cached()
    const now = this.clock.now()
    if (!opts.force && cached && now - cached.at >= 0 && now - cached.at < WA_VERSION_TTL_MS) {
      return { version: cached.version, source: 'cache' }
    }
    let error: string
    try {
      const r = await this.fetcher()
      if (r.isLatest && !r.error && isVersion(r.version)) {
        this.repo.setSetting(WA_VERSION_KEY, JSON.stringify({ version: r.version, at: now }))
        return { version: r.version, source: 'fetched' }
      }
      error = r.error ? errText(r.error) : 'versão não encontrada'
    } catch (e) {
      error = errText(e)
    }
    error = error.slice(0, 200)
    if (cached) return { version: cached.version, source: 'stale_cache', error }
    return { version: undefined, source: 'default', error }
  }
}
