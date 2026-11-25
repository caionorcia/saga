// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Conversation } from '../../src/renderer/src/components/Conversation'
import type { Analysis, Contact, SagaApi } from '../../src/shared/api'

const JID = '5547999998888@s.whatsapp.net'
const contact: Contact = { jid: JID, pushName: 'Ana', customName: null, hidden: false, notes: null, displayName: 'Ana', lastTs: 1, awaitingReply: true, isGroup: false }
const base: Analysis = { jid: JID, lastMsgId: 'M1', provider: 'groq', summary: 'Quer adiar.', suggestions: ['a', 'b'], createdAt: 1, transcriptFp: '', pendingAudios: 0 }

beforeEach(() => {
  ;(window as unknown as { saga: Partial<SagaApi> }).saga = {
    listMessages: vi.fn(async () => []),
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
