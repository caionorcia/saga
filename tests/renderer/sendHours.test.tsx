// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Suggestions } from '../../src/renderer/src/components/Suggestions'
import { Settings } from '../../src/renderer/src/components/Settings'
import { StatusBar } from '../../src/renderer/src/components/StatusBar'
import { Conversation } from '../../src/renderer/src/components/Conversation'
import { createFakeSaga, DEFAULT_STATE, type FakeControl, type FakeOptions } from '../../src/renderer/src/dev/fakeSaga'
import { FORCE_SEND_TTL_MS, isForceSend, setForceSend } from '../../src/renderer/src/forceSend'
import type { Contact } from '../../src/shared/api'

const ANA = '5547999998888@s.whatsapp.net'
const BIA = '5511988887777@s.whatsapp.net'

function install(o: FakeOptions = {}): FakeControl {
  const ctl = createFakeSaga({ sendAutoAdvance: false, ...o })
  window.saga = ctl.api
  return ctl
}
const calls = (ctl: FakeControl, m: string) => ctl.calls.filter((c) => c.method === m)
const contact = (jid: string): Contact => ({
  jid,
  pushName: 'Ana',
  customName: null,
  hidden: false,
  notes: null,
  displayName: 'Ana',
  lastTs: 1,
  awaitingReply: true,
  isGroup: false,
  waitingSince: 1,
  alerts: [],
  needsReply: true,
  replyDecision: null
})

afterEach(() => {
  cleanup()
  setForceSend(ANA, false)
  vi.useRealTimers()
})

