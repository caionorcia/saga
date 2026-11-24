/**
 * `window.saga` falso, em memória, com os dados de `tests/fixtures/wa/demo.json`.
 * Usado pelos testes e pela pré-visualização no navegador (`npm run preview:ui`); nunca no app real.
 */
import { loadDemo, type DemoContact } from '../../../core/demo'
import type {
  AnalysisResult,
  AppState,
  Contact,
  MessageView,
  RecentEvent,
  SagaApi,
  SettingsView
} from '../../../shared/api'

export const DEFAULT_STATE: AppState = {
  conn: 'open',
  qr: null,
  retryAt: null,
  queue: { pending: 0, running: 0, failed: 1, done: 340, paused: false, nextRunAt: null },
  paused: false,
  diskLow: false,
  transcribePaused: false,
  costTodayUsd: 0,
  setupDone: true,
  provider: 'groq',
  update: { status: 'none' }
}

export interface FakeControl {
  api: SagaApi
  setState(patch: Partial<AppState>): void
  calls: Array<{ method: string; args: unknown[] }>
}

export interface FakeOptions {
  now?: number
  state?: Partial<AppState>
  /** atraso artificial das respostas da IA (ms) */
  aiDelayMs?: number
}

const EXTRA_SUGGESTION = 'Combinado! Qualquer coisa me avisa por aqui.'

