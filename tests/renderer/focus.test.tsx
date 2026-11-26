// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContactList, needsMentor } from '../../src/renderer/src/components/ContactList'
import { createFakeSaga } from '../../src/renderer/src/dev/fakeSaga'
import type { Contact } from '../../src/shared/api'

const FOCUS_KEY = 'saga.focus'
const rowOf = (name: string) => screen.getByText(name, { selector: '.contact-name' }).closest('li')!

beforeEach(() => {
  localStorage.clear()
  window.saga = createFakeSaga().api
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Foco', () => {
  it('apaga as conversas que não pedem resposta, sem tirá-las da lista; as que pedem ficam normais', async () => {
    const onSelect = vi.fn()
    render(<ContactList selected={null} onSelect={onSelect} />)
    await screen.findByText('Ana Paula Souza', { selector: '.contact-name' })
    const btn = screen.getByRole('button', { name: 'Foco' })
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelectorAll('.contact.is-dim')).toHaveLength(0)

    fireEvent.click(btn)
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(localStorage.getItem(FOCUS_KEY)).toBe('1')
    // o mentor falou por último / respondido no grupo: apagadas; esperando resposta: normal
    expect(rowOf('João Pedro (Consultório)').classList.contains('is-dim')).toBe(true)
    expect(rowOf('Beatriz Alves').classList.contains('is-dim')).toBe(true)
    expect(rowOf('Ana Paula Souza').classList.contains('is-dim')).toBe(false)
    expect(rowOf('Rafael Mendes').classList.contains('is-dim')).toBe(false)
    // continua clicável
    fireEvent.click(rowOf('João Pedro (Consultório)').querySelector('.contact-main')!)
    expect(onSelect).toHaveBeenCalledWith('5585966665555@s.whatsapp.net')

    fireEvent.click(btn)
    expect(localStorage.getItem(FOCUS_KEY)).toBe('0')
    expect(document.querySelectorAll('.contact.is-dim')).toHaveLength(0)
  })

  it('lembra a escolha e funciona junto com os filtros (só grupos, Para responder)', async () => {
    localStorage.setItem(FOCUS_KEY, '1')
    render(<ContactList selected={null} onSelect={() => {}} />)
    await screen.findByText('Ana Paula Souza', { selector: '.contact-name' })
    expect(screen.getByRole('button', { name: 'Foco' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'Grupos' }))
    await waitFor(() => expect(screen.queryByText('Ana Paula Souza', { selector: '.contact-name' })).toBeNull())
    expect(rowOf('Mentoria Beatriz Alves').classList.contains('is-dim')).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'Todos' }))
    await screen.findByText('Ana Paula Souza', { selector: '.contact-name' })
    fireEvent.click(screen.getByRole('button', { name: /Para responder/ }))
    for (const li of document.querySelectorAll('.contacts-list .contact')) expect(li.classList.contains('is-dim')).toBe(false)
  })

  it('sem armazenamento (bloqueado): começa desligado e liga mesmo assim', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado')
    })
    render(<ContactList selected={null} onSelect={() => {}} />)
    await screen.findByText('Ana Paula Souza', { selector: '.contact-name' })
    const btn = screen.getByRole('button', { name: 'Foco' })
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-pressed')).toBe('true')
  })

  it('v0.3.0: sem "Mostrar escondidos" nem "Esconder/Mostrar" no menu (telefone só profissional)', async () => {
    const list = vi.spyOn(window.saga, 'listContacts')
    render(<ContactList selected={null} onSelect={() => {}} />)
    await screen.findByText('Ana Paula Souza', { selector: '.contact-name' })
    expect(screen.queryByLabelText('Mostrar escondidos')).toBeNull()
    expect(list).toHaveBeenCalledWith(false, 'all')
    fireEvent.click(screen.getByRole('button', { name: 'Opções de Ana Paula Souza' }))
    const items = screen.getAllByRole('menuitem').map((b) => b.textContent)
    expect(items).toEqual(['Renomear', 'Notas'])
    expect('setHidden' in window.saga).toBe(false)
  })

  it('needsMentor: precisa de resposta e não está escondida', () => {
    const c = (o: Partial<Contact>) => ({ needsReply: true, hidden: false, ...o }) as Contact
    expect(needsMentor(c({}))).toBe(true)
    expect(needsMentor(c({ needsReply: false }))).toBe(false)
    expect(needsMentor(c({ hidden: true }))).toBe(false)
  })
})
