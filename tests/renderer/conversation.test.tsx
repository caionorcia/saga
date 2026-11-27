// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Conversation } from '../../src/renderer/src/components/Conversation'
import type { Analysis, Contact, MessageView, SagaApi } from '../../src/shared/api'

const JID = '5547999998888@s.whatsapp.net'
const contact: Contact = { jid: JID, pushName: 'Ana', customName: null, hidden: false, notes: null, displayName: 'Ana', lastTs: 1, awaitingReply: true, isGroup: false, waitingSince: 1, alerts: [], needsReply: true, replyDecision: null }
const base: Analysis = { jid: JID, lastMsgId: 'M1', provider: 'groq', summary: 'Quer adiar.', suggestions: ['a', 'b'], createdAt: 1, transcriptFp: '', pendingAudios: 0 }

beforeEach(() => {
  ;(window as unknown as { saga: Partial<SagaApi> }).saga = {
    listMessages: vi.fn(async () => []),
    listMessagesPage: vi.fn(async () => ({ messages: [], hasMore: false })),
    onMessages: vi.fn(() => () => {})
  }
})
afterEach(cleanup)

describe('Conversation: áudios pendentes no resumo', () => {
  it('mostra quantos áudios ainda estão sendo transcritos', () => {
    render(<Conversation contact={contact} analysis={{ ...base, pendingAudios: 2 }} />)
    expect(screen.getByText(/2 áudios ainda sendo transcritos/)).toBeTruthy()
  })
  it('singular e nenhum', () => {
    render(<Conversation contact={contact} analysis={{ ...base, pendingAudios: 1 }} />)
    expect(screen.getByText(/1 áudio ainda sendo transcrito\b/)).toBeTruthy()
    cleanup()
    render(<Conversation contact={contact} analysis={base} />)
    expect(screen.queryByText(/sendo transcrit/)).toBeNull()
  })
})

const view = (i: number, o: Partial<MessageView> = {}): MessageView => ({
  id: `M${i}`,
  jid: JID,
  fromMe: false,
  ts: 1_700_000_000_000 + i * 60_000,
  kind: 'text',
  text: `mensagem ${i}`,
  durationSec: null,
  hasAudio: false,
  transcript: null,
  transcriptStatus: null,
  senderJid: null,
  senderName: null,
  mentionsMe: false,
  ...o
})

describe('Conversation: histórico completo (v0.9.0)', () => {
  it('carrega a conversa aos poucos: "Carregar mensagens mais antigas" pede uma página maior', async () => {
    const all = Array.from({ length: 450 }, (_, i) => view(i))
    const page = vi.fn(async (_jid: string, limit: number) => ({ messages: all.slice(-limit), hasMore: all.length > limit }))
    ;(window.saga as unknown as Record<string, unknown>).listMessagesPage = page
    render(<Conversation contact={contact} analysis={base} />)
    await screen.findByText('mensagem 449')
    expect(page).toHaveBeenLastCalledWith(JID, 200, null)
    expect(screen.queryByText('mensagem 249')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mensagens mais antigas' }))
    await screen.findByText('mensagem 249')
    expect(page).toHaveBeenLastCalledWith(JID, 400, null)
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mensagens mais antigas' }))
    await screen.findByText('mensagem 0')
    expect(screen.queryByRole('button', { name: 'Carregar mensagens mais antigas' })).toBeNull()
  })

  it('resultado da busca numa mensagem antiga: a página cresce até ela', async () => {
    const page = vi.fn(async () => ({ messages: [view(1), view(2)], hasMore: true }))
    ;(window.saga as unknown as Record<string, unknown>).listMessagesPage = page
    render(<Conversation contact={contact} analysis={base} focusMessage={{ id: 'M1', seq: 1 }} />)
    await screen.findByText('mensagem 1')
    expect(page).toHaveBeenCalledWith(JID, 200, 'M1')
  })

  it('áudio antigo: "🎤 áudio" com "Transcrever", que pede só esse áudio', async () => {
    const transcribeAudio = vi.fn(async () => true)
    Object.assign(window.saga, {
      transcribeAudio,
      listMessagesPage: vi.fn(async () => ({ messages: [view(1, { kind: 'audio', text: null, durationSec: 12, onDemand: true })], hasMore: false }))
    })
    render(<Conversation contact={contact} analysis={base} />)
    const btn = await screen.findByRole('button', { name: 'Transcrever' })
    expect(screen.getByText(/🎤 áudio/)).toBeTruthy()
    expect(screen.queryByText('Transcrevendo…')).toBeNull()
    fireEvent.click(btn)
    expect(transcribeAudio).toHaveBeenCalledWith('M1')
    await waitFor(() => expect(screen.getByText('Transcrevendo…')).toBeTruthy())
  })
})
