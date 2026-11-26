// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { ContactList } from '../../src/renderer/src/components/ContactList'
import { Conversation } from '../../src/renderer/src/components/Conversation'
import { StatusBar } from '../../src/renderer/src/components/StatusBar'
import { createFakeSaga, DEFAULT_STATE, type FakeControl } from '../../src/renderer/src/dev/fakeSaga'
import { alertChipLabel, formatWait, waitTone } from '../../src/renderer/src/format'
import type { Alert, Contact } from '../../src/shared/api'

const MIN = 60_000
const H = 60 * MIN
const VIEW_KEY = 'saga.contactView'

function install(): FakeControl {
  const ctl = createFakeSaga()
  window.saga = ctl.api
  return ctl
}

const names = () => [...document.querySelectorAll('.contacts-list .contact-name')].map((e) => e.textContent)
const rowOf = (name: string) => screen.getByText(name, { selector: '.contact-name' }).closest('li')!

beforeEach(() => {
  try {
    localStorage.clear()
  } catch {
    // ok
  }
})
afterEach(cleanup)

describe('formatWait / waitTone / alertChipLabel', () => {
  const now = 1_764_000_000_000
  it('texto curto da espera', () => {
    expect(formatWait(now - 20_000, now)).toBe('agora')
    expect(formatWait(now - 15 * MIN, now)).toBe('há 15 min')
    expect(formatWait(now - 3 * H - 10 * MIN, now)).toBe('há 3 h')
    expect(formatWait(now - 30 * H, now)).toBe('há 1 dia')
    expect(formatWait(now - 50 * H, now)).toBe('há 2 dias')
  })
  it('cor: neutra < 24 h, âmbar 24–48 h, vermelha > 48 h', () => {
    expect(waitTone(now - 23 * H, now)).toBe('neutral')
    expect(waitTone(now - 24 * H, now)).toBe('amber')
    expect(waitTone(now - 47 * H, now)).toBe('amber')
    expect(waitTone(now - 49 * H, now)).toBe('red')
  })
  it('rótulos dos alertas', () => {
    expect(alertChipLabel('urgente', null, now)).toBe('Urgente')
    expect(alertChipLabel('desanimo', null, now)).toBe('Desânimo')
    expect(alertChipLabel('reuniao', null, now)).toBe('Reunião')
    expect(alertChipLabel('travado', null, now)).toBe('Travado')
    expect(alertChipLabel('esperando', now - 50 * H, now)).toBe('Esperando 2 dias')
    expect(alertChipLabel('esperando', now - 80 * H, now)).toBe('Esperando 3 dias')
  })
})

