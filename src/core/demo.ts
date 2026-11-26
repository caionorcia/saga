import raw from '../../tests/fixtures/wa/demo.json'
import type { NormalizedMessage } from './types'
import type { AlertKind, TranscriptStatus } from './db/repo'
import type { ReasonCode, ReplyDecision, ReplyReasonCode, ReplyVerdict, Verdict } from '../shared/feedback'

/** Dados de demonstração (7 pessoas e 3 grupos, alguns com alertas) usados pelo modo `SAGA_FAKE_WA=1`, pela pré-visualização e pelos testes. */
export interface DemoMessage extends NormalizedMessage {
  hasAudio: boolean
  transcript: string | null
  transcriptStatus: TranscriptStatus | null
}

export interface DemoContact {
  jid: string
  isGroup: boolean
  pushName: string
  customName: string | null
  notes: string | null
  messages: DemoMessage[]
  analysis: { provider: 'groq' | 'claude'; summary: string; suggestions: string[] } | null
  /** alertas ativos de demonstração */
  alerts: Array<{ kind: AlertKind; detail: string; msgId: string | null }>
  /** "Para responder": a decisão sobre a última mensagem do contato, ou null */
  reply: ReplyDecision | null
  /** grupo: participantes conhecidos (como viriam de `groupFetchAllParticipating`) */
  members: string[]
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
  senderJid?: string
  senderName?: string
  mentionsMe?: boolean
}

interface RawContact {
  jid: string
  isGroup?: boolean
  pushName: string
  customName?: string
  notes?: string
  messages: RawMessage[]
  analysis?: { provider: string; summary: string; suggestions: string[] }
  alerts?: Array<{ kind: string; detail: string; messageId?: string }>
  reply?: { needed: boolean; by: string; reason?: string }
  members?: string[]
}

export function loadDemo(now: number): DemoContact[] {
  return (raw.contacts as RawContact[]).map((c) => ({
    jid: c.jid,
    isGroup: c.isGroup === true,
    pushName: c.pushName,
    customName: c.customName ?? null,
    notes: c.notes ?? null,
    members: c.members ?? [],
    analysis: c.analysis
      ? { provider: c.analysis.provider === 'claude' ? 'claude' : 'groq', summary: c.analysis.summary, suggestions: c.analysis.suggestions }
      : null,
    alerts: (c.alerts ?? []).map((a) => ({ kind: a.kind as AlertKind, detail: a.detail, msgId: a.messageId ?? null })),
    reply: c.reply
      ? { needed: c.reply.needed, by: c.reply.by === 'rule' ? 'rule' : c.reply.by === 'user' ? 'user' : 'ai', reason: c.reply.reason ?? null }
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
        transcriptStatus: m.transcriptStatus ?? null,
        ...(c.isGroup
          ? {
              isGroup: true,
              senderJid: m.fromMe ? null : (m.senderJid ?? null),
              senderName: m.fromMe ? null : (m.senderName ?? null),
              mentionsMe: m.mentionsMe === true
            }
          : {})
      }))
      .sort((a, b) => a.ts - b.ts)
  }))
}

/** Avaliações de alertas de demonstração (para "Qualidade dos alertas" na pré-visualização). */
export interface DemoFeedback {
  jid: string
  kind: AlertKind
  verdict: Verdict
  reasonCode: ReasonCode | null
  correctKind: AlertKind | null
  createdAt: number
}

interface RawFeedback {
  jid: string
  kind: string
  verdict: string
  reason?: string
  correctKind?: string
  daysAgo: number
}

export function loadDemoFeedback(now: number): DemoFeedback[] {
  return ((raw as { feedback?: RawFeedback[] }).feedback ?? []).map((f) => ({
    jid: f.jid,
    kind: f.kind as AlertKind,
    verdict: f.verdict as Verdict,
    reasonCode: (f.reason ?? null) as ReasonCode | null,
    correctKind: (f.correctKind ?? null) as AlertKind | null,
    createdAt: now - f.daysAgo * 86_400_000
  }))
}

/** Avaliações do "Para responder" de demonstração. */
export interface DemoReplyFeedback {
  jid: string
  verdict: ReplyVerdict
  appNeeds: boolean | null
  reasonCode: ReplyReasonCode | null
  createdAt: number
}

interface RawReplyFeedback {
  jid: string
  verdict: string
  appNeeds?: boolean | null
  reason?: string
  daysAgo: number
}

export function loadDemoReplyFeedback(now: number): DemoReplyFeedback[] {
  return ((raw as { replyFeedback?: RawReplyFeedback[] }).replyFeedback ?? []).map((f) => ({
    jid: f.jid,
    verdict: f.verdict as ReplyVerdict,
    appNeeds: f.appNeeds ?? null,
    reasonCode: (f.reason ?? null) as ReplyReasonCode | null,
    createdAt: now - f.daysAgo * 86_400_000
  }))
}