export function createFakeSaga(opts: FakeOptions = {}): FakeControl {
  const now = opts.now ?? Date.now()
  const demo: DemoContact[] = loadDemo(now)
  const state: AppState = { ...DEFAULT_STATE, ...opts.state }
  const hidden = new Set<string>()
  const names = new Map<string, string>()
  const notes = new Map<string, string>(demo.flatMap((c) => (c.notes ? [[c.jid, c.notes] as const] : [])))
  const analyses = new Map(demo.flatMap((c) => (c.analysis ? [[c.jid, c.analysis] as const] : [])))
  const settings: SettingsView = {
    provider: 'groq',
    transcriber: 'groq',
    dailyCapUsd: 1,
    startWithWindows: false,
    claudeModel: 'claude',
    groqModel: 'groq',
    keys: { groq: true, claude: false, openai: false }
  }
  const stateListeners = new Set<(s: AppState) => void>()
  const contactListeners = new Set<() => void>()
  const calls: FakeControl['calls'] = []
  let replyId = 0
  let generation = 0
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  const emitState = () => stateListeners.forEach((l) => l({ ...state }))
  const record = <T>(method: string, args: unknown[], value: T): T => {
    calls.push({ method, args })
    return value
  }

  const displayName = (c: DemoContact) => names.get(c.jid) ?? c.customName ?? c.pushName
  const toContact = (c: DemoContact): Contact => {
    const last = c.messages[c.messages.length - 1]
    return {
      jid: c.jid,
      pushName: c.pushName,
      customName: names.get(c.jid) ?? c.customName,
      hidden: hidden.has(c.jid),
      notes: notes.get(c.jid) ?? null,
      displayName: displayName(c),
      lastTs: last?.ts ?? null,
      awaitingReply: !!last && !last.fromMe
    }
  }
  const toView = (m: DemoContact['messages'][number]): MessageView => ({
    id: m.id,
    jid: m.jid,
    fromMe: m.fromMe,
    ts: m.ts,
    kind: m.kind,
    text: m.text,
    durationSec: m.durationSec,
    hasAudio: m.hasAudio,
    transcript: m.transcript,
    transcriptStatus: m.transcriptStatus
  })
  const find = (jid: string) => demo.find((c) => c.jid === jid)

  async function analysisFor(jid: string, fresh: boolean): Promise<AnalysisResult> {
    const c = find(jid)
    if (!c) return { ok: false, code: 'no_messages', message: 'Ainda não há mensagens deste contato.', provider: state.provider }
    if (opts.aiDelayMs) await wait(opts.aiDelayMs)
    const lastMsgId = c.messages[c.messages.length - 1].id
    let a = analyses.get(jid)
    if (!a || fresh) {
      generation++
      const base = a?.suggestions ?? ['Oi! Vi a sua mensagem e já te respondo com calma.', 'Obrigado por avisar. Vamos conversar sobre isso na nossa próxima sessão?']
      a = {
        provider: state.provider,
        summary: a?.summary ?? `${displayName(c)} mandou novas mensagens e espera a sua resposta.`,
        suggestions: fresh ? [...base.slice(1), generation % 2 ? EXTRA_SUGGESTION : base[0]] : base
      }
      analyses.set(jid, a)
    }
    return { ok: true, analysis: { jid, lastMsgId, provider: a.provider, summary: a.summary, suggestions: a.suggestions, createdAt: generation } }
  }

  const api: SagaApi = {
    getState: async () => ({ ...state }),
    onState: (cb) => {
      stateListeners.add(cb)
      return () => void stateListeners.delete(cb)
    },
    onContactsChanged: (cb) => {
      contactListeners.add(cb)
      return () => void contactListeners.delete(cb)
    },
    onMessages: () => () => {},

    listContacts: async (includeHidden) =>
      demo
        .map(toContact)
        .filter((c) => includeHidden || !c.hidden)
        .sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0)),
    listMessages: async (jid) => (find(jid)?.messages ?? []).map(toView),
    getAnalysis: (jid) => analysisFor(jid, false),
    regenerate: (jid) => analysisFor(jid, true),

    saveReply: async (input) => record('saveReply', [input], ++replyId),
    copyToClipboard: async (text) => {
      record('copyToClipboard', [text], undefined)
      try {
        await navigator.clipboard?.writeText(text)
      } catch {
        // sem permissão na pré-visualização: ignora
      }
    },

    renameContact: async (jid, name) => {
      if (name) names.set(jid, name)
      else names.delete(jid)
      contactListeners.forEach((l) => l())
    },
    setHidden: async (jid, h) => {
      if (h) hidden.add(jid)
      else hidden.delete(jid)
      contactListeners.forEach((l) => l())
    },
    setNotes: async (jid, text) => {
      notes.set(jid, text)
      contactListeners.forEach((l) => l())
    },

    pauseAll: async () => {
      state.paused = true
      emitState()
    },
    resumeAll: async () => {
      state.paused = false
      state.diskLow = false
      emitState()
    },
    manualReconnect: async () => {
      state.conn = 'connecting'
      emitState()
    },
    downloadUpdate: async () => {
      if (state.update.status !== 'available') return
      state.update = { status: 'ready', version: state.update.version }
      emitState()
    },
    retryFailedJobs: async () => {
      const n = state.queue.failed
      state.queue = { ...state.queue, failed: 0 }
      emitState()
      return n
    },

    getSettings: async () => ({ ...settings, keys: { ...settings.keys } }),
    saveSettings: async (patch) => {
      for (const [k, v] of Object.entries(patch)) {
        if (k.endsWith('Key')) settings.keys[k.replace('Key', '') as keyof SettingsView['keys']] = !!v
        else (settings as unknown as Record<string, unknown>)[k] = v
      }
      return { ok: true, settings: { ...settings, keys: { ...settings.keys } } }
    },
    testKey: async (_kind, key) => key.trim().length >= 8,
    recentEvents: async (limit): Promise<RecentEvent[]> =>
      [
        { id: 3, ts: now - 5 * 60_000, kind: 'transcribe_failed', detail: 'o áudio J2 não pôde ser transcrito (3 tentativas)' },
        { id: 2, ts: now - 50 * 60_000, kind: 'reconnect', detail: 'WhatsApp reconectado' },
        { id: 1, ts: now - 26 * 3_600_000, kind: 'import_done', detail: '5 conversas importadas' }
      ].slice(0, limit),
    audioUrl: async (id) => `saga-media://audio/${id}`
  }

  return {
    api,
    calls,
    setState(patch) {
      Object.assign(state, patch)
      emitState()
    }
  }
}

declare global {
  interface Window {
    __sagaFake?: FakeControl
  }
}

/**
 * Instala o falso em `window.saga`. Na pré-visualização, `?state={"conn":"waiting_retry"}` mexe no estado inicial e
 * `?setup=1` mostra o assistente com um QR Code.
 */
export async function installFakeSaga(): Promise<void> {
  const params = new URLSearchParams(location.search)
  let patch: Partial<AppState> = {}
  try {
    patch = JSON.parse(params.get('state') ?? '{}')
  } catch {
    // ignora estado inválido na URL
  }
  if (params.get('setup')) {
    const QRCode = (await import('qrcode')).default
    patch = { setupDone: false, conn: 'needs_qr', qr: await QRCode.toDataURL('saga-demo-qr-nao-e-um-codigo-real', { margin: 1, width: 240 }), ...patch }
  }
  if (patch.conn === 'waiting_retry' && patch.retryAt === undefined) patch.retryAt = Date.now() + 2 * 60_000
  const ctl = createFakeSaga({ state: patch, aiDelayMs: 600 })
  window.saga = ctl.api
  window.__sagaFake = ctl
}
