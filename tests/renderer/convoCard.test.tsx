// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Suggestions } from '../../src/renderer/src/components/Suggestions'
import { createFakeSaga, type FakeControl, type FakeOptions } from '../../src/renderer/src/dev/fakeSaga'

const GRP = '120363025555555555@g.us'
const ID = '9f3a4e5d-6c7b-4a8f-8e9d-1c2d3e4f5a6b'

function install(o: FakeOptions = {}): FakeControl {
  try {
    localStorage.clear()
  } catch {
    // sem armazenamento
  }
  const ctl = createFakeSaga({ sendAutoAdvance: false, followups: false, ...o })
  window.saga = ctl.api
  return ctl
}
const calls = (ctl: FakeControl, m: string) => ctl.calls.filter((c) => c.method === m)

afterEach(cleanup)

describe('Follow-up de conversa no grupo (v0.10.0)', () => {
  it('cartão no topo: "Follow-up Sumido — tentativa 2 de 4", objetivo, rascunho editável; "Enviar" manda o texto editado', async () => {
    const ctl = install({ convo: 'draft' })
    render(<Suggestions jid={GRP} />)
    const card = await screen.findByRole('group', { name: 'Follow-up Sumido' })
    expect(within(card).getByText(/Follow-up Sumido — tentativa 2 de 4/)).toBeTruthy()
    expect(within(card).getByText(/Conseguir uma resposta/)).toBeTruthy()
    expect(within(card).getByText(/Link da agenda: https:\/\/example.com\/agenda/)).toBeTruthy()
    for (const name of ['Enviar', 'Pular esta tentativa', 'Encerrar', 'Reunião marcada']) expect(within(card).getByRole('button', { name })).toBeTruthy()
    // nada sai sozinho
    expect(calls(ctl, 'convoAction')).toHaveLength(0)
    const box = within(card).getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'Oi! Bora conversar?' } })
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Enviar' }))
    })
    expect(calls(ctl, 'convoAction')[0].args).toEqual([ID, { kind: 'send', draftId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', text: 'Oi! Bora conversar?' }])
    expect(await within(card).findByText(/Confirmado ✓/)).toBeTruthy()
  })

  it('"Encerrar" pede confirmação antes de ir ao Copiloto como recusado', async () => {
    const ctl = install({ convo: 'draft' })
    render(<Suggestions jid={GRP} />)
    const card = await screen.findByRole('group', { name: 'Follow-up Sumido' })
    fireEvent.click(within(card).getByRole('button', { name: 'Encerrar' }))
    expect(calls(ctl, 'convoAction')).toHaveLength(0)
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Sim, encerrar' }))
    })
    expect(calls(ctl, 'convoAction')[0].args).toEqual([ID, { kind: 'decline' }])
  })

  it('"Precisa de você": aviso sem rascunho, com "Gerar rascunho mesmo assim" e "Já resolvi"', async () => {
    install({ convo: 'needs' })
    render(<Suggestions jid={GRP} />)
    const card = await screen.findByRole('group', { name: 'Follow-up Sumido' })
    const alert = within(card).getByRole('alert')
    expect(alert.textContent).toMatch(/Precisa de você/)
    expect(alert.textContent).toMatch(/parcelar/)
    expect(within(card).queryByRole('textbox')).toBeNull()
    expect(within(card).getByRole('button', { name: 'Gerar rascunho mesmo assim' })).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Já resolvi' })).toBeTruthy()
  })
})
