// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Suggestions } from '../../src/renderer/src/components/Suggestions'
import { Settings } from '../../src/renderer/src/components/Settings'
import { createFakeSaga, type FakeControl, type FakeOptions } from '../../src/renderer/src/dev/fakeSaga'
import { sendStatusText } from '../../src/renderer/src/format'
import type { SendView } from '../../src/shared/api'

const ANA = '5547999998888@s.whatsapp.net'
const GRP = '120363025555555555@g.us'

function install(o: FakeOptions = {}): FakeControl {
  const ctl = createFakeSaga({ sendAutoAdvance: false, ...o })
  window.saga = ctl.api
  return ctl
}
const calls = (ctl: FakeControl, m: string) => ctl.calls.filter((c) => c.method === m)

afterEach(cleanup)

describe('Enviar (envio direto)', () => {
  it('o botão Enviar aparece ao lado de Salvar/Copiar; some com o envio direto desligado', async () => {
    install()
    const { unmount } = render(<Suggestions jid={ANA} />)
    const sends = await screen.findAllByRole('button', { name: 'Enviar' })
    expect(sends.length).toBe(screen.getAllByRole('button', { name: 'Copiar' }).length)
    unmount()
    install({ directSend: false })
    render(<Suggestions jid={ANA} />)
    await screen.findAllByRole('button', { name: 'Copiar' })
    expect(screen.queryByRole('button', { name: 'Enviar' })).toBeNull()
  })

  it('confirmação: para quem vai (nome e número), texto editável, Ctrl+Enter confirma; o cartão mostra a fila', async () => {
    const ctl = install()
    render(<Suggestions jid={ANA} />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Enviar' }))[0])
    const dlg = await screen.findByRole('dialog', { name: 'Enviar resposta' })
    expect(within(dlg).getByText('Ana Paula Souza')).toBeTruthy()
    expect(within(dlg).getByText(/\+55 47 99999-8888/)).toBeTruthy()
    expect(within(dlg).queryByLabelText('Mensagem citada')).toBeNull()
    // nada foi enviado só por abrir
    expect(calls(ctl, 'sendReply')).toHaveLength(0)
    const box = within(dlg).getByLabelText('Mensagem')
    fireEvent.change(box, { target: { value: 'Texto final editado no diálogo' } })
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // o texto mudou: nova confirmação para o texto novo, e o envio usa esse token
    const prepares = calls(ctl, 'prepareSend')
    expect(prepares.at(-1)!.args[0]).toEqual({ jid: ANA, text: 'Texto final editado no diálogo', forced: false })
    const [send] = calls(ctl, 'sendReply')
    expect(send.args[0]).toMatchObject({ jid: ANA, text: 'Texto final editado no diálogo', chosenIndex: 0, analysisLastMsgId: expect.any(String) })
    // escolheu a sugestão (salva na memória, como Copiar/Salvar)
    expect(calls(ctl, 'saveReply')[0].args[0]).toMatchObject({ finalText: 'Texto final editado no diálogo', chosenIndex: 0 })
    expect(await screen.findByText(/Na fila — envia em 4\d s/)).toBeTruthy()
    expect(screen.getByText('✓ Resposta escolhida')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Enviar' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar envio' }))
    expect(await screen.findByText('Envio cancelado')).toBeTruthy()
  })

  it('Ctrl+Enter repetido (ou clique duplo) envia uma vez só', async () => {
    const ctl = install()
    render(<Suggestions jid={ANA} />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Enviar' }))[0])
    const dlg = await screen.findByRole('dialog')
    await within(dlg).findByText('Ana Paula Souza')
    const box = within(dlg).getByLabelText('Mensagem')
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
      fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
      fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls(ctl, 'sendReply')).toHaveLength(1)
  })

  it('conexão caiu antes de enviar: o cartão pergunta "Enviar de novo?" e o botão abre uma nova confirmação', async () => {
    const ctl = install()
    render(<Suggestions jid={ANA} />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Enviar' }))[0])
    const dlg = await screen.findByRole('dialog')
    await within(dlg).findByText('Ana Paula Souza')
    await act(async () => {
      fireEvent.click(within(dlg).getByRole('button', { name: 'Enviar' }))
    })
    await screen.findByText(/Na fila/)
    act(() => ctl.setSend(ctl.lastSend()!.id, { status: 'expired', error: 'a conexão caiu antes de enviar', etaAt: null }))
    expect(await screen.findByText('Não enviada — a conexão caiu. Enviar de novo?')).toBeTruthy()
    const before = calls(ctl, 'prepareSend').length
    fireEvent.click(screen.getByRole('button', { name: 'Enviar de novo' }))
    await screen.findByRole('dialog')
    await waitFor(() => expect(calls(ctl, 'prepareSend').length).toBe(before + 1))
  })

  it('Cancelar fecha o diálogo sem enviar nada', async () => {
    const ctl = install()
    render(<Suggestions jid={ANA} />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Enviar' }))[1])
    const dlg = await screen.findByRole('dialog')
    await within(dlg).findByText('Ana Paula Souza')
    fireEvent.click(within(dlg).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls(ctl, 'sendReply')).toHaveLength(0)
    expect(calls(ctl, 'saveReply')).toHaveLength(0)
  })

  it('grupo: mostra o grupo e a mensagem que vai ser citada', async () => {
    install()
    render(<Suggestions jid={GRP} />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Enviar' }))[0])
    const dlg = await screen.findByRole('dialog')
    expect(await within(dlg).findByText('Mentoria Turma 3 — Negócios')).toBeTruthy()
    expect(within(dlg).getByText(/Para o grupo/)).toBeTruthy()
    const quote = within(dlg).getByLabelText('Mensagem citada')
    expect(quote.textContent).toMatch(/^Respondendo a /)
  })

  it('estados: digitando, enviada às HH:MM, não sei se foi (conferir → enviar de novo com nova confirmação)', async () => {
    const ctl = install()
    render(<Suggestions jid={ANA} />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Enviar' }))[0])
    const dlg = await screen.findByRole('dialog')
    await within(dlg).findByText('Ana Paula Souza')
    await act(async () => {
      fireEvent.click(within(dlg).getByRole('button', { name: 'Enviar' }))
    })
    await screen.findByText(/Na fila/)
    const id = ctl.lastSend()!.id
    act(() => ctl.setSend(id, { status: 'typing', etaAt: null }))
    expect(await screen.findByText('Digitando…')).toBeTruthy()
    const at = new Date(2026, 10, 26, 14, 7).getTime()
    act(() => ctl.setSend(id, { status: 'sent', sentAt: at }))
    expect(await screen.findByText('Enviada ✓ às 14:07')).toBeTruthy()

    act(() => ctl.setSend(id, { status: 'unknown', sentAt: null }))
    fireEvent.click(await screen.findByRole('button', { name: 'Conferir' }))
    expect(await screen.findByText(/não apareceu nesta conversa/)).toBeTruthy()
    expect(calls(ctl, 'checkSend')).toHaveLength(1)
    const before = calls(ctl, 'prepareSend').length
    fireEvent.click(screen.getByRole('button', { name: 'Enviar de novo' }))
    await screen.findByRole('dialog')
    await waitFor(() => expect(calls(ctl, 'prepareSend').length).toBe(before + 1))

    cleanup()
  })

  it('textos do estado', () => {
    const base: SendView = { id: 1, jid: ANA, replyId: 1, text: 'x', status: 'queued', queuedAt: 0, etaAt: 42_000, waitingFor: null, sentAt: null, error: null }
    expect(sendStatusText(base, 0)).toBe('Na fila — envia em 42 s')
    expect(sendStatusText({ ...base, etaAt: 65_000 }, 0)).toBe('Na fila — envia em 1 min 05 s')
    expect(sendStatusText({ ...base, etaAt: 0 }, 10)).toBe('Na fila — envia já')
    expect(sendStatusText({ ...base, waitingFor: 'paused' }, 0)).toMatch(/pausado/)
    expect(sendStatusText({ ...base, waitingFor: 'connection' }, 0)).toMatch(/esperando o WhatsApp/)
    expect(sendStatusText({ ...base, status: 'failed' })).toBe('Não enviada — tentar de novo')
    expect(sendStatusText({ ...base, status: 'unknown' })).toBe('Não sei se foi enviada — conferir')
    expect(sendStatusText({ ...base, status: 'expired' })).toBe('Não enviada — aguardando confirmação')
    expect(sendStatusText({ ...base, status: 'expired', error: 'a conexão caiu antes de enviar' })).toBe('Não enviada — a conexão caiu. Enviar de novo?')
    expect(sendStatusText({ ...base, status: 'expired', error: 'pausado' })).toBe('Não enviada — você pausou. Enviar de novo?')
    expect(sendStatusText({ ...base, status: 'expired', error: 'fora do horário de envio' })).toBe('Não enviada — fora do horário de envio. Enviar de novo?')
  })
})

describe('Configurações › Envio direto', () => {
  it('liga/desliga o envio e as três opções (padrão: tudo ligado)', async () => {
    const ctl = install()
    render(<Settings />)
    const main = await screen.findByRole('checkbox', { name: 'Mostrar o botão Enviar nas sugestões' })
    for (const name of [/digitando/, /Marcar como lidas/, /citar a mensagem/]) {
      expect((screen.getByRole('checkbox', { name }) as HTMLInputElement).checked).toBe(true)
    }
    expect((main as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /Marcar como lidas/ }))
    await waitFor(async () => expect((await ctl.api.getSettings()).sendMarkRead).toBe(false))
    fireEvent.click(main)
    await waitFor(async () => expect((await ctl.api.getSettings()).directSend).toBe(false))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /digitando/ }).closest('fieldset')!.disabled).toBe(true))
  })
})
