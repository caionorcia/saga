/**
 * `window.saga` falso, em memória, com os dados de `tests/fixtures/wa/demo.json`.
 * Usado pelos testes e pela pré-visualização no navegador (`npm run preview:ui`); nunca no app real.
 */
import { loadDemo, loadDemoFeedback, loadDemoReplyFeedback, type DemoContact, type DemoFeedback, type DemoReplyFeedback } from '../../../core/demo'
import type { GroupAnswer, ReplyDecision } from '../../../shared/feedback'
import { GROUP_ANSWER_MAX_MEMBERS } from '../../../shared/triage'
import { createFakeKb } from './fakeKb'
import { buildSnippet, isEmptyQuery, matchedPieces, parseQuery } from '../../../core/search/query'
import type { BackupCounts, BackupStatus } from '../../../shared/backup'
import { SEARCH_LIMITS, SEARCH_PERIOD_DAYS, type SearchFilters, type SearchGroup, type SearchResult } from '../../../shared/search'
import { AI_ALERT_KINDS, alertSeverity, type AlertKind } from '../../../shared/triage'
import type {
  Alert,
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
  transcribePausedReason: null,
  downloads: { remaining: 0, done: 0 },
  costTodayUsd: 0,
  setupDone: true,
  provider: 'groq',
  update: { status: 'none' },
  updateCheck: {
    enabled: true,
    currentVersion: '0.3.0',
    checking: false,
    lastCheckAt: null,
    lastResult: null,
    latestVersion: null,
    lastError: null
  },
  triage: { awaiting: 0, withAlerts: 0 }
}

export interface FakeControl {
  api: SagaApi
  setState(patch: Partial<AppState>): void
  /** o que a próxima exportação de avaliações devolve */
  setExportOutcome(o: 'saved' | 'canceled'): void
  calls: Array<{ method: string; args: unknown[] }>
}

export interface FakeOptions {
  now?: number
  state?: Partial<AppState>
  /** atraso artificial das respostas da IA (ms) */
  aiDelayMs?: number
  /** tema salvo (padrão: Automático) */
  theme?: SettingsView['theme']
  /** sem base de conhecimento de demonstração */
  emptyKb?: boolean
}

const EXTRA_SUGGESTION = 'Combinado! Qualquer coisa me avisa por aqui.'

