/**
 * Tamanho e posição da janela principal (v0.3.1): abre maximizada por padrão; se o mentor tirou do maximizado, a
 * próxima abertura volta do mesmo jeito (tamanho e posição "normais"). Regras puras, sem o Electron, para testar.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  /** abrir maximizada (padrão: sim) */
  maximized: boolean
  /** tamanho e posição fora do maximizado; null = o padrão, centralizada */
  bounds: Rect | null
}

/** chave em `settings_kv` */
export const WINDOW_STATE_KEY = 'window.state'
export const DEFAULT_SIZE = { width: 1100, height: 760 } as const
export const MIN_SIZE = { width: 800, height: 560 } as const
/** quanto da janela precisa ficar dentro de uma tela para a posição valer */
const MIN_VISIBLE = { width: 120, height: 80 } as const

export const DEFAULT_WINDOW_STATE: WindowState = { maximized: true, bounds: null }

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function asRect(v: unknown): Rect | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (!isNum(r.x) || !isNum(r.y) || !isNum(r.width) || !isNum(r.height)) return null
  if (r.width <= 0 || r.height <= 0) return null
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
}

/** Lê o que foi salvo; qualquer coisa estranha vira o padrão (maximizada). */
export function parseWindowState(raw: string | null | undefined): WindowState {
  if (!raw) return { ...DEFAULT_WINDOW_STATE }
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    if (!v || typeof v !== 'object') return { ...DEFAULT_WINDOW_STATE }
    return { maximized: v.maximized !== false, bounds: asRect(v.bounds) }
  } catch {
    return { ...DEFAULT_WINDOW_STATE }
  }
}

export function serializeWindowState(s: WindowState): string {
  return JSON.stringify({ maximized: s.maximized, bounds: s.bounds })
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return { width: Math.max(0, w), height: Math.max(0, h) }
}

/**
 * Encaixa o retângulo salvo numa tela que existe agora (o monitor pode ter sido desligado ou a resolução mudou):
 * a tela com mais área em comum; o tamanho cabe na área útil dela e a janela fica toda dentro. Se nenhuma tela mostra
 * um pedaço útil da janela, devolve null (abre centralizada na tela principal).
 */
export function clampToDisplays(bounds: Rect | null, workAreas: ReadonlyArray<Rect>): Rect | null {
  if (!bounds || workAreas.length === 0) return null
  let best: Rect | null = null
  let bestArea = 0
  for (const wa of workAreas) {
    const o = overlap(bounds, wa)
    const area = o.width * o.height
    if (o.width >= MIN_VISIBLE.width && o.height >= MIN_VISIBLE.height && area > bestArea) {
      best = wa
      bestArea = area
    }
  }
  if (!best) return null
  const width = Math.max(Math.min(bounds.width, best.width), Math.min(MIN_SIZE.width, best.width))
  const height = Math.max(Math.min(bounds.height, best.height), Math.min(MIN_SIZE.height, best.height))
  const x = Math.min(Math.max(bounds.x, best.x), best.x + best.width - width)
  const y = Math.min(Math.max(bounds.y, best.y), best.y + best.height - height)
  return { x, y, width, height }
}

/** Opções de tamanho/posição para criar a janela (`BrowserWindow`) a partir do estado salvo e das telas atuais. */
export function windowCreateOptions(
  s: WindowState,
  workAreas: ReadonlyArray<Rect>
): { width: number; height: number; x?: number; y?: number; maximize: boolean } {
  const b = clampToDisplays(s.bounds, workAreas)
  if (!b) return { ...DEFAULT_SIZE, maximize: s.maximized }
  return { ...b, maximize: s.maximized }
}
