// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { Settings } from '../../src/renderer/src/components/Settings'
import { QrStep } from '../../src/renderer/src/components/SetupWizard'
import { DEFAULT_STATE, createFakeSaga, type FakeControl } from '../../src/renderer/src/dev/fakeSaga'
import type { AppState, RecentEvent } from '../../src/shared/api'

const QR = 'data:image/png;base64,iVBORw0KGgo='
const SLOW = /O QR Code está demorando\. Verifique a internet\/antivírus e clique em Tentar de novo\./

function install(state: Partial<AppState> = {}): FakeControl {
  const ctl = createFakeSaga({ state })
  window.saga = ctl.api
  return ctl
}
const count = (ctl: FakeControl, m: string) => ctl.calls.filter((c) => c.method === m).length
const step = (s: Partial<AppState>) => <QrStep state={{ ...DEFAULT_STATE, setupDone: false, ...s }} onBack={() => {}} />

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('passo do QR: nunca um "Preparando…" sem fim', () => {
  it('mostra a situação da conexão embaixo do QR', () => {
    install({ conn: 'needs_qr', qr: QR })
    render(step({ conn: 'needs_qr', qr: QR }))
    expect(screen.getByText(/Situação: Aguardando o QR Code/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull()
  })

  it.each([
    ['stopped_outdated', /recusou a conexão/],
    ['stopped_restricted', /restrição/],
    ['stopped_replaced', /outro lugar/],
    ['manual_retry_needed', /várias vezes/],
    ['waiting_retry', /vai tentar de novo sozinho/]
  ] as const)('%s: motivo e "Tentar de novo" (manualReconnect)', async (conn, reason) => {
    const ctl = install({ conn, qr: null })
    render(step({ conn, qr: null, retryAt: conn === 'waiting_retry' ? Date.now() + 30_000 : null }))
    const alert = screen.getAllByRole('alert').find((a) => reason.test(a.textContent ?? ''))
    expect(alert).toBeTruthy()
    expect(alert!.textContent).not.toMatch(/Reconectar/)
    expect(screen.queryByText('Preparando o QR Code…')).toBeNull()
    const before = count(ctl, 'manualReconnect')
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await waitFor(() => expect(count(ctl, 'manualReconnect')).toBe(before + 1))
  })

  it('waiting_retry mostra quando tenta de novo', () => {
    install({ conn: 'waiting_retry' })
    render(step({ conn: 'waiting_retry', qr: null, retryAt: Date.now() + 30_000 }))
    expect(screen.getByText(/Situação: Reconectando em \d+ s/)).toBeTruthy()
  })

  it('falha ao iniciar: mostra o erro e "Tentar de novo"', async () => {
    const ctl = install({ conn: 'connecting' })
    render(step({ conn: 'connecting', qr: null, startError: 'banco travado' }))
    expect(screen.getByText(/Situação: Erro ao iniciar/)).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toMatch(/não conseguiu iniciar.*banco travado/)
    const before = count(ctl, 'manualReconnect')
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await waitFor(() => expect(count(ctl, 'manualReconnect')).toBe(before + 1))
  })

  it('45 s sem QR: aviso, "Tentar de novo" e "Ver detalhes" com eventos e diagnóstico', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const ctl = install({ conn: 'needs_qr', qr: null })
    const events: RecentEvent[] = [
      { id: 2, ts: Date.now(), kind: 'wa_closed', detail: 'código 405: Connection Failure' },
      { id: 1, ts: Date.now() - 1000, kind: 'wa_outdated_retry', detail: 'buscando a versão atual' }
    ]
    const recent = vi.fn(async (_n: number) => events)
    ctl.api.recentEvents = recent
    const { rerender } = render(step({ conn: 'connecting', qr: null }))
    expect(screen.getByText('Preparando o QR Code…')).toBeTruthy()
    act(() => void vi.advanceTimersByTime(44_000))
    expect(screen.queryByText(SLOW)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Ver detalhes' })).toBeNull()
    act(() => void vi.advanceTimersByTime(1_500))
    expect(screen.getByText(SLOW)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Ver detalhes' }))
    await act(async () => {})
    expect(recent).toHaveBeenCalledWith(10)
    expect(screen.getByText('Conexão com o WhatsApp caiu')).toBeTruthy()
    expect(screen.getByText(/código 405: Connection Failure/)).toBeTruthy()
    expect(screen.getByText('WhatsApp pediu versão nova: tentando de novo')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copiar diagnóstico' }))
    await act(async () => {})
    expect(count(ctl, 'copyDiagnostics')).toBe(1)
    expect(screen.getByText(/Diagnóstico copiado/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Abrir pasta de registros' }))
    await act(async () => {})
    expect(count(ctl, 'openLogsFolder')).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await act(async () => {})
    expect(count(ctl, 'manualReconnect')).toBeGreaterThanOrEqual(1)
    // o QR chegou: o aviso some
    rerender(step({ conn: 'needs_qr', qr: QR }))
    expect(screen.queryByText(SLOW)).toBeNull()
    expect(screen.getByAltText('QR Code para vincular o WhatsApp')).toBeTruthy()
  })

  it('com QR na tela o aviso de demora nunca aparece', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    install({ conn: 'needs_qr', qr: QR })
    render(step({ conn: 'needs_qr', qr: QR }))
    act(() => void vi.advanceTimersByTime(120_000))
    expect(screen.queryByText(SLOW)).toBeNull()
  })
})

describe('tela principal: painel de vincular de novo', () => {
  it('needs_qr sem imagem por 45 s mostra o aviso de demora e os detalhes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    install({ conn: 'needs_qr', qr: null })
    render(<App />)
    await act(async () => {})
    expect(screen.getByText('Preparando o QR Code…')).toBeTruthy()
    await act(async () => void vi.advanceTimersByTime(46_000))
    expect(screen.getByText(SLOW)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ver detalhes' })).toBeTruthy()
  })
})

describe('configurações: diagnóstico', () => {
  it('"Copiar diagnóstico" e "Abrir pasta de registros"', async () => {
    const ctl = install()
    render(<Settings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Copiar diagnóstico' }))
    await waitFor(() => expect(count(ctl, 'copyDiagnostics')).toBe(1))
    fireEvent.click(screen.getByRole('button', { name: 'Abrir pasta de registros' }))
    await waitFor(() => expect(count(ctl, 'openLogsFolder')).toBe(1))
  })
})

describe('tela principal: falha ao iniciar', () => {
  it('mostra o alerta com o erro e "Reconectar"', async () => {
    const ctl = install({ conn: 'connecting', startError: 'banco travado' })
    render(<App />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/não conseguiu iniciar.*banco travado/)
    fireEvent.click(screen.getByRole('button', { name: 'Reconectar' }))
    await waitFor(() => expect(count(ctl, 'manualReconnect')).toBe(1))
  })
})
