// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { Highlighted } from '../../src/renderer/src/components/GlobalSearch'
import { createFakeSaga, type FakeControl } from '../../src/renderer/src/dev/fakeSaga'

let ctl: FakeControl
beforeEach(() => {
  localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  ctl = createFakeSaga()
  window.saga = ctl.api
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const box = () => screen.getByLabelText('Procurar em todas as conversas e transcrições') as HTMLInputElement
const search = (q: string) => {
  fireEvent.change(box(), { target: { value: q } })
  fireEvent.submit(box().closest('form')!)
}

describe('busca geral', () => {
  it('pergunta natural: resultados por conversa, quem mandou (grupo), data e palavras destacadas', async () => {
    render(<App />)
    await screen.findByText('Ana Paula Souza', { selector: '.contact-name' })
    search('Quem falou sobre precificação?')
    const results = await screen.findByRole('region', { name: 'Resultados da busca' })
    await within(results).findByText(/mensage(m|ns) em/)
    // a lista normal sai de cena enquanto procura
    expect(document.querySelector('.contacts-list')!.hasAttribute('hidden')).toBe(true)
    const group = within(results).getByText('Mentoria Turma 3 — Negócios', { selector: '.gs-group-name' }).closest('li')!
    expect(within(group).getByText('áudio')).toBeTruthy()
    const marks = [...group.querySelectorAll('mark')].map((m) => m.textContent)
    expect(marks).toContain('precificar')
    expect(ctl.calls.find((c) => c.method === 'searchMessages')?.args[0]).toBe('Quem falou sobre precificação?')
  })

  it('clicar num resultado abre a conversa e destaca a mensagem; "Limpar" volta à lista', async () => {
    render(<App />)
    await screen.findByText('Ana Paula Souza', { selector: '.contact-name' })
    search('pacote fechado')
    const results = await screen.findByRole('region', { name: 'Resultados da busca' })
    const hit = await within(results).findByRole('button', { name: /pacote fechado/i })
    fireEvent.click(hit)
    await screen.findByRole('region', { name: /Conversa com Ana Paula Souza/ })
    await waitFor(() => expect(document.querySelector('.bubble-highlight')).not.toBeNull())
    expect(document.querySelector('.bubble-highlight')!.textContent).toMatch(/pacote fechado/)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Limpar' }))
    expect(screen.queryByRole('region', { name: 'Resultados da busca' })).toBeNull()
    expect(document.querySelector('.contacts-list')!.hasAttribute('hidden')).toBe(false)
    expect(box().value).toBe('')
  })

  it('nenhum resultado: dicas; só palavras vazias: pede o assunto; filtros vão para a busca', async () => {
    render(<App />)
    await screen.findByText('Ana Paula Souza', { selector: '.contact-name' })
    search('xilofone')
    expect(await screen.findByText('Nenhum resultado')).toBeTruthy()
    expect(screen.getByText(/palavra parecida/)).toBeTruthy()
    search('quem falou sobre?')
    expect(await screen.findByText('Escreva o assunto que você procura.')).toBeTruthy()
    search('preço')
    await screen.findByText(/mensage(m|ns) em/)
    fireEvent.click(screen.getByRole('radio', { name: 'Grupos' }))
    fireEvent.change(screen.getByLabelText('Período'), { target: { value: '7d' } })
    fireEvent.click(screen.getByLabelText('Só áudios'))
    await waitFor(() =>
      expect(ctl.calls.filter((c) => c.method === 'searchMessages').at(-1)!.args[1]).toEqual({ kind: 'group', period: '7d', audioOnly: true, jid: null })
    )
  })

  it('"Resumir com IA" só quando o mentor clica; mostra a resposta e as conversas', async () => {
    render(<App />)
    await screen.findByText('Ana Paula Souza', { selector: '.contact-name' })
    search('precificar preço')
    await screen.findByText(/mensage(m|ns) em/)
    expect(ctl.calls.some((c) => c.method === 'summarizeSearch')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Resumir com IA' }))
    expect(await screen.findByText('Resumo da IA')).toBeTruthy()
    expect(ctl.calls.filter((c) => c.method === 'summarizeSearch')).toHaveLength(1)
    const refs = screen.getByText(/^Conversas:/)
    fireEvent.click(within(refs).getAllByRole('button')[0])
    await screen.findByRole('region', { name: /Grupo|Conversa com/ })
  })

  it('Ctrl+K e Ctrl+F vão para a caixa de busca', async () => {
    render(<App />)
    await screen.findByText('Ana Paula Souza', { selector: '.contact-name' })
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    expect(document.activeElement).toBe(box())
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(document, { key: 'f', ctrlKey: true })
    expect(document.activeElement).toBe(box())
  })

  it('destaque monta pelos intervalos e escapa HTML (nada de HTML cru)', () => {
    const { container } = render(<Highlighted snippet={{ text: '<img src=x onerror=alert(1)> preço', ranges: [[29, 34]], cutStart: true, cutEnd: false }} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('…<img src=x onerror=alert(1)> preço')
    expect(container.querySelector('mark')!.textContent).toBe('preço')
  })
})
