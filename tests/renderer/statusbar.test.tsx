// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StatusBar } from '../../src/renderer/src/components/StatusBar'
import { DEFAULT_STATE } from '../../src/renderer/src/dev/fakeSaga'
import type { AppState, SagaApi } from '../../src/shared/api'

const downloadUpdate = vi.fn(async () => {})
const installUpdate = vi.fn(async () => {})
;(window as unknown as { saga: Partial<SagaApi> }).saga = { downloadUpdate, installUpdate }
afterEach(cleanup)

const show = (update: AppState['update']) =>
  render(<StatusBar state={{ ...DEFAULT_STATE, update }} settingsOpen={false} onOpenSettings={() => {}} />)

describe('StatusBar: atualização', () => {
  it('sem atualização não mostra aviso', () => {
    show({ status: 'none' })
    expect(screen.queryByText(/Nova versão disponível/)).toBeNull()
  })

  it('"Nova versão disponível — Atualizar" chama downloadUpdate', async () => {
    show({ status: 'available', version: '0.2.0' })
    expect(screen.getByText(/Nova versão disponível/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
    await waitFor(() => expect(downloadUpdate).toHaveBeenCalledTimes(1))
  })

  it('baixando e pronta mostram texto sem botão', () => {
    show({ status: 'downloading', version: '0.2.0' })
    expect(screen.getByText('Baixando a nova versão…')).toBeTruthy()
    cleanup()
    show({ status: 'ready', version: '0.2.0' })
    expect(screen.getByText(/será instalada quando você fechar/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Atualizar' })).toBeNull()
  })
})

describe('StatusBar: reiniciar e atualizar', () => {
  it('atualização pronta oferece "Reiniciar e atualizar" (installUpdate)', async () => {
    show({ status: 'ready', version: '0.2.0' })
    fireEvent.click(screen.getByRole('button', { name: 'Reiniciar e atualizar' }))
    await waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1))
  })
})

describe('StatusBar: estado', () => {
  const render2 = (patch: Partial<AppState>) =>
    render(<StatusBar state={{ ...DEFAULT_STATE, ...patch }} settingsOpen={false} onOpenSettings={() => {}} />)

  it('restrição com a fila pausada mostra a restrição, não "Pausado"', () => {
    render2({ conn: 'stopped_restricted', paused: true })
    expect(screen.getByText('Conta restrita pelo WhatsApp')).toBeTruthy()
    expect(screen.queryByText('Pausado')).toBeNull()
  })

  it('progresso só dos downloads do lote atual; transcrição pausada pelo teto de gasto', () => {
    render2({
      queue: { ...DEFAULT_STATE.queue, pending: 500, done: 9000 },
      downloads: { remaining: 3, done: 2 },
      transcribePaused: true,
      transcribePausedReason: 'budget'
    })
    expect(screen.getByText('Baixando áudios: 2 de 5')).toBeTruthy()
    expect(screen.getByText('Transcrição pausada — teto de gasto de hoje atingido')).toBeTruthy()
  })
})
