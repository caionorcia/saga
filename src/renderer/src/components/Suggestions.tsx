import { useCallback, useEffect, useRef, useState } from 'react'
import type { AiErrorCode, Analysis, KbSource, MessageView, SendView } from '../../../shared/api'
import { KbSources } from './KbSources'
import { SendDialog, SendStatus } from './SendDialog'

type View =
  | { kind: 'loading' }
  | { kind: 'ready'; analysis: Analysis }
  | { kind: 'error'; code: AiErrorCode | 'exception'; message: string }
  /** v0.3.1: a conversa não precisa de resposta; nada foi gerado (só com "Gerar sugestões mesmo assim") */
  | { kind: 'not_needed' }

const REFRESH_DEBOUNCE_MS = 2_000
const COPIED_MS = 2_000

const GENERIC_ERROR = 'Não foi possível gerar as sugestões agora.'

export const providerLabel = (provider: string): string =>
  provider === 'groq' ? 'Groq (grátis)' : provider === 'claude' ? 'Claude' : provider

/** Erros em que tentar de novo não adianta sem o mentor mexer em algo. */
const NO_RETRY: ReadonlySet<string> = new Set(['budget_exceeded', 'missing_key', 'invalid_key', 'no_messages'])

function errorText(code: string, message: string): string {
  if (code === 'budget_exceeded') {
    return 'Limite de gasto diário atingido. Aumente o teto em Configurações para gerar mais sugestões.'
  }
  return message || GENERIC_ERROR
}

/**
 * As mensagens que chegaram depois da análise são todas do próprio mentor (ele respondeu)?
 * Nesse caso não vale gastar uma geração nova nem trocar os cartões em silêncio.
 */
export function onlyOwnNewMessages(messages: MessageView[], lastMsgId: string): boolean {
  const idx = messages.findIndex((m) => m.id === lastMsgId)
  if (idx < 0) return false
  const after = messages.slice(idx + 1)
  return after.length > 0 && after.every((m) => m.fromMe)
}

const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible'

/**
 * Rascunhos editados pelo mentor, por `jid:índice`; vivem acima do componente para sobreviver a trocas de tela. A
 * mensagem avulsa (v0.6.0) fica em `avulsa|jid`, com o id do rascunho, se a caixa está aberta e o envio dela.
 */
export type DraftStore = Map<string, { original: string; text: string; draftId?: string; open?: boolean; sendId?: number | null }>

const draftKey = (jid: string, i: number) => `${jid}:${i}`

function hasDirtyDraft(drafts: DraftStore, jid: string): boolean {
  for (const [k, d] of drafts) if (k.startsWith(`${jid}:`) && d.text !== d.original) return true
  return false
}

function clearDrafts(drafts: DraftStore, jid: string): void {
  for (const k of [...drafts.keys()]) if (k.startsWith(`${jid}:`)) drafts.delete(k)
}

interface Props {
  jid: string
  /** avisa o resumo ("O que a pessoa quer") sempre que a análise mudar */
  onAnalysis?: (analysis: Analysis | null) => void
  /** rascunhos guardados fora do componente (padrão: só enquanto ele existir) */
  drafts?: DraftStore
  /** botão "Abrir Configurações" nos erros de chave */
  onOpenSettings?: () => void
  /** avisa quando a conversa não precisa de resposta e nada foi gerado (o resumo mostra isso) */
  onSkipped?: (skipped: boolean) => void
}

