import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'

/**
 * Larguras das 3 colunas (contatos | conversa | sugestões), ajustáveis arrastando os divisores.
 * As larguras das laterais ficam guardadas no navegador (por pessoa); a conversa ocupa o resto
 * e nunca fica abaixo do mínimo. Sem `localStorage` (bloqueado), tudo funciona com o padrão.
 */

export type Side = 'left' | 'right'
export interface Widths {
  left: number
  right: number
}

export const MIN = { left: 220, center: 360, right: 280 } as const
/** largura de cada divisor (coluna da grade) */
export const DIVIDER_PX = 6
export const KEY_STEP = 16
export const STORAGE_KEY = 'saga.columns'

export function defaultWidths(total: number): Widths {
  return total <= 1200 ? { left: 240, right: 320 } : { left: 280, right: 350 }
}

/**
 * Laterais no mínimo delas e a conversa com pelo menos `MIN.center`. `prefer` é a lateral que está
 * sendo ajustada: só ela encolhe; sem `prefer` (janela mudou de tamanho), encolhe a direita e depois a esquerda.
 */
export function clampWidths(w: Widths, total: number, prefer?: Side): Widths {
  let left = Math.max(MIN.left, Math.round(w.left))
  let right = Math.max(MIN.right, Math.round(w.right))
  const avail = total - 2 * DIVIDER_PX - MIN.center
  if (left + right > avail) {
    if (prefer === 'left') left = Math.max(MIN.left, avail - right)
    else if (prefer === 'right') right = Math.max(MIN.right, avail - left)
    else {
      right = Math.max(MIN.right, avail - left)
      left = Math.max(MIN.left, avail - right)
    }
  }
  return { left, right }
}

/** Maior largura possível de uma lateral, com a outra como está. */
export function maxFor(side: Side, w: Widths, total: number): number {
  const avail = total - 2 * DIVIDER_PX - MIN.center
  return Math.max(MIN[side], avail - (side === 'left' ? w.right : w.left))
}

function load(): Partial<Widths> | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<Widths>
    const out: Partial<Widths> = {}
    if (Number.isFinite(v?.left)) out.left = Number(v.left)
    if (Number.isFinite(v?.right)) out.right = Number(v.right)
    return out
  } catch {
    return null
  }
}

function save(pref: Partial<Widths>): void {
  try {
    if (pref.left === undefined && pref.right === undefined) window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pref))
  } catch {
    // sem armazenamento: vale só nesta sessão
  }
}

const viewport = () => (typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1366)

export interface DividerProps {
  role: 'separator'
  tabIndex: 0
  'aria-orientation': 'vertical'
  'aria-label': string
  'aria-valuenow': number
  'aria-valuemin': number
  'aria-valuemax': number
  className: string
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: PointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: PointerEvent<HTMLDivElement>) => void
  onPointerCancel: (e: PointerEvent<HTMLDivElement>) => void
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void
  onDoubleClick: () => void
}

export function useColumnWidths(): { style: CSSProperties; widths: Widths; divider: (side: Side) => DividerProps } {
  const [total, setTotal] = useState(viewport)
  // `undefined` = largura padrão daquela lateral
  const [pref, setPref] = useState<Partial<Widths>>(() => load() ?? {})
  const drag = useRef<{ side: Side; startX: number; start: number; id: number } | null>(null)

  useEffect(() => {
    const onResize = () => setTotal(viewport())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const def = defaultWidths(total)
  const widths = clampWidths({ left: pref.left ?? def.left, right: pref.right ?? def.right }, total)

  const set = useCallback(
    (side: Side, value: number | undefined, persist: boolean) => {
      setPref((p) => {
        const next = { ...p }
        if (value === undefined) delete next[side]
        else {
          const cur = { left: p.left ?? def.left, right: p.right ?? def.right, [side]: value }
          next[side] = clampWidths(cur, total, side)[side]
        }
        if (persist) save(next)
        return next
      })
    },
    [def.left, def.right, total]
  )

  const divider = (side: Side): DividerProps => ({
    role: 'separator',
    tabIndex: 0,
    'aria-orientation': 'vertical',
    'aria-label': side === 'left' ? 'Ajustar a largura da lista de contatos' : 'Ajustar a largura das sugestões',
    'aria-valuenow': widths[side],
    'aria-valuemin': MIN[side],
    'aria-valuemax': maxFor(side, widths, total),
    className: 'col-divider',
    onPointerDown: (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId)
      } catch {
        // sem captura: o arrasto ainda funciona enquanto o ponteiro estiver sobre o divisor
      }
      drag.current = { side, startX: e.clientX, start: widths[side], id: e.pointerId }
      e.currentTarget.classList.add('dragging')
    },
    onPointerMove: (e) => {
      const d = drag.current
      if (!d || d.side !== side) return
      const delta = e.clientX - d.startX
      set(side, side === 'left' ? d.start + delta : d.start - delta, false)
    },
    onPointerUp: (e) => {
      const d = drag.current
      if (!d || d.side !== side) return
      drag.current = null
      e.currentTarget.classList.remove('dragging')
      try {
        e.currentTarget.releasePointerCapture?.(d.id)
      } catch {
        // já solto
      }
      const delta = e.clientX - d.startX
      set(side, side === 'left' ? d.start + delta : d.start - delta, true)
    },
    onPointerCancel: (e) => {
      drag.current = null
      e.currentTarget.classList.remove('dragging')
      setPref((p) => {
        save(p)
        return p
      })
    },
    onKeyDown: (e) => {
      // a seta move o divisor: na esquerda, → alarga os contatos; na direita, ← alarga as sugestões
      const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft'
      const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight'
      if (e.key === grow || e.key === shrink) {
        e.preventDefault()
        set(side, widths[side] + (e.key === grow ? KEY_STEP : -KEY_STEP), true)
      } else if (e.key === 'Home') {
        e.preventDefault()
        set(side, undefined, true)
      }
    },
    onDoubleClick: () => set(side, undefined, true)
  })

  return {
    widths,
    style: { gridTemplateColumns: `${widths.left}px ${DIVIDER_PX}px minmax(${MIN.center}px, 1fr) ${DIVIDER_PX}px ${widths.right}px` },
    divider
  }
}

export function ColumnDivider(props: DividerProps) {
  return (
    <div {...props}>
      <span className="col-grip" aria-hidden="true" />
    </div>
  )
}
