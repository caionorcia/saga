// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CopilotoSection } from '../../src/renderer/src/components/Copiloto'
import { createFakeSaga, type FakeControl } from '../../src/renderer/src/dev/fakeSaga'

const URL_OK = 'https://exemplo.supabase.co/functions/v1/sagazap-webhook'
let ctl: FakeControl
beforeEach(() => {
  ctl = createFakeSaga()
  window.saga = ctl.api
})
afterEach(() => cleanup())

describe('Configurações › Copiloto da Saga', () => {
  it('vem desligado; ligar sem endereço e código pede para configurar', async () => {
    render(<CopilotoSection />)
    const toggle = (await screen.findByLabelText('Enviar para o Copiloto da Saga')) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    fireEvent.click(toggle)
    expect(await screen.findByText(/Preencha o endereço e gere o código/)).toBeTruthy()
  })

  it('endereço inválido não salva; código aparece uma vez com Copiar; depois só "código configurado"', async () => {
    render(<CopilotoSection />)
    const input = await screen.findByLabelText('Endereço do Copiloto')
    fireEvent.change(input, { target: { value: 'http://exemplo.supabase.co/x' } })
    expect(screen.getByText(/precisa começar com https/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Salvar endereço' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(input, { target: { value: URL_OK } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar endereço' }))
    await screen.findByText('Salvo ✓')
    fireEvent.click(screen.getByRole('button', { name: 'Gerar código' }))
    const code = await screen.findByLabelText('Código do Copiloto')
    expect(code.textContent).toMatch(/demo-codigo/)
    expect(screen.getByText('código configurado ✓')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copiar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pronto' }))
    expect(screen.queryByLabelText('Código do Copiloto')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Testar conexão' }))
    expect(await screen.findByText(/Conexão ok: 24 telefone\(s\).*5 conversa\(s\)/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Enviar para o Copiloto da Saga'))
    await waitFor(() => expect(screen.getByTestId('copiloto-status').textContent).toMatch(/Pendentes: 37/))
    expect(ctl.calls.filter((c) => c.method === 'copilotoSave').map((c) => c.args[0])).toEqual([{ url: URL_OK }, { enabled: true }])
  })
})

describe('Configurações › Copiloto: envio automático dos follow-ups (v0.8.0)', () => {
  it('vem desligado, com a explicação; ligar salva autoFollowups', async () => {
    render(<CopilotoSection />)
    const toggle = (await screen.findByLabelText('Enviar follow-ups do Copiloto automaticamente')) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(screen.getByText(/saem sem a tela de confirmação, só no horário de envio/)).toBeTruthy()
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.checked).toBe(true))
    expect(ctl.calls.filter((c) => c.method === 'copilotoSave').map((c) => c.args[0])).toContainEqual({ autoFollowups: true })
  })
})

describe('Configurações › Copiloto: reenvio do histórico dos grupos (v0.8.1)', () => {
  it('só com a integração ligada; mostra a linha com as contagens', async () => {
    render(<CopilotoSection />)
    await screen.findByLabelText('Enviar para o Copiloto da Saga')
    expect(screen.queryByRole('button', { name: 'Reenviar histórico dos grupos' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Endereço do Copiloto'), { target: { value: URL_OK } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar endereço' }))
    await screen.findByText('Salvo ✓')
    fireEvent.click(screen.getByRole('button', { name: 'Gerar código' }))
    await screen.findByLabelText('Código do Copiloto')
    fireEvent.click(screen.getByLabelText('Enviar para o Copiloto da Saga'))
    fireEvent.click(await screen.findByRole('button', { name: 'Reenviar histórico dos grupos' }))
    expect(await screen.findByText('Histórico dos grupos colocado na fila ✓')).toBeTruthy()
    expect(screen.getByTestId('copiloto-group-repair').textContent).toBe(
      'Grupos: 4 grupo(s) e 212 mensagem(ns) colocados na fila para o Copiloto (1 grupo(s) sem nenhuma mensagem neste computador)'
    )
    expect(ctl.calls.some((c) => c.method === 'copilotoRepairGroups')).toBe(true)
  })
})

describe('Configurações › Copiloto: histórico dos grupos (v0.8.3)', () => {
  it('linha do histórico no Copiloto; "Buscar no celular" mostra o progresso e os grupos sem ponto de partida', async () => {
    render(<CopilotoSection />)
    await screen.findByLabelText('Enviar para o Copiloto da Saga')
    expect(screen.queryByRole('button', { name: 'Buscar no celular o histórico completo dos mentorados' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Endereço do Copiloto'), { target: { value: URL_OK } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar endereço' }))
    await screen.findByText('Salvo ✓')
    fireEvent.click(screen.getByRole('button', { name: 'Gerar código' }))
    await screen.findByLabelText('Código do Copiloto')
    fireEvent.click(screen.getByLabelText('Enviar para o Copiloto da Saga'))
    expect((await screen.findByTestId('copiloto-group-history')).textContent).toBe('Histórico dos grupos: nenhuma mensagem de grupo enviada ao Copiloto ainda')
    fireEvent.click(screen.getByRole('button', { name: 'Buscar no celular o histórico completo dos mentorados' }))
    expect(await screen.findByText(/Busca no celular começou/)).toBeTruthy()
    expect(screen.getByTestId('copiloto-history-fetch').textContent).toBe(
      'Buscando no celular: 1 de 4 conversa(s) concluída(s) · 3 pedido(s) ao celular · 120 mensagem(ns) nova(s)'
    )
    expect(screen.getByTestId('copiloto-history-no-anchor').textContent).toBe('1 grupo(s) precisam reconectar o aparelho para trazer o histórico')
    // em andamento: o botão espera
    expect((screen.getByRole('button', { name: 'Buscar no celular o histórico completo dos mentorados' }) as HTMLButtonElement).disabled).toBe(true)
    expect(ctl.calls.some((c) => c.method === 'copilotoFetchGroupHistory')).toBe(true)
  })
})
