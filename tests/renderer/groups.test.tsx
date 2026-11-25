// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { ContactList } from '../../src/renderer/src/components/ContactList'
import { Conversation } from '../../src/renderer/src/components/Conversation'
import { createFakeSaga, type FakeControl } from '../../src/renderer/src/dev/fakeSaga'
import type { Analysis, Contact } from '../../src/shared/api'

const GRP = '120363025555555555@g.us'
const KIND_KEY = 'saga.contactKind'

function install(): FakeControl {
  const ctl = createFakeSaga()
  window.saga = ctl.api
  return ctl
}

const names = () => [...document.querySelectorAll('.contacts-list .contact-name')].map((e) => e.textContent)
const row = (name: string) => screen.getByText(name, { selector: '.contact-name' }).closest('button')!

beforeEach(() => {
  try {
    localStorage.clear()
  } catch {
    // sem armazenamento: ok
  }
})
afterEach(cleanup)

describe('ContactList: filtro Todos | Individuais | Grupos', () => {
  it('Todos mostra pessoas e grupos; Grupos só grupos; Individuais só pessoas; lembra a escolha', async () => {
    install()
    const { unmount } = render(<ContactList selected={null} onSelect={() => {}} />)
    await waitFor(() => expect(names()).toContain('Mentoria Turma 3 — Negócios'))
    expect(names()).toContain('Ana Paula Souza')
    expect(screen.getByRole('radio', { name: /Todos/ }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('radio', { name: /Grupos/ }))
    await waitFor(() => expect(names()).toEqual(['Mentoria Turma 3 — Negócios', 'Mastermind Vendas 2026']))
    expect(localStorage.getItem(KIND_KEY)).toBe('group')

    fireEvent.click(screen.getByRole('radio', { name: /Individuais/ }))
    await waitFor(() => expect(names()).not.toContain('Mastermind Vendas 2026'))
    expect(names()).toContain('Ana Paula Souza')

    unmount()
    localStorage.setItem(KIND_KEY, 'group')
    render(<ContactList selected={null} onSelect={() => {}} />)
    await waitFor(() => expect(names()).toEqual(['Mentoria Turma 3 — Negócios', 'Mastermind Vendas 2026']))
    expect(screen.getByRole('radio', { name: /Grupos/ }).getAttribute('aria-checked')).toBe('true')
  })

  it('valor inválido ou localStorage quebrado: volta para Todos sem quebrar', async () => {
    install()
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado')
    })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado')
    })
    render(<ContactList selected={null} onSelect={() => {}} />)
    await waitFor(() => expect(names()).toContain('Ana Paula Souza'))
    fireEvent.click(screen.getByRole('radio', { name: /Grupos/ }))
    await waitFor(() => expect(names()).toEqual(['Mentoria Turma 3 — Negócios', 'Mastermind Vendas 2026']))
    spy.mockRestore()
    set.mockRestore()
  })

  it('linha de grupo tem o ícone de grupo; a busca acha pessoas e grupos', async () => {
    install()
    render(<ContactList selected={null} onSelect={() => {}} />)
    await waitFor(() => expect(names()).toContain('Mentoria Turma 3 — Negócios'))
    const g = row('Mentoria Turma 3 — Negócios')
    expect(g.querySelector('.avatar-group')).not.toBeNull()
    expect(g.textContent).toContain('Grupo')
    expect(row('Ana Paula Souza').querySelector('.avatar-group')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText(/Buscar/), { target: { value: 'mentoria' } })
    await waitFor(() => expect(names()).toEqual(['Mentoria Turma 3 — Negócios']))
    fireEvent.change(screen.getByPlaceholderText(/Buscar/), { target: { value: 'paula' } })
    await waitFor(() => expect(names()).toEqual(['Ana Paula Souza']))
  })
})

describe('Conversation em grupo', () => {
  const group: Contact = {
    jid: GRP,
    pushName: 'Mentoria',
    customName: null,
    hidden: false,
    notes: null,
    displayName: 'Mentoria',
    lastTs: 1,
    awaitingReply: true,
    isGroup: true
  }
  const analysis: Analysis = { jid: GRP, lastMsgId: 'G8', provider: 'groq', summary: 'Bruno te marcou.', suggestions: ['a', 'b'], createdAt: 1, transcriptFp: '', pendingAudios: 0 }

  it('nome de quem mandou acima do texto, uma vez por sequência; minhas mensagens sem nome; título do resumo', async () => {
    install()
    render(<Conversation contact={group} analysis={analysis} />)
    await screen.findByText('Eu montei, mas não entendi onde entra o pró-labore.')
    const senders = [...document.querySelectorAll('.bubble-sender')].map((e) => e.textContent)
    // G2 Bruno, G3 Renata, G4+G5 Bruno (uma vez), G6 Renata, G7 Lucas, G8 Bruno
    expect(senders).toEqual(['Bruno Alves', 'Renata Dias', 'Bruno Alves', 'Renata Dias', 'Lucas Prado', 'Bruno Alves'])
    expect(screen.getByRole('heading', { name: 'O que pedem a você' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'O que a pessoa quer' })).toBeNull()
    expect(screen.getAllByText('menciona você').length).toBe(2)
  })

  it('conversa individual continua sem nomes e com "O que a pessoa quer"', async () => {
    install()
    const ana: Contact = { ...group, jid: '5547999998888@s.whatsapp.net', displayName: 'Ana', isGroup: false }
    render(<Conversation contact={ana} analysis={null} />)
    await screen.findByText(/Pacote costuma funcionar melhor/)
    expect(document.querySelectorAll('.bubble-sender')).toHaveLength(0)
    expect(screen.getByRole('heading', { name: 'O que a pessoa quer' })).toBeTruthy()
  })
})

describe('App: sugestões num grupo', () => {
  it('a coluna da direita avisa que a mensagem vai para o grupo', async () => {
    install()
    render(<App />)
    await waitFor(() => expect(names()).toContain('Mentoria Turma 3 — Negócios'))
    fireEvent.click(row('Mentoria Turma 3 — Negócios'))
    expect(await screen.findByText(/cole no grupo do WhatsApp/)).toBeTruthy()
    expect(await screen.findByText(/pró-labore entra separado/)).toBeTruthy()
  })
})
