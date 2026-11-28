// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CopilotoSection } from '../../src/renderer/src/components/Copiloto'
import { createFakeSaga, type FakeControl } from '../../src/renderer/src/dev/fakeSaga'
import { MEMBERSHIP_SLOTS, membershipLine } from '../../src/shared/membership'

/** v0.11.0 (Adendo v1.4): Configurações › Copiloto da Saga › Grupos da mentoria. */

let ctl: FakeControl
afterEach(() => cleanup())

function mount(membership: boolean) {
  ctl = createFakeSaga({ membership })
  window.saga = ctl.api
  render(<CopilotoSection />)
}

describe('Grupos da mentoria', () => {
  it('quatro marcas, "Não conferir" de começo, e o botão só com a integração ligada e algum grupo', async () => {
    mount(false)
    const card = await screen.findByTestId('copiloto-mgroups')
    for (const s of MEMBERSHIP_SLOTS) {
      const sel = within(card).getByLabelText(s.label) as HTMLSelectElement
      expect(sel.value).toBe('')
      expect(sel.options[0].textContent).toBe('Não conferir')
    }
    expect((within(card).getByRole('button', { name: 'Conferir agora' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('mostra a última conferência de cada grupo como o Copiloto respondeu', async () => {
    mount(true)
    const line = await screen.findByTestId('mgroup-last-comunidade_saga')
    expect(line.textContent).toMatch(/^Última conferência \d{2}\/\d{2} 09:07 — recebidos 38, reconhecidos 37, marcados agora 2, fora da regra 1$/)
    expect(screen.getByTestId('mgroup-last-grupo_sos_trafego').textContent).toMatch(/recebidos 12, reconhecidos 12, marcados agora 1/)
    expect(screen.getByTestId(`mgroup-last-${MEMBERSHIP_SLOTS[1].key}`).textContent).toBe('Não conferido')
    expect(membershipLine({ at: new Date(2026, 10, 28, 9, 5).getTime(), received: 1600, matched: 1500, marked: 3, outsideRule: null, capped: true })).toMatch(
      /^Última conferência 28\/11 09:05 — recebidos 1600, reconhecidos 1500, marcados agora 3 \(mais de 1500 mentorados no grupo: só os primeiros 1500 foram enviados\)$/
    )
  })

  it('procura o grupo pelo nome (sem acento) e guarda a escolha pelo JID', async () => {
    mount(true)
    const slot = MEMBERSHIP_SLOTS[1]
    const card = await screen.findByTestId(`mgroup-${slot.key}`)
    await waitFor(() => expect((within(card).getByLabelText(slot.label) as HTMLSelectElement).options.length).toBeGreaterThan(2))
    fireEvent.change(within(card).getByLabelText(`Procurar grupo para ${slot.label}`), { target: { value: 'avancada' } })
    const sel = within(card).getByLabelText(slot.label) as HTMLSelectElement
    expect([...sel.options].map((o) => o.textContent)).toEqual(['Não conferir', 'Comunidade Avançada (comunidade)'])
    fireEvent.change(sel, { target: { value: '120363000000000106@g.us' } })
    await waitFor(() => expect(ctl.calls.some((c) => c.method === 'copilotoSetMembershipGroup' && c.args[1] === '120363000000000106@g.us')).toBe(true))
    await waitFor(() => expect(screen.getByTestId(`mgroup-last-${slot.key}`).textContent).toBe('Ainda não conferido'))
    // "Não conferir" tira a escolha
    fireEvent.change(sel, { target: { value: '' } })
    await waitFor(() => expect(ctl.calls.some((c) => c.method === 'copilotoSetMembershipGroup' && c.args[1] === null)).toBe(true))
  })

  it('"Conferir agora": pede e fica bloqueado por 10 min', async () => {
    mount(true)
    const btn = (await screen.findByRole('button', { name: 'Conferir agora' })) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(await screen.findByText(/Conferência pedida ✓/)).toBeTruthy()
    await waitFor(() => expect(btn.disabled).toBe(true))
    expect(ctl.calls.filter((c) => c.method === 'copilotoCheckMembership')).toHaveLength(1)
  })
})
