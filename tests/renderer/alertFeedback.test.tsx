// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Conversation } from '../../src/renderer/src/components/Conversation'
import { Settings } from '../../src/renderer/src/components/Settings'
import { createFakeSaga, type FakeControl } from '../../src/renderer/src/dev/fakeSaga'
import type { Contact } from '../../src/shared/api'

const JID = '5548944443333@s.whatsapp.net'

afterEach(cleanup)

async function setup(): Promise<{ ctl: FakeControl; contact: Contact; rerender: () => Promise<void> }> {
  const ctl = createFakeSaga()
  window.saga = ctl.api
  const contact = (await ctl.api.listContacts(true)).find((c) => c.jid === JID)!
  const view = render(<Conversation contact={contact} analysis={null} alerts={await ctl.api.listAlerts(JID)} />)
  const rerender = async () => view.rerender(<Conversation contact={contact} analysis={null} alerts={await ctl.api.listAlerts(JID)} />)
  return { ctl, contact, rerender }
}

const bar = () => screen.getByRole('region', { name: 'Alertas desta conversa' })
const itemOf = (text: RegExp) => within(bar()).getByText(text).closest('li')!

describe('Conversation: 👍/👎 nos alertas', () => {
  it('todos os alertas têm 👍/👎, inclusive o "esperando"', async () => {
    await setup()
    expect(within(bar()).getAllByRole('button', { name: 'Alerta correto' })).toHaveLength(3)
    expect(within(bar()).getAllByRole('button', { name: 'Alerta errado' })).toHaveLength(3)
    expect(within(itemOf(/Esperando/)).getByRole('button', { name: 'Alerta correto' })).toBeTruthy()
  })

  it('"esperando" 👍: registra que precisa mesmo responder e fica marcado', async () => {
    const { ctl, rerender } = await setup()
    fireEvent.click(within(itemOf(/Esperando/)).getByRole('button', { name: 'Alerta correto' }))
    expect(screen.getByRole('status').textContent).toMatch(/aprender/)
    const id = (await ctl.api.listAlerts(JID)).find((a) => a.kind === 'esperando')!.id
    expect(ctl.calls.find((c) => c.method === 'rateAlert')!.args.slice(0, 2)).toEqual([id, 'up'])
    await rerender()
    expect(within(itemOf(/Esperando/)).getByRole('button', { name: 'Alerta correto' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('"esperando" 👎: abre "Por que esta conversa não precisa de resposta?" e registra setNeedsReply; o alerta some', async () => {
    const { ctl, rerender } = await setup()
    fireEvent.click(within(itemOf(/Esperando/)).getByRole('button', { name: 'Alerta errado' }))
    const dlg = screen.getByRole('dialog', { name: 'Por que esta conversa não precisa de resposta?' })
    expect(screen.queryByRole('dialog', { name: 'O que está errado neste alerta?' })).toBeNull()
    fireEvent.click(within(dlg).getByRole('radio', { name: 'Respondi no grupo dele' }))
    fireEvent.click(within(dlg).getByRole('button', { name: 'Salvar' }))
    expect(ctl.calls.find((c) => c.method === 'setNeedsReply')!.args).toEqual([JID, false, { code: 'respondi_grupo' }])
    expect(ctl.calls.some((c) => c.method === 'rateAlert')).toBe(false)
    expect(within(bar()).queryByText(/Esperando/)).toBeNull()
    await rerender()
    expect((await ctl.api.listAlerts(JID)).map((a) => a.kind)).not.toContain('esperando')
  })

  it('👍 registra "up", fica marcado e agradece; o alerta continua', async () => {
    const { ctl, rerender } = await setup()
    const item = itemOf(/Precisa decidir até sexta/)
    const up = within(item).getByRole('button', { name: 'Alerta correto' })
    expect(up.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(up)
    expect(up.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('Obrigado — o SagaZap vai aprender com isso')
    const call = ctl.calls.find((c) => c.method === 'rateAlert')!
    expect(call.args.slice(0, 2)).toEqual([expect.any(Number), 'up'])
    await rerender()
    expect(within(itemOf(/Precisa decidir até sexta/)).getByRole('button', { name: 'Alerta correto' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('👎 abre o diálogo; "Não é esse tipo" pede o tipo certo; Salvar tira o alerta e cria o certo, marcado por você', async () => {
    const { ctl, rerender } = await setup()
    fireEvent.click(within(itemOf(/Precisa decidir até sexta/)).getByRole('button', { name: 'Alerta errado' }))
    const dlg = screen.getByRole('dialog', { name: 'O que está errado neste alerta?' })
    const save = within(dlg).getByRole('button', { name: 'Salvar' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    for (const r of ['Não é esse tipo de alerta', 'Era brincadeira/ironia', 'Já foi resolvido', 'Não era comigo', 'Exagerado — não é tão grave', 'Outro']) {
      expect(within(dlg).getByRole('radio', { name: r })).toBeTruthy()
    }
    expect(within(dlg).queryByLabelText('Qual seria o certo?')).toBeNull()
    fireEvent.click(within(dlg).getByRole('radio', { name: 'Não é esse tipo de alerta' }))
    const sel = within(dlg).getByLabelText('Qual seria o certo?') as HTMLSelectElement
    expect([...sel.options].map((o) => o.textContent)).toEqual(['Nenhum', 'Desânimo', 'Travado', 'Reunião'])
    fireEvent.change(sel, { target: { value: 'reuniao' } })
    fireEvent.change(within(dlg).getByLabelText('Explique com suas palavras (opcional)'), { target: { value: ' Quer marcar uma conversa ' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('status').textContent).toMatch(/aprender/)
    expect(ctl.calls.find((c) => c.method === 'rateAlert')!.args.slice(1)).toEqual([
      'down',
      { code: 'tipo_errado', correctKind: 'reuniao', text: 'Quer marcar uma conversa' }
    ])
    // some na hora, sem esperar a lista voltar
    expect(within(bar()).queryByText(/Precisa decidir até sexta/)).toBeNull()
    await rerender()
    const made = itemOf(/Quer marcar uma conversa/)
    expect(within(made).getByText('marcado por você')).toBeTruthy()
    // os marcados por você também têm 👍/👎
    expect(within(made).getByRole('button', { name: 'Alerta errado' })).toBeTruthy()
  })

  it('Cancelar (ou Esc) fecha sem registrar', async () => {
    const { ctl } = await setup()
    fireEvent.click(within(itemOf(/Precisa decidir até sexta/)).getByRole('button', { name: 'Alerta errado' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(within(itemOf(/Precisa decidir até sexta/)).getByRole('button', { name: 'Alerta errado' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(ctl.calls.some((c) => c.method === 'rateAlert')).toBe(false)
    expect(within(bar()).getByText(/Precisa decidir até sexta/)).toBeTruthy()
  })
})

describe('Conversation: "Faltou um alerta?"', () => {
  it('escolhe o tipo, a mensagem (só as do contato) e um texto; registra e cria o alerta', async () => {
    const { ctl, rerender } = await setup()
    await waitFor(() => expect(document.querySelector('[data-msg-id="R3"]')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Faltou um alerta?' }))
    const dlg = screen.getByRole('dialog', { name: 'Faltou um alerta?' })
    const save = within(dlg).getByRole('button', { name: 'Salvar' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(within(dlg).getAllByRole('radio').map((r) => r.closest('label')!.textContent)).toEqual(['Urgente', 'Desânimo', 'Travado', 'Reunião'])
    const sel = within(dlg).getByLabelText('Qual mensagem? (opcional)') as HTMLSelectElement
    // R3 e R2 são do contato (mais nova primeiro); R1 é do mentor
    expect([...sel.options].map((o) => o.value)).toEqual(['', 'R3', 'R2'])
    expect(sel.options[2].textContent).toMatch(/Mentor, sendo sincero: tô bem desanimado.*…$/)
    fireEvent.click(within(dlg).getByRole('radio', { name: 'Travado' }))
    fireEvent.change(sel, { target: { value: 'R2' } })
    fireEvent.change(within(dlg).getByLabelText('Explique com suas palavras (opcional)'), { target: { value: 'Não sabe vender' } })
    fireEvent.click(save)
    expect(ctl.calls.find((c) => c.method === 'reportMissedAlert')!.args).toEqual([JID, 'travado', 'R2', 'Não sabe vender'])
    expect(screen.getByRole('status').textContent).toMatch(/aprender/)
    await rerender()
    expect(within(itemOf(/Não sabe vender/)).getByText('marcado por você')).toBeTruthy()
  })
})

describe('Configurações: "Qualidade dos alertas"', () => {
  it('contagens por tipo e % de acerto; exporta com nomes anonimizados por padrão e avisa dos trechos', async () => {
    const ctl = createFakeSaga()
    window.saga = ctl.api
    render(<Settings />)
    const sec = await screen.findByRole('region', { name: 'Qualidade dos alertas' })
    const row = await within(sec).findByRole('row', { name: /Urgente/ })
    expect([...row.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['3', '1', '0', '75%'])
    const reuniao = within(sec).getByRole('row', { name: /Reunião/ })
    expect([...reuniao.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['2', '0', '1', '100%'])
    expect(within(sec).getByText(/trechos das mensagens/)).toBeTruthy()
    const anon = within(sec).getByRole('checkbox', { name: 'Anonimizar nomes' }) as HTMLInputElement
    expect(anon.checked).toBe(true)
    fireEvent.click(within(sec).getByRole('button', { name: 'Exportar avaliações (CSV)' }))
    const reply = within(sec).getByRole('row', { name: /Para responder/ })
    // removidos, devolvidos, confirmados, % de acerto do SagaZap
    expect([...reply.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['2', '1', '3', '50%'])
    await within(sec).findByText(/Arquivo salvo com 18 avaliações/)
    fireEvent.click(anon)
    ctl.setExportOutcome('canceled')
    fireEvent.click(within(sec).getByRole('button', { name: 'Exportar avaliações (CSV)' }))
    await waitFor(() => expect(ctl.calls.filter((c) => c.method === 'exportAlertFeedback')).toHaveLength(2))
    expect(ctl.calls.filter((c) => c.method === 'exportAlertFeedback').map((c) => c.args[0])).toEqual([{ anonymize: true }, { anonymize: false }])
    await waitFor(() => expect(within(sec).queryByText(/Arquivo salvo/)).toBeNull())
  })
})
