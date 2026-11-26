// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Settings } from '../../src/renderer/src/components/Settings'
import { SetupWizard } from '../../src/renderer/src/components/SetupWizard'
import { createFakeSaga, DEFAULT_STATE } from '../../src/renderer/src/dev/fakeSaga'
import { updateCheckText, updateErrorText } from '../../src/renderer/src/format'
import type { AppState } from '../../src/shared/api'

afterEach(cleanup)

const section = () => screen.getByRole('region', { name: 'Atualizações' })

describe('Configurações › Atualizações', () => {
  it('mostra a versão instalada e "Verificar agora" mostra o resultado', async () => {
    const ctl = createFakeSaga()
    window.saga = ctl.api
    render(<Settings />)
    await waitFor(() => expect(section()).toBeTruthy())
    expect(within(section()).getByText('0.2.3')).toBeTruthy()
    expect(within(section()).getByText('Ainda não procurou nesta sessão.')).toBeTruthy()
    fireEvent.click(within(section()).getByRole('button', { name: 'Verificar agora' }))
    await waitFor(() => expect(within(section()).getByText(/você já está na versão mais nova/)).toBeTruthy())
    expect(ctl.calls.filter((c) => c.method === 'checkForUpdates')).toHaveLength(1)
  })

  it('com versão nova: o resultado e o botão "Atualizar" aparecem ali também', async () => {
    const ctl = createFakeSaga({ state: { update: { status: 'available', version: '0.2.4' } } })
    window.saga = ctl.api
    render(<Settings />)
    await waitFor(() => expect(section()).toBeTruthy())
    fireEvent.click(within(section()).getByRole('button', { name: 'Verificar agora' }))
    await waitFor(() => expect(within(section()).getByText(/nova versão disponível \(0\.2\.4\)/)).toBeTruthy())
    expect(within(section()).getByRole('button', { name: 'Atualizar' })).toBeTruthy()
  })

  it('app de desenvolvimento: "Verificar agora" desligado, com a explicação', async () => {
    const ctl = createFakeSaga({ state: { updateCheck: { ...DEFAULT_STATE.updateCheck, enabled: false } } })
    window.saga = ctl.api
    render(<Settings />)
    await waitFor(() => expect(section()).toBeTruthy())
    expect((within(section()).getByRole('button', { name: 'Verificar agora' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(section()).getByText(/não procura atualizações sozinho/)).toBeTruthy()
  })
})

describe('textos da procura', () => {
  const base: AppState['updateCheck'] = { ...DEFAULT_STATE.updateCheck, lastCheckAt: new Date(2026, 10, 26, 9, 5).getTime() }
  it('erro de rede vira "sem conexão"; outros erros passam como estão', () => {
    expect(updateErrorText('net::ERR_INTERNET_DISCONNECTED')).toMatch(/sem conexão com a internet/)
    expect(updateErrorText('getaddrinfo ENOTFOUND github.com')).toMatch(/sem conexão/)
    expect(updateErrorText('HttpError: 404')).toMatch(/não foi encontrada/)
    expect(updateErrorText('algo estranho')).toBe('algo estranho')
  })
  it('última procura com hora e resultado', () => {
    expect(updateCheckText({ ...base, lastResult: 'up_to_date' }, { status: 'none' })).toMatch(/09:05 — você já está na versão mais nova/)
    expect(updateCheckText({ ...base, lastResult: 'error', lastError: 'ETIMEDOUT' }, { status: 'none' })).toMatch(/não foi possível verificar: sem conexão/)
    expect(updateCheckText({ ...base, checking: true }, { status: 'none' })).toBe('Procurando uma versão nova…')
  })
})

describe('assistente: aviso de versão nova', () => {
  it('aparece no assistente e baixa pelo mesmo botão', async () => {
    const ctl = createFakeSaga()
    window.saga = ctl.api
    const state: AppState = { ...DEFAULT_STATE, setupDone: false, update: { status: 'available', version: '0.2.4' } }
    render(<SetupWizard state={state} onFinish={() => {}} />)
    expect(screen.getByText(/Nova versão disponível \(0\.2\.4\)/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Atualizar' })).toBeTruthy()
    cleanup()
    render(<SetupWizard state={{ ...state, update: { status: 'none' } }} onFinish={() => {}} />)
    expect(screen.queryByText(/Nova versão disponível/)).toBeNull()
  })
})
