// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ContactList } from '../../src/renderer/src/components/ContactList'
import { Conversation } from '../../src/renderer/src/components/Conversation'
import { createFakeSaga, type FakeControl } from '../../src/renderer/src/dev/fakeSaga'

const ANA = '5547999998888@s.whatsapp.net'
const MASTERMIND = '120363026666666666@g.us'
const VIEW_KEY = 'saga.contactView'

const names = () => [...document.querySelectorAll('.contacts-list .contact-name')].map((e) => e.textContent)
const rowOf = (name: string) => screen.getByText(name, { selector: '.contact-name' }).closest('li')!

function install(): FakeControl {
  const ctl = createFakeSaga()
  window.saga = ctl.api
  return ctl
}

beforeEach(() => {
  try {
    localStorage.clear()
  } catch {
    // ok
  }
})
afterEach(cleanup)

describe('ContactList: "Não precisa responder" em "Para responder"', () => {
  it('a conversa que o Saga decidiu que não precisa de resposta fica fora da lista; em "Todos" aparece sem o selo', async () => {
    install()
    render(<ContactList selected={null} onSelect={() => {}} />)
    await waitFor(() => expect(names()).toContain('Mastermind Vendas 2026'))
    const row = rowOf('Mastermind Vendas 2026')
    expect(within(row).getByText('Sem pendência')).toBeTruthy()
    expect(within(row).getByText('Não precisa responder').getAttribute('title')).toBe('Conversa entre participantes do grupo; ninguém falou com você.')
    expect(row.querySelector('.wait-badge')).toBeNull()
    // a ação de linha só aparece em "Para responder"
    expect(within(row).queryByRole('button', { name: /^Não precisa responder:/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Para responder/ }))
    await waitFor(() => expect(names()).not.toContain('Mastermind Vendas 2026'))
  })

  it('ação na linha abre o diálogo; Salvar registra o motivo, tira a conversa da lista e agradece', async () => {
    const ctl = install()
    localStorage.setItem(VIEW_KEY, 'awaiting')
    render(<ContactList selected={null} onSelect={() => {}} />)
    await waitFor(() => expect(names()).toContain('Ana Paula Souza'))
    const btn = screen.getByRole('button', { name: /Para responder/ })
    expect(btn.textContent).toMatch(/6/)
    fireEvent.click(within(rowOf('Ana Paula Souza')).getByRole('button', { name: 'Não precisa responder: Ana Paula Souza' }))
    const dlg = screen.getByRole('dialog', { name: 'Por que esta conversa não precisa de resposta?' })
    expect(within(dlg).getAllByRole('radio').map((r) => r.closest('label')!.textContent)).toEqual([
      'Era só agradecimento / ok / emoji',
      'Respondi no grupo dele',
      'Respondi por ligação/pessoalmente',
      'Mensagem de grupo que não é comigo',
      'Conversa encerrada',
      'Outro'
    ])
    const save = within(dlg).getByRole('button', { name: 'Salvar' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(within(dlg).getByRole('radio', { name: 'Conversa encerrada' }))
    fireEvent.change(within(dlg).getByLabelText('Explique com suas palavras (opcional)'), { target: { value: ' Já combinamos tudo ' } })
    fireEvent.click(save)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(ctl.calls.find((c) => c.method === 'setNeedsReply')!.args).toEqual([ANA, false, { code: 'encerrada', text: 'Já combinamos tudo' }])
    expect(names()).not.toContain('Ana Paula Souza')
    expect(screen.getByRole('status').textContent).toMatch(/aprender/)
    // a lista voltou do processo principal: continua fora, e o contador diminui
    await waitFor(() => expect(btn.textContent).toMatch(/5/))
    expect(names()).not.toContain('Ana Paula Souza')
  })

  it('Cancelar fecha sem registrar', async () => {
    const ctl = install()
    localStorage.setItem(VIEW_KEY, 'awaiting')
    render(<ContactList selected={null} onSelect={() => {}} />)
    await waitFor(() => expect(names()).toContain('Ana Paula Souza'))
    fireEvent.click(within(rowOf('Ana Paula Souza')).getByRole('button', { name: 'Não precisa responder: Ana Paula Souza' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(ctl.calls.some((c) => c.method === 'setNeedsReply')).toBe(false)
    expect(names()).toContain('Ana Paula Souza')
  })
})

describe('Conversation: "Para responder"', () => {
  async function open(jid: string) {
    const ctl = install()
    const contact = (await ctl.api.listContacts(true)).find((c) => c.jid === jid)!
    const view = render(<Conversation contact={contact} analysis={null} alerts={await ctl.api.listAlerts(jid)} />)
    const rerender = async () => {
      const c = (await ctl.api.listContacts(true)).find((x) => x.jid === jid)!
      view.rerender(<Conversation contact={c} analysis={null} alerts={await ctl.api.listAlerts(jid)} />)
    }
    return { ctl, rerender }
  }

  it('cabeçalho: "Não precisa responder" abre o diálogo; depois mostra "Você marcou…" com "Precisa sim"', async () => {
    const { ctl, rerender } = await open(ANA)
    expect(screen.queryByRole('region', { name: 'Para responder' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Não precisa responder' }))
    const dlg = screen.getByRole('dialog', { name: 'Por que esta conversa não precisa de resposta?' })
    fireEvent.click(within(dlg).getByRole('radio', { name: 'Era só agradecimento / ok / emoji' }))
    fireEvent.click(within(dlg).getByRole('button', { name: 'Salvar' }))
    expect(ctl.calls.find((c) => c.method === 'setNeedsReply')!.args).toEqual([ANA, false, { code: 'agradecimento' }])
    const note = screen.getByRole('region', { name: 'Para responder' })
    expect(note.textContent).toMatch(/Você marcou que esta conversa não precisa de resposta/)
    expect(screen.queryByRole('button', { name: 'Não precisa responder' })).toBeNull()
    await rerender()
    expect(screen.getByRole('region', { name: 'Para responder' }).textContent).toMatch(/Você marcou/)
  })

  it('decisão do Saga: aviso com o motivo; "Precisa sim" devolve à lista e registra a correção', async () => {
    const { ctl, rerender } = await open(MASTERMIND)
    const note = screen.getByRole('region', { name: 'Para responder' })
    expect(note.textContent).toContain(
      'O Saga acha que esta conversa não precisa de resposta: Conversa entre participantes do grupo; ninguém falou com você.'
    )
    fireEvent.click(within(note).getByRole('button', { name: 'Precisa sim' }))
    expect(ctl.calls.find((c) => c.method === 'setNeedsReply')!.args).toEqual([MASTERMIND, true, undefined])
    expect(screen.queryByRole('region', { name: 'Para responder' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Não precisa responder' })).toBeTruthy()
    await rerender()
    expect(screen.queryByRole('region', { name: 'Para responder' })).toBeNull()
    expect((await ctl.api.listContacts(true)).find((c) => c.jid === MASTERMIND)!.needsReply).toBe(true)
    expect((await ctl.api.getState()).triage.awaiting).toBe(7)
  })

  it('decisão do Saga: 👍 confirma (reply_ok) e a conversa continua fora da lista', async () => {
    const { ctl, rerender } = await open(MASTERMIND)
    fireEvent.click(within(screen.getByRole('region', { name: 'Para responder' })).getByRole('button', { name: 'O Saga acertou' }))
    expect(ctl.calls.find((c) => c.method === 'confirmNoReply')!.args).toEqual([MASTERMIND])
    expect(screen.getByRole('status').textContent).toMatch(/aprender/)
    await rerender()
    expect(screen.getByRole('region', { name: 'Para responder' }).textContent).toMatch(/Você marcou/)
    expect((await ctl.api.alertQuality()).reply.confirmed).toBe(4)
  })
})

describe('"Respondido no grupo"', () => {
  const BEA = '5531900001111@s.whatsapp.net'
  const BEA_GROUP = '120363027777777777@g.us'

  it('lista: fora de "Para responder"; em "Todos" mostra "respondido em <grupo>"', async () => {
    install()
    render(<ContactList selected={null} onSelect={() => {}} />)
    await waitFor(() => expect(names()).toContain('Beatriz Alves'))
    const row = rowOf('Beatriz Alves')
    expect(within(row).getByText('Sem pendência')).toBeTruthy()
    expect(within(row).getByText('respondido em Mentoria Beatriz Alves').getAttribute('title')).toBe('Respondido no grupo Mentoria Beatriz Alves')
    fireEvent.click(screen.getByRole('button', { name: /Para responder/ }))
    await waitFor(() => expect(names()).not.toContain('Beatriz Alves'))
  })

  it('conversa: "Respondido no grupo <nome> às HH:MM", o nome abre o grupo e "Precisa sim" devolve à lista', async () => {
    const ctl = install()
    const contact = (await ctl.api.listContacts(true)).find((c) => c.jid === BEA)!
    expect(contact.replyDecision).toMatchObject({ needed: false, by: 'group', group: { jid: BEA_GROUP, name: 'Mentoria Beatriz Alves' } })
    const opened: string[] = []
    render(<Conversation contact={contact} analysis={null} alerts={[]} onOpenChat={(j) => opened.push(j)} />)
    const note = screen.getByRole('region', { name: 'Para responder' })
    const hhmm = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(contact.replyDecision!.group!.ts)
    expect(note.textContent).toContain(`Respondido no grupo Mentoria Beatriz Alves às ${hhmm}`)
    fireEvent.click(within(note).getByRole('button', { name: 'Mentoria Beatriz Alves' }))
    expect(opened).toEqual([BEA_GROUP])
    const before = (await ctl.api.getState()).triage.awaiting
    fireEvent.click(within(note).getByRole('button', { name: 'Precisa sim' }))
    expect(ctl.calls.find((c) => c.method === 'setNeedsReply')!.args).toEqual([BEA, true, undefined])
    await waitFor(async () => expect((await ctl.api.getState()).triage.awaiting).toBe(before + 1))
    expect((await ctl.api.listContacts(true)).find((c) => c.jid === BEA)!.replyDecision).toEqual({ needed: true, by: 'user', reason: null })
  })
})
