// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KnowledgeBaseSection, formatSize } from '../../src/renderer/src/components/KnowledgeBase'
import { Suggestions } from '../../src/renderer/src/components/Suggestions'
import { createFakeSaga, type FakeControl } from '../../src/renderer/src/dev/fakeSaga'
import { DEMO_KB_PACKAGE } from '../../src/renderer/src/dev/fakeKb'

let ctl: FakeControl
const section = () => screen.getByRole('region', { name: 'Base de conhecimento' })

beforeEach(() => {
  ctl = createFakeSaga()
  window.saga = ctl.api
})
afterEach(cleanup)

describe('Configurações › Base de conhecimento', () => {
  it('mostra o aviso, os pacotes e cada arquivo com papel, tamanho, seções e "Usar"', async () => {
    render(<KnowledgeBaseSection />)
    await within(section()).findByText(DEMO_KB_PACKAGE)
    expect(within(section()).getByRole('note').textContent).toMatch(/trechos dela vão junto com a conversa para a IA/)
    const select = within(section()).getByRole('combobox', { name: 'Papel de Pacotes de preco' }) as HTMLSelectElement
    expect(select.value).toBe('conhecimento')
    expect([...select.options].map((o) => o.textContent)).toEqual(['Regras (sempre)', 'Conhecimento', 'Interno (só orientação)', 'Desligado'])
    expect((within(section()).getByRole('combobox', { name: 'Papel de LEIA-ME' }) as HTMLSelectElement).value).toBe('desligado')
    const row = select.closest('tr')!
    expect(within(row).getByText('2')).toBeTruthy() // seções
    expect(within(row).getByText(/B$|KB$/)).toBeTruthy()
    expect(within(section()).getByText('Arquivos avulsos')).toBeTruthy()
  })

  it('trocar o papel e desligar um arquivo chama o processo principal', async () => {
    render(<KnowledgeBaseSection />)
    const select = (await within(section()).findByRole('combobox', { name: 'Papel de Pacotes de preco' })) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'interno' } })
    await waitFor(() => expect(ctl.calls.some((c) => c.method === 'kbUpdateFile' && (c.args[1] as { role?: string }).role === 'interno')).toBe(true))
    await waitFor(() => expect(within(select.closest('tr')!).getByText('Escolhido por você')).toBeTruthy())
    fireEvent.click(within(section()).getByRole('checkbox', { name: 'Usar Pacotes de preco' }))
    await waitFor(() => expect(ctl.calls.some((c) => c.method === 'kbUpdateFile' && (c.args[1] as { enabled?: boolean }).enabled === false)).toBe(true))
  })

  it('importar mostra o resultado; colar texto abre o diálogo e adiciona', async () => {
    render(<KnowledgeBaseSection />)
    await within(section()).findByText(DEMO_KB_PACKAGE)
    fireEvent.click(within(section()).getByRole('button', { name: 'Importar pacote / skill' }))
    expect(await within(section()).findByText(/Atualizado: Método Exemplo/)).toBeTruthy()
    expect(ctl.calls.find((c) => c.method === 'kbImport')!.args).toEqual(['archive'])
    fireEvent.click(within(section()).getByRole('button', { name: 'ou uma pasta' }))
    await waitFor(() => expect(ctl.calls.filter((c) => c.method === 'kbImport').map((c) => c.args[0])).toEqual(['archive', 'folder']))

    fireEvent.click(within(section()).getByRole('button', { name: 'Colar texto' }))
    const dlg = await screen.findByRole('dialog', { name: 'Colar texto na base' })
    const add = within(dlg).getByRole('button', { name: 'Adicionar' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    fireEvent.change(within(dlg).getByLabelText('Título'), { target: { value: 'Dúvidas frequentes' } })
    fireEvent.change(within(dlg).getByLabelText('Texto'), { target: { value: '# Reunião\n\nComo remarcar.' } })
    fireEvent.click(add)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await within(section()).findByText('Dúvidas frequentes')).toBeTruthy()
  })

  it('remover pede confirmação', async () => {
    render(<KnowledgeBaseSection />)
    await within(section()).findByText(DEMO_KB_PACKAGE)
    fireEvent.click(within(section()).getAllByRole('button', { name: 'Remover' })[0])
    fireEvent.click(within(section()).getByRole('button', { name: 'Sim, remover' }))
    await waitFor(() => expect(within(section()).queryByText(DEMO_KB_PACKAGE)).toBeNull())
  })

  it('sem base: texto de vazio', async () => {
    window.saga = createFakeSaga({ emptyKb: true }).api
    render(<KnowledgeBaseSection />)
    expect(await within(section()).findByText(/Nenhum material importado ainda/)).toBeTruthy()
  })

  it('formatSize', () => {
    expect(formatSize(900)).toBe('900 B')
    expect(formatSize(1536)).toBe('1,5 KB')
    expect(formatSize(3 * 1024 * 1024)).toBe('3 MB')
  })
})

describe('Sugestões › "Baseado em"', () => {
  const GROUP = '120363025555555555@g.us'

  it('mostra os trechos de conhecimento em cada sugestão e abre o trecho ao clicar', async () => {
    render(<Suggestions jid={GROUP} />)
    await screen.findAllByRole('textbox')
    const cards = document.querySelectorAll('.sug-card')
    for (const card of cards) expect(within(card as HTMLElement).getByText('Baseado em:')).toBeTruthy()
    const chip = within(cards[0] as HTMLElement).getByRole('button', { name: /^Pacotes de preco › Três pacotes/ })
    fireEvent.click(chip)
    const dlg = await screen.findByRole('dialog', { name: 'Três pacotes, do mais completo ao essencial' })
    expect(await within(dlg).findByText(/Monte sempre três opções/)).toBeTruthy()
    expect(within(dlg).getByText('Método Exemplo (demonstração) › Pacotes de preco')).toBeTruthy()
    fireEvent.keyDown(dlg, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('sem trechos de conhecimento: nada de "Baseado em"', async () => {
    render(<Suggestions jid="5548944443333@s.whatsapp.net" />)
    await screen.findAllByRole('textbox')
    expect(screen.queryByText('Baseado em:')).toBeNull()
  })

  it('trecho que saiu da base: avisa no visualizador', async () => {
    render(<Suggestions jid={GROUP} />)
    await screen.findAllByRole('textbox')
    const [pkg] = await window.saga.kbList()
    await window.saga.kbRemovePackage(pkg.id)
    fireEvent.click(screen.getAllByRole('button', { name: /Três pacotes/ })[0])
    expect(await screen.findByText(/não está mais na base/)).toBeTruthy()
  })
})
