import raw from '../../tests/fixtures/wa/demo.json'
import type { NormalizedMessage } from './types'
import type { TranscriptStatus } from './db/repo'

/** Dados de demonstração (5 contatos) usados pelo modo `SAGA_FAKE_WA=1`, pela pré-visualização e pelos testes. */
export interface DemoMessage extends NormalizedMessage {
  hasAudio: boolean
  transcript: string | null
  transcriptStatus: TranscriptStatus | null
}

export interface DemoContact {
  jid: string
  pushName: string
  customName: string | null
  notes: string | null
  messages: DemoMessage[]
  analysis: { provider: 'groq' | 'claude'; summary: string; suggestions: string[] } | null
}

interface RawMessage {
  id: string
  fromMe: boolean
  minutesAgo: number
  kind: 'text' | 'audio'
  text?: string
  durationSec?: number
  hasAudio?: boolean
  transcriptStatus?: TranscriptStatus | null
  transcript?: string | null
}

interface RawContact {
  jid: string
  pushName: string
  customName?: string
  notes?: string
  messages: RawMessage[]
  analysis?: { provider: string; summary: string; suggestions: string[] }
}

export function loadDemo(now: number): DemoContact[] {
  return (raw.contacts as RawContact[]).map((c) => ({
    jid: c.jid,
    pushName: c.pushName,
    customName: c.customName ?? null,
    notes: c.notes ?? null,
    analysis: c.analysis
      ? { provider: c.analysis.provider === 'claude' ? 'claude' : 'groq', summary: c.analysis.summary, suggestions: c.analysis.suggestions }
      : null,
    messages: c.messages
      .map((m) => ({
        id: m.id,
        jid: c.jid,
        fromMe: m.fromMe,
        ts: now - m.minutesAgo * 60_000,
        kind: m.kind,
        text: m.text ?? null,
        mediaKeyJson: null,
        durationSec: m.durationSec ?? null,
        hasAudio: m.hasAudio ?? false,
        transcript: m.transcript ?? null,
        transcriptStatus: m.transcriptStatus ?? null
      }))
      .sort((a, b) => a.ts - b.ts)
  }))
}
