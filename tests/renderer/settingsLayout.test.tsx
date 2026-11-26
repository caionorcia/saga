// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Settings } from '../../src/renderer/src/components/Settings'
import { createFakeSaga } from '../../src/renderer/src/dev/fakeSaga'

afterEach(() => cleanup())

const css = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')

/** Declarações da regra cujo seletor é exatamente `selector` (juntas, se houver mais de uma). */
function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...css.matchAll(new RegExp(`(?:^|\\n|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]).join(';')
}

/** Classes simples (`.nome { … overflow: auto }`) que criam uma área rolável. */
function scrollClasses(): string[] {
  const out = new Set<string>()
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/overflow(-y)?\s*:\s*(auto|scroll)/.test(m[2])) continue
    for (const sel of m[1].split(',')) {
      const t = sel.trim()
      if (/^\.[\w-]+$/.test(t)) out.add(t.slice(1))
    }
  }
  return [...out]
}

describe('Configurações: uma barra de rolagem só (v0.8.2)', () => {
  it('a área rolável prende os elementos absolutos (.sr-only) e a janela não rola', () => {
    const s = rule('.settings')
    expect(s).toMatch(/overflow-y:\s*auto/)
    // sem isso, a legenda .sr-only (position: absolute) esticava a página e aparecia uma segunda barra
    expect(s).toMatch(/position:\s*relative/)
    expect(s).toMatch(/min-height:\s*0/)
    expect(rule('body')).toMatch(/overflow:\s*hidden/)
  })

  it('nada dentro das configurações cria outra área rolável', async () => {
    window.saga = createFakeSaga().api
    const { container } = render(<Settings />)
    await screen.findByRole('region', { name: 'Atualizações' })
    await screen.findByRole('region', { name: 'Copiloto da Saga' })
    const main = container.querySelector('main.settings') as HTMLElement
    const nested = scrollClasses()
      .filter((c) => c !== 'settings')
      .filter((c) => main.querySelector(`.${c}`))
    expect(nested).toEqual([])
    // os absolutos ficam dentro da área rolável
    expect(main.querySelectorAll('.sr-only').length).toBeGreaterThan(0)
  })

  it('menu lateral com os seis grupos, cada um levando ao seu grupo', async () => {
    window.saga = createFakeSaga().api
    render(<Settings />)
    const nav = await screen.findByRole('navigation', { name: 'Partes das configurações' })
    const links = within(nav).getAllByRole('link')
    expect(links.map((l) => l.textContent)).toEqual([
      'Inteligência artificial',
      'Envio de mensagens',
      'Copiloto da Saga',
      'Base de conhecimento',
      'Cópia de segurança',
      'Aplicativo'
    ])
    await screen.findByRole('region', { name: 'Copiloto da Saga' })
    for (const l of links) expect(document.getElementById(l.getAttribute('href')!.slice(1))).toBeTruthy()
    fireEvent.click(within(nav).getByRole('link', { name: 'Aplicativo' }))
    await waitFor(() => expect(within(nav).getByRole('link', { name: 'Aplicativo' }).getAttribute('aria-current')).toBe('true'))
  })
})
