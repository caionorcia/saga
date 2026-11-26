// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { createFakeSaga, type FakeControl } from '../../src/renderer/src/dev/fakeSaga'

let ctl: FakeControl
beforeEach(() => {
  localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  ctl = createFakeSaga()
  window.saga = ctl.api
})
afterEach(() => cleanup())

const open = (name: string) => fireEvent.click(screen.getByText(name, { selector: '.contact-name' }).closest('button')!)
const analysisCalls = () => ctl.calls.filter((c) => c.method === 'getAnalysis')
const sidebar = () => screen.getByRole('complementary', { name: 'Sugestões de resposta' })

describe('conversa que não precisa de resposta: sugestões só quando o mentor pede', () => {
  it('abrir não gera nada; "Gerar sugestões mesmo assim" gera uma vez', async () => {
    render(<App />)
    await screen.findByText('João Pedro (Consultório)', { selector: '.contact-name' })
    open('João Pedro (Consultório)')
    expect(await within(sidebar()).findByText('Esta conversa não precisa de resposta agora.')).toBeTruthy()
    expect(analysisCalls().map((c) => c.args[1])).toEqual([{ onlyIfNeeded: true }])
    expect(screen.getByText(/o resumo não foi gerado/)).toBeTruthy()
    fireEvent.click(within(sidebar()).getByRole('button', { name: 'Gerar sugestões mesmo assim' }))
    await waitFor(() => expect(within(sidebar()).getAllByRole('textbox').length).toBeGreaterThan(0))
    expect(analysisCalls().map((c) => c.args[1])).toEqual([{ onlyIfNeeded: true }, undefined])
    expect(screen.queryByText(/o resumo não foi gerado/)).toBeNull()
  })

  it('conversa esperando resposta: continua gerando sozinha', async () => {
    render(<App />)
    await screen.findByText('Ana Paula Souza', { selector: '.contact-name' })
    open('Ana Paula Souza')
    await waitFor(() => expect(within(sidebar()).getAllByRole('textbox').length).toBeGreaterThan(0))
    expect(within(sidebar()).queryByText('Esta conversa não precisa de resposta agora.')).toBeNull()
  })
})
