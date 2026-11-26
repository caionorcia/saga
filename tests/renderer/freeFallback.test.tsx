// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FREE_FALLBACK_PRIVACY, Settings } from '../../src/renderer/src/components/Settings'
import { providerLabel } from '../../src/renderer/src/components/Suggestions'
import { createFakeSaga } from '../../src/renderer/src/dev/fakeSaga'

afterEach(() => cleanup())

describe('IAs gratuitas de reserva', () => {
  it('Configurações: Gemini e Mistral desligados, aviso de privacidade visível, "Testar" e salvar a chave', async () => {
    const ctl = createFakeSaga()
    window.saga = ctl.api
    render(<Settings />)
    expect(await screen.findByText('IAs gratuitas de reserva (opcional)')).toBeTruthy()
    expect(screen.getByText(FREE_FALLBACK_PRIVACY)).toBeTruthy()
    expect(FREE_FALLBACK_PRIVACY).toMatch(/Use só se concordar\.$/)
    const gem = screen.getByText('Gemini (Google, gratuito)').closest('.key-row') as HTMLElement
    const mis = screen.getByText('Mistral (gratuito)').closest('.key-row') as HTMLElement
    expect(within(gem).getByText('não configurada')).toBeTruthy()
    expect(within(mis).getByText('não configurada')).toBeTruthy()
    fireEvent.click(within(gem).getByRole('button', { name: 'Adicionar' }))
    fireEvent.change(within(gem).getByLabelText('Nova chave do Gemini (Google, gratuito)'), { target: { value: 'AIza-chave-teste' } })
    fireEvent.click(within(gem).getByRole('button', { name: 'Testar' }))
    expect(await within(gem).findByText('Funcionando ✓')).toBeTruthy()
    fireEvent.click(within(gem).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(within(gem).getByText('configurada ✓')).toBeTruthy())
    expect((await ctl.api.getSettings()).keys).toMatchObject({ gemini: true, mistral: false })
  })

  it('"Gerado por" mostra a reserva que respondeu', () => {
    expect(providerLabel('gemini')).toBe('Gemini (grátis, reserva)')
    expect(providerLabel('mistral')).toBe('Mistral (grátis, reserva)')
    expect(providerLabel('groq')).toBe('Groq (grátis)')
  })
})