describe('ContactList: "Para responder" e "Com alerta"', () => {
  it('Para responder: só quem espera, quem espera há mais tempo primeiro, com o selo da espera; conta no rótulo', async () => {
    install()
    render(<ContactList selected={null} onSelect={() => {}} />)
    await waitFor(() => expect(names()).toContain('Ana Paula Souza'))
    const btn = screen.getByRole('button', { name: /Para responder/ })
    expect(btn.textContent).toMatch(/6/)
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    await waitFor(() =>
      expect(names()).toEqual([
        'Rafael Mendes',
        'Fernanda Costa',
        'Mentoria Turma 3 — Negócios',
        'Mariana Lima',
        'Ana Paula Souza',
        'Carlos Eduardo'
      ])
    )
    const rafael = within(rowOf('Rafael Mendes')).getByText('há 3 dias')
    expect(rafael.className).toMatch(/wait-red/)
    expect(within(rowOf('Fernanda Costa')).getByText('há 1 dia').className).toMatch(/wait-amber/)
    expect(within(rowOf('Mariana Lima')).getByText('há 5 h').className).toMatch(/wait-neutral/)
    expect(localStorage.getItem(VIEW_KEY)).toBe('awaiting')
    // clicar de novo volta para todas
    fireEvent.click(btn)
    await waitFor(() => expect(names()).toContain('João Pedro (Consultório)'))
  })

  it('Com alerta: mais graves primeiro, depois quem espera há mais tempo; no máximo 2 selos + "+N"', async () => {
    install()
    render(<ContactList selected={null} onSelect={() => {}} />)
    await waitFor(() => expect(names()).toContain('Ana Paula Souza'))
    const btn = screen.getByRole('button', { name: /Com alerta/ })
    expect(btn.textContent).toMatch(/4/)
    fireEvent.click(btn)
    await waitFor(() =>
      expect(names()).toEqual(['Rafael Mendes', 'Mentoria Turma 3 — Negócios', 'Mariana Lima', 'Ana Paula Souza'])
    )
    const chips = within(rowOf('Rafael Mendes')).getAllByTestId('alert-chip')
    expect(chips.map((c) => c.textContent)).toEqual(['Urgente', 'Desânimo'])
    expect(within(rowOf('Rafael Mendes')).getByText('+1')).toBeTruthy()
    expect(within(rowOf('Ana Paula Souza')).getAllByTestId('alert-chip').map((c) => c.textContent)).toEqual(['Reunião'])
  })

  it('lista vazia explica o filtro; resolver o alerta tira a conversa de "Com alerta"', async () => {
    install()
    localStorage.setItem(VIEW_KEY, 'alerts')
    render(<ContactList selected={null} onSelect={() => {}} />)
    await waitFor(() => expect(names()).toHaveLength(4))
    await window.saga.dismissAlert('5547999998888@s.whatsapp.net', 'reuniao')
    await waitFor(() => expect(names()).not.toContain('Ana Paula Souza'))
    fireEvent.click(screen.getByRole('radio', { name: /Individuais/ }))
    fireEvent.change(screen.getByPlaceholderText(/Buscar/), { target: { value: 'zzz' } })
    await waitFor(() => expect(screen.getByText('Nada encontrado.')).toBeTruthy())
  })

  it('pedido externo (barra de status): vai para "Para responder" com Todos', async () => {
    install()
    localStorage.setItem('saga.contactKind', 'group')
    const { rerender } = render(<ContactList selected={null} onSelect={() => {}} />)
    await waitFor(() => expect(names()).toEqual(['Mentoria Turma 3 — Negócios', 'Mentoria Beatriz Alves', 'Mastermind Vendas 2026']))
    rerender(<ContactList selected={null} onSelect={() => {}} request={{ view: 'awaiting', seq: 1 }} />)
    await waitFor(() => expect(names()[0]).toBe('Rafael Mendes'))
    expect(screen.getByRole('radio', { name: /Todos/ }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('button', { name: /Para responder/ }).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('Conversation: barra de alertas', () => {
  const JID = '5548944443333@s.whatsapp.net'
  const contact: Contact = {
    jid: JID, pushName: 'Rafael', customName: null, hidden: false, notes: null, displayName: 'Rafael', lastTs: 1,
    awaitingReply: true, isGroup: false, waitingSince: Date.now() - 50 * H, alerts: ['urgente', 'esperando'],
    needsReply: true, replyDecision: null
  }
  const alerts: Alert[] = [
    { id: 1, jid: JID, kind: 'urgente', detail: 'Precisa decidir até sexta.', msgId: 'R3', createdAt: 1, source: 'ai', rating: null },
    { id: 2, jid: JID, kind: 'esperando', detail: 'Sem resposta há mais de 2 dias.', msgId: null, createdAt: 1, source: 'rule', rating: null }
  ]

  it('lista os alertas com detalhe e "Resolver"; clicar no alerta destaca a mensagem', async () => {
    install()
    const onDismiss = vi.fn()
    render(<Conversation contact={contact} analysis={null} alerts={alerts} onDismissAlert={onDismiss} />)
    const bar = screen.getByRole('region', { name: 'Alertas desta conversa' })
    expect(within(bar).getByText('Precisa decidir até sexta.')).toBeTruthy()
    expect(within(bar).getByText(/Esperando 2 dias/)).toBeTruthy()
    const resolve = within(bar).getAllByRole('button', { name: /Resolver/ })
    expect(resolve).toHaveLength(2)
    fireEvent.click(resolve[0])
    expect(onDismiss).toHaveBeenCalledWith('urgente')
    await waitFor(() => expect(document.querySelector('[data-msg-id="R3"]')).toBeTruthy())
    fireEvent.click(within(bar).getByRole('button', { name: /Ver mensagem/ }))
    expect(document.querySelector('[data-msg-id="R3"]')!.className).toMatch(/bubble-highlight/)
  })

  it('sem alertas, sem barra', () => {
    install()
    render(<Conversation contact={{ ...contact, alerts: [] }} analysis={null} />)
    expect(screen.queryByRole('region', { name: 'Alertas desta conversa' })).toBeNull()
  })
})

describe('StatusBar: contador da fila do dia', () => {
  it('"N para responder · M com alerta"; clicar chama onShowAwaiting', () => {
    window.saga = createFakeSaga().api
    const onShow = vi.fn()
    render(
      <StatusBar state={{ ...DEFAULT_STATE, triage: { awaiting: 7, withAlerts: 4 } }} settingsOpen={false} onOpenSettings={() => {}} onShowAwaiting={onShow} />
    )
    const b = screen.getByRole('button', { name: /7 para responder · 4 com alerta/ })
    fireEvent.click(b)
    expect(onShow).toHaveBeenCalledTimes(1)
  })

  it('nada a responder: sem contador', () => {
    window.saga = createFakeSaga().api
    render(<StatusBar state={DEFAULT_STATE} settingsOpen={false} onOpenSettings={() => {}} />)
    expect(screen.queryByRole('button', { name: /para responder/ })).toBeNull()
  })
})

describe('App: contador da barra seleciona "Para responder"', () => {
  it('fecha as configurações e filtra a lista', async () => {
    install()
    render(<App />)
    await waitFor(() => expect(names()).toContain('João Pedro (Consultório)'))
    fireEvent.click(screen.getByRole('button', { name: 'Configurações' }))
    const counter = await screen.findByRole('button', { name: /6 para responder · 4 com alerta/ })
    fireEvent.click(counter)
    await waitFor(() => expect(names()[0]).toBe('Rafael Mendes'))
    expect(names()).not.toContain('João Pedro (Consultório)')
    expect(screen.getByRole('button', { name: /Para responder/, pressed: true })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Voltar às conversas' })).toBeNull()
  })
})
