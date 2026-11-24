// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Suggestions } from '../../src/renderer/src/components/Suggestions'
import type { Analysis, AnalysisResult, SagaApi } from '../../src/shared/api'

const JID = '5547999998888@s.whatsapp.net'

const analysis: Analysis = {
  jid: JID,
  lastMsgId: 'M1',
  provider: 'groq',
  summary: 'Quer saber se pode adiar a reunião.',
  suggestions: ['Claro, podemos adiar para quinta.', 'Pode ser sexta, às 10h?'],
  createdAt: 1,
  transcriptFp: '',
  pendingAudios: 0
}

let saga: Record<string, ReturnType<typeof vi.fn>>

function install(getAnalysis: () => Promise<AnalysisResult>): void {
  saga = {
    getAnalysis: vi.fn(getAnalysis),
    regenerate: vi.fn(async () => ({ ok: true, analysis }) as AnalysisResult),
    saveReply: vi.fn(async () => 1),
    copyToClipboard: vi.fn(async () => {}),
    onMessages: vi.fn(() => () => {}),
    listMessages: vi.fn(async () => [])
  }
  ;(window as unknown as { saga: Partial<SagaApi> }).saga = saga as unknown as Partial<SagaApi>
}

beforeEach(() => install(async () => ({ ok: true, analysis })))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Suggestions', () => {
  it('Salvar grava o texto gerado e o editado, e vira "Salvo ✓"', async () => {
    render(<Suggestions jid={JID} />)
    const box = (await screen.findAllByRole('textbox'))[0]
    fireEvent.change(box, { target: { value: 'Claro! Quinta às 15h serve?' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Salvar' })[0])
    await waitFor(() =>
      expect(saga.saveReply).toHaveBeenCalledWith({
        jid: JID,
        originalSuggestion: 'Claro, podemos adiar para quinta.',
        finalText: 'Claro! Quinta às 15h serve?',
        analysisLastMsgId: 'M1'
      })
    )
    expect(await screen.findByRole('button', { name: 'Salvo ✓' })).toBeTruthy()
  })

  it('Copiar envia o texto editado e mostra "Copiado ✓" por 2 segundos', async () => {
    render(<Suggestions jid={JID} />)
    const box = (await screen.findAllByRole('textbox'))[0]
    fireEvent.change(box, { target: { value: 'Texto editado' } })
    vi.useFakeTimers()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Copiar' })[0])
    })
    expect(saga.copyToClipboard).toHaveBeenCalledWith('Texto editado')
    expect(screen.getByRole('button', { name: 'Copiado ✓' })).toBeTruthy()
    await act(async () => {
      vi.advanceTimersByTime(2100)
    })
    expect(screen.queryByRole('button', { name: 'Copiado ✓' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Copiar' })).toHaveLength(2)
  })

  it('com getAnalysis rejeitando mostra "Tentar de novo" e tenta outra vez ao clicar', async () => {
    install(async () => {
      throw new Error('falha')
    })
    render(<Suggestions jid={JID} />)
    const retry = await screen.findByRole('button', { name: 'Tentar de novo' })
    saga.getAnalysis.mockResolvedValueOnce({ ok: true, analysis })
    fireEvent.click(retry)
    expect(await screen.findAllByRole('textbox')).toHaveLength(2)
    expect(saga.getAnalysis).toHaveBeenCalledTimes(2)
  })

  it('resultado ok:false mostra a mensagem; limite de gasto não oferece nova tentativa', async () => {
    install(async () => ({
      ok: false,
      code: 'budget_exceeded',
      message: 'O teto diário de gasto com IA foi atingido.',
      provider: 'claude'
    }))
    render(<Suggestions jid={JID} />)
    expect(await screen.findByText(/limite de gasto/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull()
  })

  it('mostra qual IA gerou e "Gerar novas" chama regenerate', async () => {
    render(<Suggestions jid={JID} />)
    expect(await screen.findByText('Gerado por: Groq (grátis)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Gerar novas' }))
    await waitFor(() => expect(saga.regenerate).toHaveBeenCalledWith(JID))
  })
})

describe('Suggestions: atualização silenciosa', () => {
  const fire = async (ms = 2100) => {
    await act(async () => {
      vi.advanceTimersByTime(ms)
    })
  }
  const withMessageCallback = () => {
    let cb: () => void = () => {}
    saga.onMessages.mockImplementation(((_j: string, f: () => void) => {
      cb = f
      return () => {}
    }) as never)
    return () => cb()
  }

  it('mensagem nova não apaga o texto editado: mostra o aviso', async () => {
    let notify: () => void = () => {}
    install(async () => ({ ok: true, analysis }))
    saga.onMessages.mockImplementation(((_j: string, f: () => void) => {
      notify = f
      return () => {}
    }) as never)
    render(<Suggestions jid={JID} />)
    const box = (await screen.findAllByRole('textbox'))[0] as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'Meu texto editado' } })
    saga.getAnalysis.mockResolvedValue({
      ok: true,
      analysis: { ...analysis, lastMsgId: 'M2', suggestions: ['Nova A', 'Nova B'] }
    })
    vi.useFakeTimers()
    notify()
    await fire()
    expect((screen.getAllByRole('textbox')[0] as HTMLTextAreaElement).value).toBe('Meu texto editado')
    expect(screen.getByText(/Chegou mensagem nova/)).toBeTruthy()
  })

  it('sem edições, a mensagem nova troca as sugestões em silêncio', async () => {
    let notify: () => void = () => {}
    saga.onMessages.mockImplementation(((_j: string, f: () => void) => {
      notify = f
      return () => {}
    }) as never)
    render(<Suggestions jid={JID} />)
    await screen.findAllByRole('textbox')
    saga.getAnalysis.mockResolvedValue({
      ok: true,
      analysis: { ...analysis, lastMsgId: 'M2', suggestions: ['Nova A', 'Nova B'] }
    })
    vi.useFakeTimers()
    notify()
    await fire()
    expect((screen.getAllByRole('textbox')[0] as HTMLTextAreaElement).value).toBe('Nova A')
    expect(screen.queryByText(/Chegou mensagem nova/)).toBeNull()
  })

  it('atualização silenciosa não atropela o pedido em andamento (não fica preso em "Gerando…")', async () => {
    let rejectFirst: (e: Error) => void = () => {}
    install(() => new Promise<AnalysisResult>((_, rej) => (rejectFirst = rej)))
    const notify = withMessageCallback()
    render(<Suggestions jid={JID} />)
    expect(screen.getByText('Gerando sugestões…')).toBeTruthy()
    vi.useFakeTimers()
    notify()
    await fire()
    expect(saga.getAnalysis).toHaveBeenCalledTimes(1)
    await act(async () => {
      rejectFirst(new Error('falhou'))
    })
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy()
  })

  it('erro de chave oferece "Abrir Configurações"', async () => {
    install(async () => ({ ok: false, code: 'missing_key', message: 'Configure a chave.', provider: 'groq' }))
    const open = vi.fn()
    render(<Suggestions jid={JID} onOpenSettings={open} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir Configurações' }))
    expect(open).toHaveBeenCalled()
  })
})

describe('Suggestions: sem chamadas pagas à toa', () => {
  const view = (id: string, fromMe: boolean) => ({ id, jid: JID, fromMe, ts: 1, kind: 'text', text: id, durationSec: null, hasAudio: false, transcript: null, transcriptStatus: null })
  const setVisibility = (v: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })
    document.dispatchEvent(new Event('visibilitychange'))
  }
  const fire = async (ms = 2100) => {
    await act(async () => {
      vi.advanceTimersByTime(ms)
    })
  }
  let notify: () => void
  beforeEach(() => {
    notify = () => {}
    saga.onMessages.mockImplementation(((_j: string, f: () => void) => {
      notify = f
      return () => {}
    }) as never)
  })
  afterEach(() => setVisibility('visible'))

  it('a única mensagem nova é do próprio mentor: não atualiza as sugestões', async () => {
    render(<Suggestions jid={JID} />)
    await screen.findAllByRole('textbox')
    saga.listMessages.mockResolvedValue([view('M0', false), view('M1', false), view('EU1', true)])
    vi.useFakeTimers()
    notify()
    await fire()
    expect(saga.getAnalysis).toHaveBeenCalledTimes(1)
    // o mentorado responde: aí sim atualiza
    saga.listMessages.mockResolvedValue([view('M1', false), view('EU1', true), view('M2', false)])
    notify()
    await fire()
    expect(saga.getAnalysis).toHaveBeenCalledTimes(2)
  })

  it('janela escondida (bandeja): não atualiza; ao voltar a aparecer, atualiza uma vez', async () => {
    render(<Suggestions jid={JID} />)
    await screen.findAllByRole('textbox')
    saga.listMessages.mockResolvedValue([view('M1', false), view('M2', false)])
    setVisibility('hidden')
    vi.useFakeTimers()
    notify()
    await fire()
    notify()
    await fire()
    expect(saga.getAnalysis).toHaveBeenCalledTimes(1)
    await act(async () => setVisibility('visible'))
    await fire(10)
    expect(saga.getAnalysis).toHaveBeenCalledTimes(2)
    await act(async () => setVisibility('hidden'))
    await act(async () => setVisibility('visible'))
    await fire(10)
    expect(saga.getAnalysis).toHaveBeenCalledTimes(2)
  })
})
