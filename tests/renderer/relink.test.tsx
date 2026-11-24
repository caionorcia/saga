// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { QrStep } from '../../src/renderer/src/components/SetupWizard'
import { DEFAULT_STATE, createFakeSaga, type FakeControl } from '../../src/renderer/src/dev/fakeSaga'
import type { AppState } from '../../src/shared/api'

const QR = 'data:image/png;base64,iVBORw0KGgo='
const INSTRUCTION = /WhatsApp › Aparelhos conectados › Conectar um aparelho/

function install(state: Partial<AppState>): FakeControl {
  const ctl = createFakeSaga({ state })
  window.saga = ctl.api
  return ctl
}

afterEach(cleanup)

describe('App: vincular de novo (QR fora do assistente)', () => {
  it('com o assistente já concluído, um QR novo aparece na tela principal com a instrução', async () => {
    const ctl = install({ conn: 'stopped_logged_out', paused: true })
    render(<App />)
    expect(await screen.findByText('Desconectado — vincule novamente')).toBeTruthy()
    expect(screen.queryByAltText(/QR Code/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reconectar' }))
    await waitFor(() => expect(ctl.calls.some((c) => c.method === 'manualReconnect')).toBe(true))
    act(() => ctl.setState({ conn: 'needs_qr', qr: QR }))
    const img = await screen.findByAltText('QR Code para vincular o WhatsApp')
    expect(img.getAttribute('src')).toBe(QR)
    expect(screen.getAllByText(INSTRUCTION).length).toBeGreaterThan(0)
    const before = ctl.calls.filter((c) => c.method === 'manualReconnect').length
    fireEvent.click(screen.getByRole('button', { name: 'Gerar novo QR Code' }))
    await waitFor(() => expect(ctl.calls.filter((c) => c.method === 'manualReconnect').length).toBe(before + 1))
    act(() => ctl.setState({ conn: 'open', qr: null }))
    await waitFor(() => expect(screen.queryByAltText('QR Code para vincular o WhatsApp')).toBeNull())
  })

  it('needs_qr ainda sem imagem mostra o painel com "Preparando o QR Code…"', async () => {
    install({ conn: 'needs_qr', qr: null })
    render(<App />)
    expect(await screen.findByText('Preparando o QR Code…')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Gerar novo QR Code' })).toBeTruthy()
  })

  it('restrição: alerta com o texto explicativo e "Reconectar"', async () => {
    install({ conn: 'stopped_restricted', paused: true })
    render(<App />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/restrição/)
    expect(screen.getByText('Conta restrita pelo WhatsApp')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reconectar' })).toBeTruthy()
  })
})

describe('Assistente: passo do QR', () => {
  let ctl: FakeControl
  const calls = () => ctl.calls.filter((c) => c.method === 'manualReconnect').length

  it.each(['manual_retry_needed', 'waiting_retry', 'connecting'] as const)('entrar no passo com %s pede um QR novo', async (conn) => {
    ctl = install({ conn, qr: null, setupDone: false })
    render(<QrStep state={{ ...DEFAULT_STATE, conn, qr: null }} onBack={() => {}} />)
    await waitFor(() => expect(calls()).toBe(1))
  })

  it.each(['needs_qr', 'open'] as const)('com %s não reconecta sozinho', async (conn) => {
    ctl = install({ conn })
    render(<QrStep state={{ ...DEFAULT_STATE, conn, qr: conn === 'needs_qr' ? QR : null }} onBack={() => {}} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(calls()).toBe(0)
  })

  it('"Gerar novo QR Code" pede um QR novo', async () => {
    ctl = install({ conn: 'needs_qr', qr: QR })
    render(<QrStep state={{ ...DEFAULT_STATE, conn: 'needs_qr', qr: QR }} onBack={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Gerar novo QR Code' }))
    await waitFor(() => expect(calls()).toBe(1))
  })
})