export function Suggestions({ jid, onAnalysis, drafts: draftsProp, onOpenSettings, onSkipped }: Props) {
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [newMessage, setNewMessage] = useState(false)
  /** índice da sugestão escolhida (Copiar ou Salvar) e se as outras foram trazidas de volta */
  const [chosen, setChosen] = useState<number | null>(null)
  const [showOthers, setShowOthers] = useState(false)
  const [announce, setAnnounce] = useState('')
  /** "Envio direto" ligado nas Configurações (o botão Enviar só aparece assim) */
  const [directSend, setDirectSend] = useState(false)
  /** os envios desta conversa e a resposta (memória) da escolha atual: o cartão escolhido mostra o envio dela */
  const [sends, setSends] = useState<SendView[]>([])
  const [chosenReplyId, setChosenReplyId] = useState<number | null>(null)
  const ownDrafts = useRef<DraftStore>(new Map())
  const drafts = draftsProp ?? ownDrafts.current
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const viewRef = useRef(view)
  viewRef.current = view
  /** um pedido "normal" (abrir, tentar de novo, gerar novas) em andamento */
  const normalInFlight = useRef(false)
  const current = useRef<Analysis | null>(null)
  const onAnalysisRef = useRef(onAnalysis)
  onAnalysisRef.current = onAnalysis
  const onSkippedRef = useRef(onSkipped)
  onSkippedRef.current = onSkipped
  const seq = useRef(0)

  const apply = useCallback(
    (run: () => Promise<Awaited<ReturnType<typeof window.saga.getAnalysis>>>, silent: boolean) => {
      // atualização silenciosa nunca atropela um pedido em andamento
      if (silent && normalInFlight.current) return
      const mine = ++seq.current
      if (!silent) {
        normalInFlight.current = true
        setView({ kind: 'loading' })
        setNewMessage(false)
        setChosen(null)
        setShowOthers(false)
        setAnnounce('')
        current.current = null
        onAnalysisRef.current?.(null)
      }
      setBusy(true)
      run()
        .then((r) => {
          if (mine !== seq.current) return
          if (r.ok) {
            if (silent) {
              if (current.current?.lastMsgId === r.analysis.lastMsgId) return
              // chegou mensagem e o mentor está editando: não troca os cartões, só avisa
              if (hasDirtyDraft(draftsRef.current, jid)) {
                setNewMessage(true)
                return
              }
            }
            clearDrafts(draftsRef.current, jid)
            current.current = r.analysis
            setChosen(r.analysis.chosenIndex ?? null)
            setChosenReplyId(r.analysis.chosenReplyId ?? null)
            setShowOthers(false)
            setView({ kind: 'ready', analysis: r.analysis })
            onAnalysisRef.current?.(r.analysis)
            onSkippedRef.current?.(false)
          } else if (r.code === 'not_needed') {
            // nada gerado: na atualização silenciosa, os cartões gerados "mesmo assim" continuam
            if (!silent || viewRef.current.kind !== 'ready') {
              setView({ kind: 'not_needed' })
              onSkippedRef.current?.(true)
            }
          } else if (!silent || viewRef.current.kind === 'loading') {
            setView({ kind: 'error', code: r.code, message: r.message })
          }
        })
        .catch(() => {
          if (mine !== seq.current) return
          if (!silent || viewRef.current.kind === 'loading') setView({ kind: 'error', code: 'exception', message: GENERIC_ERROR })
        })
        .finally(() => {
          if (mine === seq.current) {
            setBusy(false)
            if (!silent) normalInFlight.current = false
          }
        })
    },
    [jid]
  )

  /** abrir a conversa: só gera se ela precisa de resposta (senão mostra o que já havia, ou o convite para gerar) */
  const load = useCallback(() => apply(() => window.saga.getAnalysis(jid, { onlyIfNeeded: true }), false), [apply, jid])
  /** "Gerar sugestões mesmo assim" e "Tentar de novo": pedido do mentor, gera de qualquer jeito */
  const loadAnyway = useCallback(() => apply(() => window.saga.getAnalysis(jid), false), [apply, jid])

  /** chegou algo com a janela escondida (bandeja): atualizar uma vez quando ela voltar a aparecer */
  const staleWhileHidden = useRef(false)

  /**
   * Atualização silenciosa (mensagem ou transcrição nova). Nunca gera em segundo plano com a janela
   * escondida, e não gera quando a única novidade é a resposta do próprio mentor.
   */
  const silentRefresh = useCallback(async () => {
    if (!isVisible()) {
      staleWhileHidden.current = true
      return
    }
    staleWhileHidden.current = false
    const cur = current.current
    // análise feita com áudio pendente: a novidade pode ser a transcrição terminando, então deixa o serviço decidir
    if (cur && cur.pendingAudios === 0) {
      try {
        if (onlyOwnNewMessages(await window.saga.listMessages(jid), cur.lastMsgId)) return
      } catch {
        // sem a lista, segue: o serviço decide pelo cache
      }
    }
    apply(() => window.saga.getAnalysis(jid, { onlyIfNeeded: true }), true)
  }, [apply, jid])

  useEffect(() => {
    let alive = true
    window.saga
      .getSettings()
      .then((st) => alive && setDirectSend(st.directSend))
      .catch(() => {})
    const refresh = () =>
      void window.saga
        .listSends(jid)
        .then((l) => alive && setSends(l))
        .catch(() => {})
    refresh()
    const off = window.saga.onSends(jid, refresh)
    return () => {
      alive = false
      off()
    }
  }, [jid])

  useEffect(() => {
    load()
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.saga.onMessages(jid, () => {
      clearTimeout(timer)
      timer = setTimeout(() => void silentRefresh(), REFRESH_DEBOUNCE_MS)
    })
    const onVisibility = () => {
      if (isVisible() && staleWhileHidden.current) void silentRefresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearTimeout(timer)
      off()
      document.removeEventListener('visibilitychange', onVisibility)
      staleWhileHidden.current = false
      seq.current++
      normalInFlight.current = false
    }
  }, [jid, load, silentRefresh])

  if (view.kind === 'loading') {
    return (
      <div className="sug-state" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        Gerando sugestões…
      </div>
    )
  }

  /** v0.6.0: "Enviar mensagem avulsa" (só com o envio direto ligado): sempre ao alcance na conversa escolhida */
  const avulsa = directSend ? (
    <AvulsaComposer key={jid} jid={jid} drafts={drafts} sends={sends} onQueued={(send) => setSends((cur) => [send, ...cur.filter((x) => x.id !== send.id)])} />
  ) : null

  if (view.kind === 'not_needed') {
    return (
      <>
        <div className="sug-state sug-not-needed" role="status">
          <p>Esta conversa não precisa de resposta agora.</p>
          <p className="muted small">O SagaZap só escreve sugestões quando você pede, para não gastar à toa.</p>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={loadAnyway}>
            Gerar sugestões mesmo assim
          </button>
        </div>
        {avulsa}
      </>
    )
  }

  if (view.kind === 'error') {
    return (
      <>
      <div className="sug-state sug-error" role="alert">
        <p>{errorText(view.code, view.message)}</p>
        {(view.code === 'missing_key' || view.code === 'invalid_key' || view.code === 'model_unavailable') && onOpenSettings && (
          <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
            Abrir Configurações
          </button>
        )}
        {!NO_RETRY.has(view.code) && (
          <button type="button" className="btn btn-primary" onClick={loadAnyway}>
            Tentar de novo
          </button>
        )}
      </div>
      {avulsa}
      </>
    )
  }

  const { analysis } = view
  const collapsed = chosen !== null && !showOthers
  const choose = (i: number, replyId?: number) => {
    if (replyId !== undefined) setChosenReplyId(replyId)
    setChosen(i)
    setShowOthers(false)
    setAnnounce('Resposta escolhida')
  }
  return (
    <div className="sug-list">
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>
      {newMessage && (
        <div className="sug-notice" role="status">
          Chegou mensagem nova — suas edições foram mantidas.{' '}
          <button type="button" className="link-btn" disabled={busy} onClick={() => apply(() => window.saga.regenerate(jid), false)}>
            Gerar novas
          </button>
        </div>
      )}
      {analysis.suggestions.map((text, i) => (
        <SuggestionCard
          // a chave inclui a geração: "Gerar novas" recomeça os cartões
          key={`${analysis.createdAt}-${analysis.lastMsgId}-${i}`}
          jid={jid}
          index={i}
          original={text}
          analysisLastMsgId={analysis.lastMsgId}
          drafts={drafts}
          sources={analysis.sources}
          chosen={chosen === i}
          out={collapsed && chosen !== i}
          persistedChoice={analysis.chosenIndex === i}
          persistedReplyId={analysis.chosenIndex === i ? (analysis.chosenReplyId ?? null) : null}
          onChoose={(replyId) => choose(i, replyId)}
          directSend={directSend}
          send={chosen === i ? (sends.find((x) => x.kind !== 'avulsa' && x.replyId === chosenReplyId) ?? null) : null}
          onQueued={(send) => setSends((cur) => [send, ...cur.filter((x) => x.id !== send.id)])}
        />
      ))}
      {collapsed && (
        <button type="button" className="link-btn sug-more" onClick={() => setShowOthers(true)}>
          Mostrar as outras sugestões
        </button>
      )}
      <div className="sug-footer">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => apply(() => window.saga.regenerate(jid), false)}
        >
          Gerar novas
        </button>
        <span className="muted">Gerado por: {providerLabel(analysis.provider)}</span>
      </div>
      {avulsa}
    </div>
  )
}

