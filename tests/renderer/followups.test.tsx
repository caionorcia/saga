// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Suggestions } from '../../src/renderer/src/components/Suggestions'
import { ContactList } from '../../src/renderer/src/components/ContactList'
import { createFakeSaga, type FakeControl, type FakeOptions } from '../../src/renderer/src/dev/fakeSaga'
import { FOLLOWUP_TEXT } from '../../src/shared/copiloto'

const ANA = '5547999998888@s.whatsapp.net'
const GRP = '120363025555555555@g.us'
const FU_ANA = '7d1e2c3b-4a5f-4e6d-8c7b-9a0b1c2d3e4f'

function install(o: FakeOptions = {}): FakeControl {
  try {
    localStorage.clear()
  } catch {
    // sem armazenamento
  }
  const ctl = createFakeSaga({ sendAutoAdvance: false, followups: true, ...o })
  window.saga = ctl.api
  return ctl
}
const calls = (ctl: FakeControl, m: string) => ctl.calls.filter((c) => c.method === m)

afterEach(cleanup)

describe('Follow-up do Copiloto (v0.7.0)', () => {
  it('lista de conversas: 📨 nas conversas com mensagem do Copiloto e o filtro "Do Copiloto (2)"', async () => {
    install()
    render(<ContactList selected={null} onSelect={() => {}} />)
    const chip = await screen.findByRole('button', { name: /Do Copiloto/ })
    expect(chip.textContent).toMatch(/2/)
    expect(await screen.findAllByTitle('Mensagem do Copiloto esperando você')).toHaveLength(2)
    fireEvent.click(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
  })

  it('sem follow-ups: nada de filtro nem selo', async () => {
    install({ followups: false })
    render(<ContactList selected={null} onSelect={() => {}} />)
    await screen.findAllByRole('listitem')
    expect(screen.queryByRole('button', { name: /Do Copiloto/ })).toBeNull()
    expect(screen.queryByTitle('Mensagem do Copiloto esperando você')).toBeNull()
  })

  it('cartão na coluna das sugestões: autor, data, texto; "Abrir para enviar" → caixa preenchida e editável → confirmação → envio com o id do follow-up', async () => {
    const ctl = install()
    render(<Suggestions jid={ANA} />)
    const card = await screen.findByRole('group', { name: 'Mensagem do Copiloto' })
    expect(within(card).getByText(/^por Equipe Saga · Marina, \d\d\/\d\d às \d\d:\d\d$/)).toBeTruthy()
    expect(within(card).getByText(/primeira semana com o novo cardápio/)).toBeTruthy()
    // nada sai sozinho
    expect(calls(ctl, 'sendAvulsa')).toHaveLength(0)
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Abrir para enviar' }))
    })
    const composer = await screen.findByRole('group', { name: 'Mensagem do Copiloto' })
    const box = within(composer).getByRole('textbox', { name: 'Mensagem do Copiloto' }) as HTMLTextAreaElement
    expect(box.value).toMatch(/^Oi! Passando para saber/)
    expect(box.maxLength).toBe(4000)
    fireEvent.change(box, { target: { value: 'Oi, Ana! Como foi a primeira semana?' } })
    fireEvent.click(within(composer).getByRole('button', { name: 'Enviar' }))
    const dlg = await screen.findByRole('dialog', { name: 'Enviar mensagem do Copiloto' })
    await within(dlg).findByText(/não responde a nenhuma mensagem/)
    expect(calls(ctl, 'prepareSend').at(-1)!.args[0]).toMatchObject({ jid: ANA, kind: 'avulsa' })
    await act(async () => {
      fireEvent.click(within(dlg).getByRole('button', { name: 'Enviar' }))
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls(ctl, 'sendAvulsa')[0].args[0]).toMatchObject({ jid: ANA, text: 'Oi, Ana! Como foi a primeira semana?', draftId: FU_ANA })
    expect(calls(ctl, 'saveReply')).toHaveLength(0)
    expect(await within(composer).findByText(/Na fila — envia em/)).toBeTruthy()
    // saiu: o aviso vira "Enviada ✓"
    act(() => ctl.setSend(ctl.lastSend()!.id, { status: 'sent', sentAt: Date.now(), etaAt: null }))
    expect(await screen.findByText(/Enviada ✓/)).toBeTruthy()
    expect((await window.saga.listFollowups()).find((f) => f.id === FU_ANA)).toMatchObject({ status: 'sent', finalText: 'Oi, Ana! Como foi a primeira semana?' })
  })

  it('"Recusar" pede o motivo (opcional) e tira o aviso', async () => {
    const ctl = install()
    render(<Suggestions jid={GRP} />)
    const card = await screen.findByRole('group', { name: 'Mensagem do Copiloto' })
    fireEvent.click(within(card).getByRole('button', { name: 'Recusar' }))
    const dlg = screen.getByRole('dialog', { name: 'Recusar a mensagem do Copiloto' })
    const reason = within(dlg).getByLabelText('Motivo (opcional)') as HTMLTextAreaElement
    expect(reason.maxLength).toBe(200)
    fireEvent.change(reason, { target: { value: 'O encontro foi remarcado' } })
    await act(async () => {
      fireEvent.click(within(dlg).getByRole('button', { name: 'Recusar' }))
    })
    expect(calls(ctl, 'followupDecline')[0].args).toEqual(['8e2f3d4c-5b6a-4f7e-9d8c-0b1c2d3e4f5a', 'O encontro foi remarcado'])
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Mensagem do Copiloto' })).toBeNull())
  })

  it('fora dos 30 dias: "Abrir para enviar" mostra o motivo e não abre a caixa', async () => {
    const ctl = install()
    ctl.api.followupOpen = async () => ({ ok: false, code: 'fora_30_dias', message: FOLLOWUP_TEXT.outside30 })
    render(<Suggestions jid={ANA} />)
    const card = await screen.findByRole('group', { name: 'Mensagem do Copiloto' })
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Abrir para enviar' }))
    })
    expect((await within(card).findByRole('alert')).textContent).toBe(FOLLOWUP_TEXT.outside30)
    expect(screen.queryByRole('textbox', { name: 'Mensagem do Copiloto' })).toBeNull()
  })
})