export function createFakeSaga(opts: FakeOptions = {}): FakeControl {
  const now = opts.now ?? Date.now()
  const demo: DemoContact[] = loadDemo(now)
  const state: AppState = { ...DEFAULT_STATE, ...opts.state }
  const kb = createFakeKb(now, { empty: opts.emptyKb })
  const hidden = new Set<string>()
  const names = new Map<string, string>()
  const notes = new Map<string, string>(demo.flatMap((c) => (c.notes ? [[c.jid, c.notes] as const] : [])))
  const analyses = new Map(demo.flatMap((c) => (c.analysis ? [[c.jid, c.analysis] as const] : [])))
  let alertSeq = 0
  const alerts = new Map<string, Alert[]>(
    demo.map(
      (c) =>
        [
          c.jid,
          c.alerts.map(
            (a): Alert => ({
              id: ++alertSeq,
              jid: c.jid,
              ...a,
              createdAt: now - 10 * 60_000,
              source: a.kind === 'esperando' ? 'rule' : 'ai',
              rating: null
            })
          )
        ] as const
    )
  )
  const feedback: Array<DemoFeedback & { alertId?: number }> = loadDemoFeedback(now)
  const replyFeedback: Array<DemoReplyFeedback & { msgId?: string; alertId?: number }> = loadDemoReplyFeedback(now)
  /** "Para responder": a decisão vale para a última mensagem do contato (`msgId`) */
  const replies = new Map<string, { msgId: string; decision: ReplyDecision }>(
    demo.flatMap((c) => {
      const last = c.messages[c.messages.length - 1]
      return c.reply && last && !last.fromMe ? [[c.jid, { msgId: last.id, decision: c.reply }] as const] : []
    })
  )
  const lastOf = (c: DemoContact) => c.messages[c.messages.length - 1]
  /**
   * "Respondido no grupo": depois da espera, o mentor escreveu num grupo pequeno (participantes conhecidos, até
   * GROUP_ANSWER_MAX_MEMBERS) de que o contato participa, ou mencionou/citou o contato em qualquer grupo (o mais recente)
   */
  const groupAnswerOf = (c: DemoContact): GroupAnswer | null => {
    const since = c.isGroup ? null : waitingSince(c)
    if (since === null) return null
    let best: GroupAnswer | null = null
    for (const g of demo) {
      if (!g.isGroup) continue
      const member = g.members.includes(c.jid) || g.messages.some((m) => m.senderJid === c.jid)
      const small = g.members.length > 0 && g.members.length <= GROUP_ANSWER_MAX_MEMBERS
      for (const m of g.messages) {
        if (!m.fromMe || m.ts <= since || (best && m.ts <= best.ts)) continue
        if ((member && small) || m.targets?.includes(c.jid)) best = { jid: g.jid, name: displayName(g), ts: m.ts }
      }
    }
    return best
  }
  /** a decisão vigente (null = ninguém decidiu, ou o mentor falou por último): mentor > grupo > Saga */
  const decisionOf = (c: DemoContact): ReplyDecision | null => {
    const last = lastOf(c)
    if (!last || last.fromMe) return null
    const r = replies.get(c.jid)
    const cur = r && r.msgId === last.id ? r.decision : null
    if (cur?.by === 'user') return cur
    const g = groupAnswerOf(c)
    if (g) return { needed: false, by: 'group', reason: `Respondido no grupo ${g.name}`, group: g }
    return cur
  }
  const needsReplyOf = (c: DemoContact): boolean => !!lastOf(c) && !lastOf(c).fromMe && (decisionOf(c)?.needed ?? true)
  const saveReplyFeedback = (jid: string, f: Omit<DemoReplyFeedback, 'jid' | 'createdAt'> & { alertId?: number }) => {
    const msgId = lastOf(find(jid)!).id
    const prev = replyFeedback.findIndex((x) => x.jid === jid && x.msgId === msgId)
    if (prev >= 0) replyFeedback.splice(prev, 1)
    replyFeedback.push({ jid, msgId, createdAt: Date.now(), ...f })
  }
  /** a próxima exportação: 'saved' (padrão) ou 'canceled' (o usuário fechou o "Salvar como") */
  let exportOutcome: 'saved' | 'canceled' = 'saved'
  const activeAlerts = (jid: string): Alert[] =>
    [...(alerts.get(jid) ?? [])].sort((a, b) => alertSeverity(a.kind) - alertSeverity(b.kind))
  const settings: SettingsView = {
    provider: 'groq',
    transcriber: 'groq',
    dailyCapUsd: 1,
    startWithWindows: false,
    claudeModel: 'claude',
    groqModel: 'groq',
    theme: opts.theme ?? 'system',
    keys: { groq: true, claude: false, openai: false }
  }
  const stateListeners = new Set<(s: AppState) => void>()
  const contactListeners = new Set<() => void>()
  const calls: FakeControl['calls'] = []
  let replyId = 0
  let generation = 0
  /** escolha por contato (Copiar/Salvar), guardada com a análise atual; some quando se gera de novo */
  const chosen = new Map<string, { index: number; replyId: number }>()
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  const snapshot = (): AppState => {
    const visible = demo.filter((c) => !hidden.has(c.jid))
    const awaiting = visible.filter(needsReplyOf).length
    const withAlerts = visible.filter((c) => activeAlerts(c.jid).length > 0).length
    return { ...state, triage: { awaiting, withAlerts } }
  }
  const emitState = () => stateListeners.forEach((l) => l(snapshot()))
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
      awaitingReply: !!last && !last.fromMe,
      isGroup: c.isGroup,
      waitingSince: waitingSince(c),
      alerts: activeAlerts(c.jid).map((a) => a.kind),
      needsReply: needsReplyOf(c),
      replyDecision: decisionOf(c)
    }
  }
  /** primeira mensagem do contato depois da última do mentor */
  function waitingSince(c: DemoContact): number | null {
    const last = c.messages[c.messages.length - 1]
    if (!last || last.fromMe) return null
    let i = c.messages.length - 1
    while (i > 0 && !c.messages[i - 1].fromMe) i--
    return c.messages[i].ts
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
    transcriptStatus: m.transcriptStatus,
    senderJid: m.senderJid ?? null,
    senderName: m.senderName ?? null,
    mentionsMe: m.mentionsMe ?? false
  })
  const find = (jid: string) => demo.find((c) => c.jid === jid)

  /** para qual última mensagem já houve uma geração (o "cache" válido) */
  const generatedFor = new Map<string, string>()
  async function analysisFor(jid: string, fresh: boolean): Promise<AnalysisResult> {
    const c = find(jid)
    if (!c) return { ok: false, code: 'no_messages', message: 'Ainda não há mensagens deste contato.', provider: state.provider }
    if (opts.aiDelayMs) await wait(opts.aiDelayMs)
    const lastMsgId = c.messages[c.messages.length - 1].id
    generatedFor.set(jid, lastMsgId)
    const pendingAudios = c.messages.filter((m) => m.kind === 'audio' && m.transcriptStatus === null).length
    let a = analyses.get(jid)
    if (!a || fresh) {
      if (fresh) chosen.delete(jid)
      generation++
      const base = a?.suggestions ?? ['Oi! Vi a sua mensagem e já te respondo com calma.', 'Obrigado por avisar. Vamos conversar sobre isso na nossa próxima sessão?']
      a = {
        provider: state.provider,
        summary: a?.summary ?? `${displayName(c)} mandou novas mensagens e espera a sua resposta.`,
        suggestions: fresh ? [...base.slice(1), generation % 2 ? EXTRA_SUGGESTION : base[0]] : base
      }
      analyses.set(jid, a)
    }
    // "Baseado em": as mensagens do contato desde a última do mentor
    let i = c.messages.length
    while (i > 0 && !c.messages[i - 1].fromMe) i--
    const asked = c.messages.slice(i).map((m) => m.text ?? m.transcript ?? '').join('\n')
    const sources = kb.sourcesFor(asked)
    return {
      ok: true,
      analysis: { jid, lastMsgId, provider: a.provider, summary: a.summary, suggestions: a.suggestions, createdAt: generation, transcriptFp: '', pendingAudios, sources, chosenIndex: chosen.get(jid)?.index ?? null, chosenReplyId: chosen.get(jid)?.replyId ?? null }
    }
  }

  /** busca geral em memória (mesmas regras do app: perguntas e palavras vazias saem; todas as palavras, senão qualquer uma) */
  function searchDemo(query: string, f: SearchFilters = {}): SearchResult & { ranked: Array<{ jid: string; name: string; text: string; ts: number }> } {
    const p = parseQuery(query.slice(0, SEARCH_LIMITS.queryChars))
    if (isEmptyQuery(p)) return { mode: 'empty', terms: [], total: 0, groups: [], tookMs: 0, ranked: [] }
    const days = SEARCH_PERIOD_DAYS[f.period ?? 'all']
    const since = days === null ? -Infinity : Date.now() - days * 86_400_000
    const pieces = p.prefixes.length + p.phrases.length
    const run = (need: number) => {
      const groups: SearchGroup[] = []
      for (const c of demo) {
        if (hidden.has(c.jid) || (f.kind === 'group' && !c.isGroup) || (f.kind === 'individual' && c.isGroup)) continue
        if (f.jid && f.jid !== c.jid) continue
        const hits = c.messages
          .filter((m) => m.ts >= since && (!f.audioOnly || m.kind === 'audio'))
          .map((m) => ({ m, body: [m.text, m.transcript].filter(Boolean).join(' ') }))
          .filter(({ body, m }) => matchedPieces(`${body} ${c.isGroup ? (m.senderName ?? '') : ''}`, p) >= need)
          .sort((a, b) => b.m.ts - a.m.ts)
          .map(({ m, body }) => ({
            id: m.id,
            jid: c.jid,
            ts: m.ts,
            fromMe: m.fromMe,
            kind: m.kind,
            senderName: c.isGroup && !m.fromMe ? (m.senderName ?? null) : null,
            snippet: buildSnippet(body || (m.senderName ?? ''), p)
          }))
        if (hits.length) groups.push({ jid: c.jid, name: displayName(c), isGroup: c.isGroup, count: hits.length, hits })
      }
      return groups.sort((a, b) => b.count - a.count || b.hits[0].ts - a.hits[0].ts)
    }
    let mode: 'and' | 'or' = 'and'
    let groups = run(pieces)
    if (!groups.length && pieces > 1) {
      mode = 'or'
      groups = run(1)
    }
    const ranked = groups.flatMap((g) => g.hits.map((h) => ({ jid: g.jid, name: g.name, text: h.snippet.text, ts: h.ts })))
    return { mode, terms: [...p.terms, ...p.phrases.map((x) => x.join(' '))], total: ranked.length, groups, tookMs: 3, ranked }
  }

  /** cópia de segurança de demonstração (nada é gravado) */
  const backup: BackupStatus = { lastAt: now - 3 * 86_400_000, auto: { enabled: true, folder: 'C:\\Users\\Mentor\\Google Drive\\Saga', hasPassword: true, lastAt: now - 3 * 86_400_000, lastError: null } }
  const backupCounts = (withMessages: boolean): BackupCounts => ({
    approvedReplies: 42,
    contacts: 9,
    alertFeedback: 17,
    replyFeedback: 11,
    kbPackages: 2,
    kbFiles: 9,
    settings: 5,
    messages: withMessages ? demo.reduce((n, c) => n + c.messages.length, 0) : 0
  })
  /** a cópia "aberta" para restaurar: o token, se tem senha (a senha certa é "senha123") */
  const opened = new Map<string, { encrypted: boolean; unlocked: boolean }>()
  let backupSeq = 0

  const api: SagaApi = {
    get initialTheme() {
      return settings.theme
    },
    getState: async () => snapshot(),
    onState: (cb) => {
      stateListeners.add(cb)
      return () => void stateListeners.delete(cb)
    },
    onContactsChanged: (cb) => {
      contactListeners.add(cb)
      return () => void contactListeners.delete(cb)
    },
    onMessages: () => () => {},

    listContacts: async (includeHidden, kind = 'all') =>
      demo
        .map(toContact)
        .filter((c) => includeHidden || !c.hidden)
        .filter((c) => kind === 'all' || (kind === 'group') === c.isGroup)
        .sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0)),
    listMessages: async (jid) => (find(jid)?.messages ?? []).map(toView),
    listAlerts: async (jid) =>
      jid !== undefined
        ? activeAlerts(jid)
        : demo
            .filter((c) => !hidden.has(c.jid))
            .flatMap((c) => activeAlerts(c.jid))
            .sort((a, b) => alertSeverity(a.kind) - alertSeverity(b.kind)),
    dismissAlert: async (jid, kind: AlertKind) => {
      record('dismissAlert', [jid, kind], undefined)
      alerts.set(
        jid,
        (alerts.get(jid) ?? []).filter((a) => a.kind !== kind)
      )
      contactListeners.forEach((l) => l())
      emitState()
    },
    rateAlert: async (alertId, verdict, reason) => {
      record('rateAlert', [alertId, verdict, reason], undefined)
      for (const [jid, list] of alerts) {
        const a = list.find((x) => x.id === alertId)
        if (!a) continue
        if (a.kind === 'esperando') {
          // 👍 = precisa responder mesmo; o 👎 do "esperando" é setNeedsReply(jid, false, motivo)
          if (verdict === 'down') throw new Error('use "Não precisa responder" para o alerta "esperando"')
          const app = decisionOf(find(jid)!)
          saveReplyFeedback(jid, { verdict: 'reply_needed', appNeeds: app && app.by !== 'user' ? app.needed : null, reasonCode: null, alertId })
          replies.set(jid, { msgId: lastOf(find(jid)!).id, decision: { needed: true, by: 'user', reason: null } })
          a.rating = 'up'
          contactListeners.forEach((l) => l())
          emitState()
          return
        }
        const prev = feedback.findIndex((f) => f.alertId === alertId)
        if (prev >= 0) feedback.splice(prev, 1)
        const correctKind = verdict === 'down' && reason?.code === 'tipo_errado' ? (reason.correctKind ?? null) : null
        feedback.push({ alertId, jid, kind: a.kind, verdict, reasonCode: reason?.code ?? null, correctKind, createdAt: Date.now() })
        if (verdict === 'up') a.rating = 'up'
        else {
          const rest = list.filter((x) => x.id !== alertId)
          if (correctKind && !rest.some((x) => x.kind === correctKind)) {
            rest.push({ id: ++alertSeq, jid, kind: correctKind, detail: reason?.text?.trim() || 'Marcado por você', msgId: a.msgId, createdAt: Date.now(), source: 'user', rating: null })
          }
          alerts.set(jid, rest)
        }
        contactListeners.forEach((l) => l())
        emitState()
        return
      }
      throw new Error('alerta não encontrado')
    },
    reportMissedAlert: async (jid, kind, msgId, text) => {
      record('reportMissedAlert', [jid, kind, msgId, text], undefined)
      feedback.push({ jid, kind, verdict: 'missed', reasonCode: null, correctKind: null, createdAt: Date.now() })
      const list = alerts.get(jid) ?? []
      if (!list.some((a) => a.kind === kind)) {
        alerts.set(jid, [...list, { id: ++alertSeq, jid, kind, detail: text?.trim() || 'Marcado por você', msgId: msgId ?? null, createdAt: Date.now(), source: 'user', rating: null }])
      }
      contactListeners.forEach((l) => l())
      emitState()
    },
    setNeedsReply: async (jid, needed, reason) => {
      record('setNeedsReply', [jid, needed, reason], undefined)
      const c = find(jid)
      if (!c || !lastOf(c) || lastOf(c).fromMe) throw new Error('a conversa não está esperando resposta')
      if (!needed && !reason) throw new Error('falta o motivo')
      const app = decisionOf(c)
      const appNeeds = app && app.by !== 'user' ? app.needed : null
      const waiting = (alerts.get(jid) ?? []).find((a) => a.kind === 'esperando')
      saveReplyFeedback(jid, {
        verdict: needed ? 'reply_needed' : 'reply_not_needed',
        appNeeds,
        reasonCode: needed ? null : reason!.code,
        ...(waiting && !needed ? { alertId: waiting.id } : {})
      })
      replies.set(jid, { msgId: lastOf(c).id, decision: { needed, by: 'user', reason: null } })
      if (!needed) alerts.set(jid, (alerts.get(jid) ?? []).filter((a) => a.kind !== 'esperando'))
      contactListeners.forEach((l) => l())
      emitState()
    },
    confirmNoReply: async (jid) => {
      record('confirmNoReply', [jid], undefined)
      const c = find(jid)
      const app = c ? decisionOf(c) : null
      if (!c || !app || app.by === 'user' || app.needed) throw new Error('o Saga não decidiu que esta conversa dispensa resposta')
      saveReplyFeedback(jid, { verdict: 'reply_ok', appNeeds: false, reasonCode: null })
      replies.set(jid, { msgId: lastOf(c).id, decision: { needed: false, by: 'user', reason: null } })
      contactListeners.forEach((l) => l())
      emitState()
    },
    alertQuality: async () => {
      const since = Date.now() - 30 * 86_400_000
      const recent = feedback.filter((f) => f.createdAt >= since)
      const replyRecent = replyFeedback.filter((f) => f.createdAt >= since)
      const right = replyRecent.filter((f) =>
        f.verdict === 'reply_ok' ? true : f.verdict === 'reply_needed' ? f.appNeeds !== false : f.appNeeds === false
      ).length
      const n = (k: AlertKind, v: string) => recent.filter((f) => f.kind === k && f.verdict === v).length
      return {
        since,
        days: 30,
        kinds: AI_ALERT_KINDS.map((kind) => {
          const up = n(kind, 'up')
          const down = n(kind, 'down')
          return { kind, up, down, missed: n(kind, 'missed'), correctRate: up + down ? up / (up + down) : null }
        }),
        reply: {
          removed: replyRecent.filter((f) => f.verdict === 'reply_not_needed').length,
          restored: replyRecent.filter((f) => f.verdict === 'reply_needed' && f.appNeeds === false).length,
          confirmed: replyRecent.filter((f) => f.verdict === 'reply_ok' || (f.verdict === 'reply_needed' && f.appNeeds !== false)).length,
          correctRate: replyRecent.length ? right / replyRecent.length : null
        }
      }
    },
    exportAlertFeedback: async (o) => {
      record('exportAlertFeedback', [o], undefined)
      const rows = feedback.length + replyFeedback.length
      if (rows === 0) return { status: 'empty' }
      return exportOutcome === 'canceled' ? { status: 'canceled' } : { status: 'saved', rows }
    },
    getAnalysis: async (jid, o) => {
      record('getAnalysis', [jid, o], undefined)
      const c = find(jid)
      // v0.3.1: abrir uma conversa que não precisa de resposta não gera nada (só mostra o que já foi gerado para ela)
      if (o?.onlyIfNeeded && c && !needsReplyOf(c) && generatedFor.get(jid) !== lastOf(c)?.id) {
        return { ok: false, code: 'not_needed', message: 'Esta conversa não precisa de resposta agora.', provider: state.provider }
      }
      return analysisFor(jid, false)
    },
    regenerate: (jid) => analysisFor(jid, true),

    saveReply: async (input) => {
      const id = ++replyId
      if (input.chosenIndex !== undefined) chosen.set(input.jid, { index: input.chosenIndex, replyId: id })
      return record('saveReply', [input], id)
    },
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
      record('manualReconnect', [], undefined)
      state.conn = 'connecting'
      state.qr = null
      emitState()
    },
    downloadUpdate: async () => {
      if (state.update.status !== 'available') return
      state.update = { status: 'ready', version: state.update.version }
      emitState()
    },
    installUpdate: async () => {
      record('installUpdate', [], undefined)
    },
    checkForUpdates: async () => {
      record('checkForUpdates', [], undefined)
      const at = Date.now()
      const v = state.update.status !== 'none' ? state.update.version : null
      state.updateCheck = {
        ...state.updateCheck,
        checking: false,
        lastCheckAt: at,
        lastResult: v ? 'available' : 'up_to_date',
        latestVersion: v ?? state.updateCheck.currentVersion,
        lastError: null
      }
      emitState()
      return { ...state.updateCheck }
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
    copyDiagnostics: async () => record('copyDiagnostics', [], 42),
    openLogsFolder: async () => record('openLogsFolder', [], undefined),
    audioUrl: async (id) => `saga-media://audio/${id}`,
    kbList: () => kb.kbList(),
    kbImport: async (kind) => record('kbImport', [kind], await kb.kbImport(kind)),
    kbAddFile: async () => record('kbAddFile', [], await kb.kbAddFile()),
    kbAddText: async (title, text) => record('kbAddText', [title, text], await kb.kbAddText(title, text)),
    kbUpdateFile: async (id, patch) => record('kbUpdateFile', [id, patch], await kb.kbUpdateFile(id, patch)),
    kbSetPackageEnabled: async (id, enabled) => record('kbSetPackageEnabled', [id, enabled], await kb.kbSetPackageEnabled(id, enabled)),
    kbRemovePackage: async (id) => record('kbRemovePackage', [id], await kb.kbRemovePackage(id)),
    kbGetChunk: (id) => kb.kbGetChunk(id),
    searchMessages: async (query, filters) => {
      const { ranked: _, ...r } = searchDemo(query, filters)
      return record('searchMessages', [query, filters], r)
    },
    backupStatus: async () => structuredClone(backup),
    exportBackup: async (o) => {
      record('exportBackup', [o], undefined)
      if (exportOutcome === 'canceled') return { status: 'canceled' }
      backup.lastAt = Date.now()
      return { status: 'saved', counts: backupCounts(o.includeMessages), bytes: o.includeMessages ? 2_400_000 : 380_000, encrypted: !!o.password }
    },
    restoreOpen: async () => {
      record('restoreOpen', [], undefined)
      if (exportOutcome === 'canceled') return { status: 'canceled' }
      const token = `00000000-0000-4000-8000-${String(++backupSeq).padStart(12, '0')}`
      opened.set(token, { encrypted: true, unlocked: false })
      return { status: 'needs_password', token, createdAt: now - 2 * 86_400_000 }
    },
    restoreUnlock: async (token, password) => {
      const o = opened.get(token)
      if (!o) return { status: 'error', code: 'expired', message: 'Escolha o arquivo da cópia de novo.' }
      if (password !== 'senha123') return { status: 'error', code: 'wrong_password', message: 'Senha incorreta. Confira e tente de novo.' }
      o.unlocked = true
      return { status: 'preview', token, preview: { createdAt: now - 2 * 86_400_000, appVersion: '0.3.1', encrypted: true, counts: backupCounts(false) } }
    },
    restoreApply: async (token, mode) => {
      record('restoreApply', [token, mode], undefined)
      const o = opened.get(token)
      if (!o || (o.encrypted && !o.unlocked)) return { status: 'error', code: 'expired', message: 'Escolha o arquivo da cópia de novo.' }
      opened.delete(token)
      const c = backupCounts(false)
      return { status: 'restored', mode, counts: mode === 'merge' ? { ...c, approvedReplies: 12, alertFeedback: 4, replyFeedback: 2, kbFiles: 3 } : c, uiPrefs: {} }
    },
    chooseBackupFolder: async () => {
      record('chooseBackupFolder', [], undefined)
      backup.auto.folder = 'C:\\Users\\Mentor\\OneDrive\\Saga'
      return structuredClone(backup)
    },
    setAutoBackup: async (patch) => {
      record('setAutoBackup', [patch], undefined)
      if (patch.enabled !== undefined) backup.auto.enabled = patch.enabled
      if (patch.password !== undefined) backup.auto.hasPassword = !!patch.password
      return structuredClone(backup)
    },
    summarizeSearch: async (query, filters) => {
      record('summarizeSearch', [query, filters], undefined)
      const r = searchDemo(query, filters)
      if (!r.ranked.length) return { ok: false, code: 'no_results', message: 'Nenhuma mensagem encontrada para resumir.' }
      if (opts.aiDelayMs) await wait(opts.aiDelayMs)
      const refs = r.groups.slice(0, 3).map((g) => ({ jid: g.jid, name: g.name }))
      const names = refs.map((x) => x.name)
      const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}` : names[0]
      return {
        ok: true,
        answer: `O assunto apareceu em ${list}. ${refs.length > 1 ? 'Nas duas primeiras conversas' : 'Lá'} pedem ajuda para definir o preço sem perder clientes; vale levar o tema para a próxima aula.`,
        refs,
        used: Math.min(r.ranked.length, SEARCH_LIMITS.summarySnippets)
      }
    }
  }

  return {
    api,
    calls,
    setState(patch) {
      Object.assign(state, patch)
      emitState()
    },
    setExportOutcome(o) {
      exportOutcome = o
    }
  }
}

declare global {
  interface Window {
    __sagaFake?: FakeControl
  }
}

/**
 * Instala o falso em `window.saga`. Na pré-visualização, `?state={"conn":"waiting_retry"}` mexe no estado inicial,
 * `?setup=1` mostra o assistente com um QR Code, `?qr=1` mostra o QR na tela principal (vincular de novo) e
 * `?theme=dark|light|system` escolhe o tema salvo.
 */
export async function installFakeSaga(): Promise<void> {
  const params = new URLSearchParams(location.search)
  let patch: Partial<AppState> = {}
  try {
    patch = JSON.parse(params.get('state') ?? '{}')
  } catch {
    // ignora estado inválido na URL
  }
  if (params.get('setup') || params.get('qr')) {
    const QRCode = (await import('qrcode')).default
    const qr = await QRCode.toDataURL('saga-demo-qr-nao-e-um-codigo-real', { margin: 1, width: 240 })
    patch = { setupDone: !params.get('setup'), conn: 'needs_qr', qr, ...patch }
  }
  if (patch.conn === 'waiting_retry' && patch.retryAt === undefined) patch.retryAt = Date.now() + 2 * 60_000
  const t = params.get('theme')
  const theme = t === 'light' || t === 'dark' || t === 'system' ? t : undefined
  const ctl = createFakeSaga({ state: patch, aiDelayMs: 600, theme })
  window.saga = ctl.api
  window.__sagaFake = ctl
}
