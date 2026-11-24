// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ColumnDivider, STORAGE_KEY, clampWidths, useColumnWidths } from '../../src/renderer/src/columns'

function Harness() {
  const c = useColumnWidths()
  return (
    <div data-testid="grid" style={c.style}>
      <ColumnDivider {...c.divider('left')} />
      <ColumnDivider {...c.divider('right')} />
    </div>
  )
}

const setWidth = (w: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w })
  window.dispatchEvent(new Event('resize'))
}
const left = () => screen.getByRole('separator', { name: /lista de contatos/ })
const right = () => screen.getByRole('separator', { name: /sugestões/ })
const cols = () => (screen.getByTestId('grid') as HTMLElement).style.gridTemplateColumns

/** jsdom não tem PointerEvent com clientX em todas as versões: usa MouseEvent com os campos do ponteiro. */
function pointer(el: Element, type: string, clientX: number) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 })
  Object.defineProperty(ev, 'pointerId', { value: 1 })
  fireEvent(el, ev)
}

beforeEach(() => {
  window.localStorage.clear()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1366 })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('colunas redimensionáveis', () => {
  it('padrão, acessível como separador vertical', () => {
    render(<Harness />)
    expect(cols()).toBe('280px 6px minmax(360px, 1fr) 6px 350px')
    expect(left().getAttribute('aria-orientation')).toBe('vertical')
    expect(left().getAttribute('aria-valuenow')).toBe('280')
    expect(right().getAttribute('aria-valuenow')).toBe('350')
    expect(left().tabIndex).toBe(0)
  })

  it('arrastar muda a largura e grava ao soltar', () => {
    render(<Harness />)
    pointer(left(), 'pointerdown', 300)
    pointer(left(), 'pointermove', 360)
    expect(left().getAttribute('aria-valuenow')).toBe('340')
    pointer(left(), 'pointerup', 380)
    expect(left().getAttribute('aria-valuenow')).toBe('360')
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual({ left: 360 })
    // a direita cresce arrastando para a esquerda
    pointer(right(), 'pointerdown', 1000)
    pointer(right(), 'pointerup', 950)
    expect(right().getAttribute('aria-valuenow')).toBe('400')
  })

  it('limites: laterais no mínimo e a conversa nunca abaixo de 360 px', () => {
    render(<Harness />)
    pointer(left(), 'pointerdown', 300)
    pointer(left(), 'pointerup', 0)
    expect(left().getAttribute('aria-valuenow')).toBe('220')
    pointer(left(), 'pointerdown', 300)
    pointer(left(), 'pointerup', 2000)
    // 1366 - 2×6 - 360 - 350 = 644
    expect(left().getAttribute('aria-valuenow')).toBe('644')
    expect(left().getAttribute('aria-valuemax')).toBe('644')
    expect(clampWidths({ left: 100, right: 100 }, 1366)).toEqual({ left: 220, right: 280 })
  })

  it('teclado: setas ajustam 16 px, Home volta ao padrão; duplo clique também', () => {
    render(<Harness />)
    fireEvent.keyDown(left(), { key: 'ArrowRight' })
    fireEvent.keyDown(left(), { key: 'ArrowRight' })
    expect(left().getAttribute('aria-valuenow')).toBe('312')
    fireEvent.keyDown(left(), { key: 'ArrowLeft' })
    expect(left().getAttribute('aria-valuenow')).toBe('296')
    fireEvent.keyDown(left(), { key: 'Home' })
    expect(left().getAttribute('aria-valuenow')).toBe('280')
    fireEvent.keyDown(right(), { key: 'ArrowLeft' })
    expect(right().getAttribute('aria-valuenow')).toBe('366')
    fireEvent.doubleClick(right())
    expect(right().getAttribute('aria-valuenow')).toBe('350')
  })

  it('lê as larguras guardadas e re-limita quando a janela diminui (sem perder a preferência)', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ left: 500, right: 400 }))
    render(<Harness />)
    expect(cols()).toBe('500px 6px minmax(360px, 1fr) 6px 400px')
    act(() => setWidth(1100))
    // 1100 - 12 - 360 = 728: a direita encolhe até o mínimo, depois a esquerda
    expect(right().getAttribute('aria-valuenow')).toBe('280')
    expect(left().getAttribute('aria-valuenow')).toBe('448')
    act(() => setWidth(1366))
    expect(left().getAttribute('aria-valuenow')).toBe('500')
    expect(right().getAttribute('aria-valuenow')).toBe('400')
  })

  it('localStorage que lança: funciona com o padrão e o ajuste vale na sessão', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado')
    })
    render(<Harness />)
    expect(left().getAttribute('aria-valuenow')).toBe('280')
    fireEvent.keyDown(left(), { key: 'ArrowRight' })
    expect(left().getAttribute('aria-valuenow')).toBe('296')
  })
})
