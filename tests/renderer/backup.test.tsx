// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackupSection } from '../../src/renderer/src/components/Backup'
import { createFakeSaga, type FakeControl } from '../../src/renderer/src/dev/fakeSaga'

let ctl: FakeControl
beforeEach(() => {
  localStorage.clear()
  ctl = createFakeSaga()
  window.saga = ctl.api
})
afterEach(() => cleanup())

describe('Configurações › Cópia de segurança', () => {
  it('exportar com senha (padrão): precisa de senha igual nos dois campos; manda as preferências da tela', async () => {
    localStorage.setItem('saga.focus', '1')
    render(<BackupSection />)
    expect(await screen.findByText(/^Última cópia:/)).toBeTruthy()
    const btn = screen.getByRole('button', { name: 'Exportar cópia' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Senha da cópia'), { target: { value: 'abc' } })
    expect(screen.getByText(/pelo menos 6/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Senha da cópia'), { target: { value: 'segredo-bom' } })
    fireEvent.change(screen.getByLabelText('Repita a senha'), { target: { value: 'segredo-bo' } })
    expect(screen.getByText('As duas senhas não são iguais.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Repita a senha'), { target: { value: 'segredo-bom' } })
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(await screen.findByText(/Cópia salva ✓.*protegida com senha/)).toBeTruthy()
    expect(ctl.calls.find((c) => c.method === 'exportBackup')!.args[0]).toEqual({ includeMessages: false, password: 'segredo-bom', uiPrefs: { 'saga.focus': '1' } })
  })

  it('sem senha e com mensagens', async () => {
    render(<BackupSection />)
    await screen.findByText(/^Última cópia:/)
    fireEvent.click(screen.getByLabelText('Proteger com senha (recomendado)'))
    fireEvent.click(screen.getByLabelText('Incluir mensagens e transcrições (arquivo maior)'))
    fireEvent.click(screen.getByRole('button', { name: 'Exportar cópia' }))
    await screen.findByText(/Cópia salva ✓/)
    expect(ctl.calls.find((c) => c.method === 'exportBackup')!.args[0]).toMatchObject({ includeMessages: true, password: undefined })
  })

  it('restaurar: senha errada mostra erro; a certa mostra o que tem; substituir pede confirmação', async () => {
    render(<BackupSection />)
    await screen.findByText(/^Última cópia:/)
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar cópia' }))
    const pw = await screen.findByLabelText('Senha desta cópia')
    fireEvent.change(pw, { target: { value: 'errada' } })
    fireEvent.click(screen.getByRole('button', { name: 'Abrir' }))
    expect(await screen.findByText('Senha incorreta. Confira e tente de novo.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Senha desta cópia'), { target: { value: 'senha123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Abrir' }))
    expect(await screen.findByText('42 respostas aprovadas')).toBeTruthy()
    expect(screen.getByText(/9 arquivos da base de conhecimento \(2 pacotes\)/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Substituir' }))
    expect(screen.getByText(/Substituir apaga/)).toBeTruthy()
    expect(ctl.calls.some((c) => c.method === 'restoreApply')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Juntar com o que já existe' }))
    expect(await screen.findByText(/Cópia restaurada ✓/)).toBeTruthy()
    expect(ctl.calls.find((c) => c.method === 'restoreApply')!.args[1]).toBe('merge')
  })

  it('cópia automática: liga/desliga, escolhe a pasta (dica da nuvem) e a senha', async () => {
    render(<BackupSection />)
    const toggle = (await screen.findByLabelText('Fazer cópia automática semanal')) as HTMLInputElement
    await waitFor(() => expect(toggle.checked).toBe(true))
    expect(screen.getByText(/também fica guardada na nuvem/)).toBeTruthy()
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.checked).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Escolher pasta' }))
    expect(await screen.findByText(/OneDrive\\SagaZap/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Tirar a senha' }))
    await waitFor(() => expect(ctl.calls.some((c) => c.method === 'setAutoBackup' && (c.args[0] as { password?: string }).password === '')).toBe(true))
  })
})
