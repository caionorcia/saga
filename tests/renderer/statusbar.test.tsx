// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StatusBar } from '../../src/renderer/src/components/StatusBar'
import { DEFAULT_STATE } from '../../src/renderer/src/dev/fakeSaga'
import type { AppState, SagaApi } from '../../src/shared/api'

const downloadUpdate = vi.fn(async () => {})
;(window as unknown as { saga: Partial<SagaApi> }).saga = { downloadUpdate }
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