function SuggestionCard({
  jid,
  index,
  original,
  analysisLastMsgId,
  drafts,
  sources,
  chosen,
  out,
  persistedChoice,
  persistedReplyId,
  onChoose,
  directSend,
  send,
  onQueued
}: {
  jid: string
  index: number
  original: string
  /** a análise que gerou esta sugestão: o contexto salvo na memória é o dela */
  analysisLastMsgId: string
  drafts: DraftStore
  /** trechos de conhecimento da base usados na geração ("Baseado em") */
  sources?: KbSource[]
  /** este é o cartão escolhido */
  chosen: boolean
  /** outro cartão foi escolhido: este some (fica montado para não perder a edição) */
  out: boolean
  /** a escolha veio do banco (conversa reaberta): a resposta já foi salva antes */
  persistedChoice: boolean
  /** o id dessa resposta salva (para o envio reaproveitar, sem duplicar na memória) */
  persistedReplyId: number | null
  /** escolheu este cartão; `replyId` = a resposta salva na memória */
  onChoose: (replyId?: number) => void
  /** mostra o botão Enviar (Configurações › Envio direto) */
  directSend: boolean
  /** o envio da resposta escolhida (só no cartão escolhido) */
  send: SendView | null
  onQueued: (send: SendView) => void
}) {
  const key = draftKey(jid, index)
  const [text, setText] = useState(() => {
    const d = drafts.get(key)
    return d && d.original === original ? d.text : original
  })
  const [saved, setSaved] = useState(persistedChoice)
  /** último texto gravado na memória: copiar só salva de novo se o texto mudou */
  const lastSaved = useRef<string | null>(persistedChoice ? text : null)
  const lastSavedId = useRef<number | null>(persistedChoice ? persistedReplyId : null)
  const [sending, setSending] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  // ao escolher, o foco fica neste cartão (os outros somem)
  useEffect(() => {
    const el = cardRef.current
    if (chosen && el && !el.contains(document.activeElement)) el.focus()
  }, [chosen])

  /** grava na memória (com as não escolhidas, que o serviço tira da análise); devolve se deu certo */
  const persist = async (): Promise<boolean> => {
    if (lastSaved.current === text) return true
    try {
      lastSavedId.current = await window.saga.saveReply({ jid, originalSuggestion: original, finalText: text, analysisLastMsgId, chosenIndex: index })
      lastSaved.current = text
      setSaved(true)
      return true
    } catch {
      setFailed('Não foi possível salvar. Tente de novo.')
      return false
    }
  }

  const save = async () => {
    setFailed(null)
    if (await persist()) onChoose(lastSavedId.current ?? undefined)
  }

  // copiar também ensina o sistema: salva a versão copiada (se ainda não está salva) e escolhe este cartão
  const copy = async () => {
    setFailed(null)
    try {
      await window.saga.copyToClipboard(text)
    } catch {
      setFailed('Não foi possível copiar. Tente de novo.')
      return
    }
    setCopied(true)
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), COPIED_MS)
    await persist()
    onChoose(lastSavedId.current ?? undefined)
  }

  /** "Enviar" confirmado no diálogo: a resposta foi escolhida e salva (com o texto final) e o envio está na fila */
  const queued = (finalText: string, sv: SendView) => {
    setSending(false)
    setText(finalText)
    drafts.set(key, { original, text: finalText })
    lastSaved.current = finalText
    lastSavedId.current = sv.replyId
    setSaved(true)
    onQueued(sv)
    onChoose(sv.replyId ?? undefined)
  }
  /** o envio da escolha está acontecendo ou já saiu: não oferece Enviar de novo */
  const sendBusy = !!send && (send.status === 'queued' || send.status === 'typing' || send.status === 'sending' || send.status === 'sent')

  const id = `sug-${index}`
  return (
    <div
      ref={cardRef}
      className={`sug-card${chosen ? ' sug-chosen' : ''}${out ? ' sug-out' : ''}`}
      role="group"
      aria-label={`Sugestão ${index + 1}`}
      aria-hidden={out || undefined}
      tabIndex={-1}
      {...(out ? { inert: '' } : {})}
    >
      <div className="sug-head">
        <label htmlFor={id} className="sug-label">
          Sugestão {index + 1}
        </label>
        {chosen && <span className="sug-badge">✓ Resposta escolhida</span>}
      </div>
      <textarea
        id={id}
        value={text}
        rows={5}
        // o texto na fila é o que vai sair: não muda enquanto o envio não termina
        readOnly={!!send && (send.status === 'queued' || send.status === 'typing' || send.status === 'sending')}
        onChange={(e) => {
          setText(e.target.value)
          drafts.set(key, { original, text: e.target.value })
          setSaved(false)
          setCopied(false)
        }}
      />
      <KbSources sources={sources} />
      {failed && (
        <p className="field-error" role="alert">
          {failed}
        </p>
      )}
      <div className="sug-actions">
        <button type="button" className={saved ? 'btn btn-done' : 'btn'} onClick={save} disabled={saved || !text.trim()}>
          {saved ? 'Salvo ✓' : 'Salvar'}
        </button>
        <button type="button" className={copied ? 'btn btn-done' : directSend ? 'btn' : 'btn btn-primary'} onClick={copy}>
          {copied ? 'Copiado ✓' : 'Copiar'}
        </button>
        {directSend && !sendBusy && (
          <button type="button" className="btn btn-primary" onClick={() => setSending(true)} disabled={!text.trim()}>
            Enviar
          </button>
        )}
      </div>
      {send && <SendStatus send={send} onResend={() => setSending(true)} />}
      {sending && (
        <SendDialog
          jid={jid}
          text={text}
          extras={{
            replyId: lastSaved.current === text.trim() || lastSaved.current === text ? lastSavedId.current : null,
            originalSuggestion: original,
            analysisLastMsgId,
            chosenIndex: index
          }}
          onClose={() => setSending(false)}
          onQueued={queued}
        />
      )}
    </div>
  )
}