describe('Horário de envio: confirmação', () => {
  it('fora do horário: aviso com o próximo horário, Enviar desligado até marcar "Forçar envio"', async () => {
    const ctl = install({ outsideHours: true })
    render(<Suggestions jid={ANA} />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Enviar' }))[0])
    const dlg = await screen.findByRole('dialog', { name: 'Enviar resposta' })
    const note = await within(dlg).findByRole('note', { name: 'Horário de envio' })
    expect(note.textContent).toContain('Fora do horário de envio (Seg–Sex, 09:00–18:00). Próximo horário: segunda 09:00.')
    // o que iria sair continua visível
    expect(within(dlg).getByText('Ana Paula Souza')).toBeTruthy()
    const send = within(dlg).getByRole('button', { name: 'Enviar' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    // Ctrl+Enter também não envia
    await act(async () => {
      fireEvent.keyDown(within(dlg).getByLabelText('Mensagem'), { key: 'Enter', ctrlKey: true })
    })
    expect(calls(ctl, 'sendReply')).toHaveLength(0)

    const force = within(dlg).getByRole('checkbox', { name: /Forçar envio/ })
    expect(force.closest('label')!.textContent).toMatch(/envia agora mesmo assim/)
    fireEvent.click(force)
    const go = (await within(dlg).findByRole('button', { name: 'Enviar mesmo assim' })) as HTMLButtonElement
    await waitFor(() => expect(go.disabled).toBe(false))
    expect(calls(ctl, 'prepareSend').at(-1)!.args[0]).toMatchObject({ jid: ANA, forced: true })
    fireEvent.click(go)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls(ctl, 'sendReply')).toHaveLength(1)
    expect(await screen.findByText(/Na fila/)).toBeTruthy()
  })

  it('desmarcar "Forçar envio" volta a desligar o Enviar', async () => {
    install({ outsideHours: true })
    render(<Suggestions jid={ANA} />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Enviar' }))[0])
    const dlg = await screen.findByRole('dialog')
    const force = await within(dlg).findByRole('checkbox', { name: /Forçar envio/ })
    fireEvent.click(force)
    await within(dlg).findByRole('button', { name: 'Enviar mesmo assim' })
    fireEvent.click(within(dlg).getByRole('checkbox', { name: /Forçar envio/ }))
    await waitFor(() => expect((within(dlg).getByRole('button', { name: 'Enviar' }) as HTMLButtonElement).disabled).toBe(true))
  })

  it('dentro do horário: sem aviso nem "Forçar envio"', async () => {
    install()
    render(<Suggestions jid={ANA} />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Enviar' }))[0])
    const dlg = await screen.findByRole('dialog')
    await within(dlg).findByText('Ana Paula Souza')
    expect(within(dlg).queryByRole('note')).toBeNull()
    expect(within(dlg).queryByRole('checkbox', { name: /Forçar envio/ })).toBeNull()
  })
})

describe('Horário de envio: "Forçar envio" no cabeçalho', () => {
  const stubConversation = () => {
    window.saga = { ...window.saga, listMessages: vi.fn(async () => []), onMessages: vi.fn(() => () => {}) } as typeof window.saga
  }

  it('ligado: a confirmação dessa conversa já abre com "Forçar envio" marcado', async () => {
    install({ outsideHours: true })
    stubConversation()
    render(<Conversation contact={contact(ANA)} analysis={null} forceSendToggle />)
    const toggle = screen.getByRole('button', { name: 'Forçar envio' })
    expect(toggle.getAttribute('title')).toMatch(/30 minutos/)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Forçar envio: ligado' }).getAttribute('aria-pressed')).toBe('true')
    expect(isForceSend(ANA)).toBe(true)
    // só para esta conversa
    expect(isForceSend(BIA)).toBe(false)

    render(<Suggestions jid={ANA} />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Enviar' }))[0])
    const dlg = await screen.findByRole('dialog')
    const force = (await within(dlg).findByRole('checkbox', { name: /Forçar envio/ })) as HTMLInputElement
    expect(force.checked).toBe(true)
    await waitFor(() => expect((within(dlg).getByRole('button', { name: 'Enviar mesmo assim' }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('sem horário de envio (ou sem envio direto) o botão não aparece', () => {
    install()
    stubConversation()
    render(<Conversation contact={contact(ANA)} analysis={null} />)
    expect(screen.queryByRole('button', { name: /Forçar envio/ })).toBeNull()
  })

  it('desliga sozinho depois de 30 min e ao fechar a conversa', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    install()
    stubConversation()
    const { unmount } = render(<Conversation contact={contact(ANA)} analysis={null} forceSendToggle />)
    fireEvent.click(screen.getByRole('button', { name: 'Forçar envio' }))
    expect(isForceSend(ANA)).toBe(true)
    act(() => {
      vi.advanceTimersByTime(FORCE_SEND_TTL_MS - 1_000)
    })
    expect(isForceSend(ANA)).toBe(true)
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(isForceSend(ANA)).toBe(false)
    expect(screen.getByRole('button', { name: 'Forçar envio' }).getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'Forçar envio' }))
    expect(isForceSend(ANA)).toBe(true)
    unmount()
    expect(isForceSend(ANA)).toBe(false)
  })
})

describe('Horário de envio: barra de status', () => {
  it('fora do horário (envio direto ligado): o chip abre a seção nas Configurações', () => {
    const open = vi.fn()
    const hours = { summary: 'Seg–Sex, 09:00–18:00', nextAllowedAt: 1, next: 'segunda 09:00' }
    render(<StatusBar state={{ ...DEFAULT_STATE, sendHours: hours }} settingsOpen={false} onOpenSettings={() => {}} onOpenSendHours={open} />)
    const chip = screen.getByRole('button', { name: 'Fora do horário de envio' })
    expect(chip.getAttribute('title')).toContain('Próximo horário: segunda 09:00')
    fireEvent.click(chip)
    expect(open).toHaveBeenCalledTimes(1)
    cleanup()
    render(<StatusBar state={{ ...DEFAULT_STATE, sendHours: null }} settingsOpen={false} onOpenSettings={() => {}} />)
    expect(screen.queryByText('Fora do horário de envio')).toBeNull()
  })

  it('o falso só informa fora do horário com envio direto ligado', async () => {
    expect((await install({ outsideHours: true }).api.getState()).sendHours).toMatchObject({ next: 'segunda 09:00' })
    expect((await install().api.getState()).sendHours).toBeNull()
    expect((await install({ outsideHours: true, directSend: false }).api.getState()).sendHours).toBeNull()
  })
})

describe('Configurações › Horário de envio', () => {
  it('padrão Seg–Sex 09:00–18:00, Sáb/Dom sem envio, com o fuso do computador', async () => {
    install()
    render(<Settings />)
    const box = (await screen.findByRole('checkbox', { name: 'Só enviar nos dias e horários abaixo' })) as HTMLInputElement
    expect(box.checked).toBe(true)
    for (const d of ['Seg', 'Ter', 'Qua', 'Qui', 'Sex']) expect((screen.getByRole('checkbox', { name: d }) as HTMLInputElement).checked).toBe(true)
    for (const d of ['Sáb', 'Dom']) expect((screen.getByRole('checkbox', { name: d }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText('Início de segunda') as HTMLSelectElement).value).toBe('09:00')
    expect((screen.getByLabelText('Fim de segunda') as HTMLSelectElement).value).toBe('18:00')
    expect((screen.getByLabelText('Início de sábado') as HTMLSelectElement).disabled).toBe(true)
    // de 15 em 15 minutos
    expect([...(screen.getByLabelText('Início de segunda') as HTMLSelectElement).options].slice(0, 3).map((o) => o.value)).toEqual(['00:00', '00:15', '00:30'])
    expect(screen.getByText(/fuso America\/Sao_Paulo/)).toBeTruthy()
  })

  it('salva cada mudança; fim antes do início mostra o erro e não salva', async () => {
    const ctl = install()
    render(<Settings />)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Sáb' }))
    await waitFor(async () => expect((await ctl.api.getSettings()).sendSchedule.days[6].on).toBe(true))
    fireEvent.change(screen.getByLabelText('Fim de sábado'), { target: { value: '12:00' } })
    await waitFor(async () => expect((await ctl.api.getSettings()).sendSchedule.days[6]).toEqual({ on: true, start: '09:00', end: '12:00' }))
    expect(screen.getByText(/Agora: Seg–Sex, 09:00–18:00; Sáb, 09:00–12:00/)).toBeTruthy()

    const saves = calls(ctl, 'saveSettings').length
    fireEvent.change(screen.getByLabelText('Fim de segunda'), { target: { value: '08:00' } })
    expect((await screen.findByRole('alert')).textContent).toMatch(/O fim precisa ser depois do início \(Seg\)/)
    expect((await ctl.api.getSettings()).sendSchedule.days[1].end).toBe('18:00')
    expect(calls(ctl, 'saveSettings').length).toBe(saves)
  })

  it('desligar a regra salva e trava os dias', async () => {
    const ctl = install()
    render(<Settings />)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Só enviar nos dias e horários abaixo' }))
    await waitFor(async () => expect((await ctl.api.getSettings()).sendSchedule.enabled).toBe(false))
    expect((screen.getByRole('checkbox', { name: 'Seg' }) as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText(/Desligado: o Saga pode enviar a qualquer hora/)).toBeTruthy()
  })
})
