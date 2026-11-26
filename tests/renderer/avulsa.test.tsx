// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Suggestions, type DraftStore } from '../../src/renderer/src/components/Suggestions'
import { createFakeSaga, type FakeControl, type FakeOptions } from '../../src/renderer/src/dev/fakeSaga'

const ANA = '5547999998888@s.whatsapp.net'
const JOAO = '5585966665555@s.whatsapp.net'
const GRP = '120363025555555555@g.us'
const AVULSA = 'Enviar mensagem avulsa'

function install(o: FakeOptions = {}): FakeControl {
  const ctl = createFakeSaga({ sendAutoAdvance: false, ...o })
  window.saga = ctl.api
  return ctl
}
const calls = (ctl: FakeControl, m: string) => ctl.calls.filter((c) => c.method === m)

afterEach(cleanup)

describe('Enviar mensagem avulsa (v0.6.0)', () => {
  it('conversa que não precisa de resposta: o botão fica logo abaixo de "Gerar sugestões mesmo assim"', async () => {
    install()
    render(<Suggestions jid={JOAO} />)
    const gerar = await screen.findByRole('button', { name: 'Gerar sugestões mesmo assim' })
    const btn = screen.getByRole('button', { name: AVULSA })
    expect(gerar.closest('.sug-not-needed')!.nextElementSibling).toBe(btn)
    // secundário: não é o botão principal
    expect(btn.className).not.toMatch(/btn-primary/)
  })

  it('com sugestões: o botão fica no fim da coluna; sem envio direto, não aparece', async () => {
    install()
    const { unmount } = render(<Suggestions jid={ANA} />)
    await screen.findAllByRole('button', { name: 'Copiar' })
    const btn = screen.getByRole('button', { name: AVULSA })
    const footer = screen.getByRole('button', { name: 'Gerar novas' }).closest('.sug-footer')!
    expect(footer.nextElementSibling).toBe(btn)
    expect(btn.className).not.toMatch(/btn-primary/)
    unmount()
    install({ directSend: false })
    render(<Suggestions jid={ANA} />)
    await screen.findAllByRole('button', { name: 'Copiar' })
    expect(screen.queryByRole('button', { name: AVULSA })).toBeNull()
  })

  it('escreve, confirma no mesmo diálogo (sem citação, nem no grupo) e vai pela fila sem tocar na memória', async () => {
    const ctl = install()
    render(<Suggestions jid={GRP} />)
    await screen.findAllByRole('button', { name: 'Copiar' })
    fireEvent.click(screen.getByRole('button', { name: AVULSA }))
    const card = screen.getByRole('group', { name: 'Mensagem avulsa' })
    const box = within(card).getByRole('textbox', { name: 'Mensagem avulsa' }) as HTMLTextAreaElement
    const enviar = within(card).getByRole('button', { name: 'Enviar' }) as HTMLButtonElement
    expect(enviar.disabled).toBe(true)
    fireEvent.change(box, { target: { value: 'Pessoal, a aula de quinta começa 19h.' } })
    fireEvent.click(enviar)
    const dlg = await screen.findByRole('dialog', { name: 'Enviar mensagem avulsa' })
    await within(dlg).findByText('Mentoria Turma 3 — Negócios')
    // no grupo, a resposta citaria; a avulsa nunca cita
    expect(within(dlg).queryByLabelText('Mensagem citada')).toBeNull()
    expect(within(dlg).getByText(/não responde a nenhuma mensagem/)).toBeTruthy()
    expect(calls(ctl, 'prepareSend').at(-1)!.args[0]).toMatchObject({ jid: GRP, kind: 'avulsa', forced: false })
    await act(async () => {
      fireEvent.keyDown(within(dlg).getByLabelText('Mensagem'), { key: 'Enter', ctrlKey: true })
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const [sent] = calls(ctl, 'sendAvulsa')
    expect(sent.args[0]).toMatchObject({ jid: GRP, text: 'Pessoal, a aula de quinta começa 19h.', draftId: expect.stringMatching(/^[A-Za-z0-9-]{8,64}$/) })
    expect(sent.args[0]).not.toHaveProperty('replyId')
    expect(calls(ctl, 'sendReply')).toHaveLength(0)
    expect(calls(ctl, 'saveReply')).toHaveLength(0)
    // o estado aparece embaixo da caixa, e o texto na fila não muda
    expect(await within(card).findByText(/Na fila — envia em/)).toBeTruthy()
    expect(box.readOnly).toBe(true)
    expect(within(card).queryByRole('button', { name: 'Enviar' })).toBeNull()
    // nenhum cartão de sugestão passou a mostrar esse envio
    expect(screen.getAllByText(/Na fila — envia em/)).toHaveLength(1)
    // enviada: "Nova mensagem avulsa" abre um rascunho novo (outro id)
    act(() => ctl.setSend(ctl.lastSend()!.id, { status: 'sent', sentAt: Date.now(), etaAt: null }))
    fireEvent.click(await within(card).findByRole('button', { name: 'Nova mensagem avulsa' }))
    expect(box.value).toBe('')
    fireEvent.change(box, { target: { value: 'Outra.' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Enviar' }))
    const dlg2 = await screen.findByRole('dialog', { name: 'Enviar mensagem avulsa' })
    await within(dlg2).findByText('Mentoria Turma 3 — Negócios')
    await act(async () => {
      fireEvent.click(within(dlg2).getByRole('button', { name: 'Enviar' }))
    })
    await waitFor(() => expect(calls(ctl, 'sendAvulsa')).toHaveLength(2))
    const ids = calls(ctl, 'sendAvulsa').map((c) => (c.args[0] as { draftId: string }).draftId)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('o rascunho sobrevive a trocar de tela (mesmo id); "Descartar" fecha e esquece', async () => {
    install()
    const drafts: DraftStore = new Map()
    const first = render(<Suggestions jid={JOAO} drafts={drafts} />)
    fireEvent.click(await screen.findByRole('button', { name: AVULSA }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Mensagem avulsa' }), { target: { value: 'Rascunho guardado' } })
    const id = drafts.get(`avulsa|${JOAO}`)!.draftId
    expect(id).toBeTruthy()
    // o rascunho da avulsa não segura a troca de sugestões (não é edição de cartão)
    expect([...drafts.keys()].some((k) => k.startsWith(`${JOAO}:`))).toBe(false)
    first.unmount()
    render(<Suggestions jid={JOAO} drafts={drafts} />)
    expect(((await screen.findByRole('textbox', { name: 'Mensagem avulsa' })) as HTMLTextAreaElement).value).toBe('Rascunho guardado')
    expect(drafts.get(`avulsa|${JOAO}`)!.draftId).toBe(id)
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }))
    expect(screen.queryByRole('textbox', { name: 'Mensagem avulsa' })).toBeNull()
    expect(drafts.has(`avulsa|${JOAO}`)).toBe(false)
    expect(screen.getByRole('button', { name: AVULSA })).toBeTruthy()
  })
})