/** Id do rascunho da mensagem avulsa (a chave de idempotência do envio leva ele). */
function newDraftId(): string {
  try {
    const id = globalThis.crypto?.randomUUID?.()
    if (id) return id
  } catch {
    // sem `crypto`: cai no sorteio abaixo
  }
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

const avulsaKey = (jid: string) => `avulsa|${jid}`
const ACTIVE: ReadonlySet<SendView['status']> = new Set(['queued', 'typing', 'sending'])

/**
 * v0.6.0 "Enviar mensagem avulsa": uma mensagem escrita pelo mentor, sem ser resposta a uma sugestão. A caixa edita
 * como o cartão de sugestão (o texto sobrevive a trocas de tela) e o "Enviar" abre a MESMA confirmação e a mesma fila
 * das respostas (token de uso único, ritmo, tetos, horário com "Forçar envio", "digitando…"). Sem citação, sem memória.
 * O id do rascunho nasce quando a caixa abre: o mesmo rascunho com o mesmo texto nunca envia duas vezes.
 */
function AvulsaComposer({ jid, drafts, sends, onQueued }: { jid: string; drafts: DraftStore; sends: SendView[]; onQueued: (send: SendView) => void }) {
  const key = avulsaKey(jid)
  const stored = drafts.get(key)
  const [open, setOpen] = useState(stored?.open === true)
  const [text, setText] = useState(stored?.text ?? '')
  const [draftId, setDraftId] = useState(() => stored?.draftId ?? newDraftId())
  const [sendId, setSendId] = useState<number | null>(stored?.sendId ?? null)
  const [sending, setSending] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  const keep = (patch: Partial<{ open: boolean; text: string; draftId: string; sendId: number | null }>) => {
    const cur = { original: '', text, draftId, open, sendId, ...drafts.get(key) }
    drafts.set(key, { ...cur, ...patch })
  }

  const send = sendId !== null ? (sends.find((x) => x.id === sendId) ?? null) : null
  const busy = !!send && ACTIVE.has(send.status)

  const start = () => {
    setOpen(true)
    keep({ open: true, text, draftId, sendId })
    setTimeout(() => areaRef.current?.focus(), 0)
  }
  /** fecha e esquece o rascunho (um envio que já está na fila segue; o estado dele fica na lista de envios) */
  const discard = () => {
    const id = newDraftId()
    setOpen(false)
    setText('')
    setDraftId(id)
    setSendId(null)
    drafts.delete(key)
  }
  /** depois de enviada: caixa vazia para outra mensagem (rascunho novo) */
  const another = () => {
    const id = newDraftId()
    setText('')
    setDraftId(id)
    setSendId(null)
    drafts.set(key, { original: '', text: '', draftId: id, open: true, sendId: null })
    setTimeout(() => areaRef.current?.focus(), 0)
  }
  const queued = (finalText: string, sv: SendView) => {
    setSending(false)
    setText(finalText)
    setSendId(sv.id)
    keep({ text: finalText, sendId: sv.id, open: true })
    onQueued(sv)
  }

  if (!open) {
    return (
      <button type="button" className="btn sug-avulsa-btn" onClick={start}>
        Enviar mensagem avulsa
      </button>
    )
  }
  return (
    <div className="sug-card sug-avulsa" role="group" aria-label="Mensagem avulsa">
      <div className="sug-head">
        <label htmlFor={`avulsa-${draftId}`} className="sug-label">
          Mensagem avulsa
        </label>
      </div>
      <textarea
        id={`avulsa-${draftId}`}
        ref={areaRef}
        value={text}
        rows={4}
        placeholder="Escreva a mensagem…"
        // o texto na fila é o que vai sair: não muda enquanto o envio não termina
        readOnly={busy}
        onChange={(e) => {
          setText(e.target.value)
          keep({ text: e.target.value })
        }}
      />
      <div className="sug-actions">
        {send?.status === 'sent' ? (
          <button type="button" className="btn" onClick={another}>
            Nova mensagem avulsa
          </button>
        ) : (
          <button type="button" className="btn" onClick={discard} disabled={busy}>
            Descartar
          </button>
        )}
        {!busy && send?.status !== 'sent' && (
          <button type="button" className="btn btn-primary" onClick={() => setSending(true)} disabled={!text.trim()}>
            Enviar
          </button>
        )}
      </div>
      {send && <SendStatus send={send} onResend={() => setSending(true)} />}
      {sending && <SendDialog jid={jid} text={text} avulsa={{ draftId }} onClose={() => setSending(false)} onQueued={queued} />}
    </div>
  )
}
