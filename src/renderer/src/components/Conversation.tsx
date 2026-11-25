import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Alert, AlertKind, Analysis, Contact, MessageView, ReplyDecision, ReplyReason } from '../../../shared/api'
import { alertChipLabel, formatDayHeading, formatDuration, formatTime, initials, sameDay } from '../format'
import { AlertIcon } from './Alerts'
import { MissedAlertDialog, NoReplyDialog, NoReplyIcon, RateDownDialog, THANKS, Toast } from './AlertFeedback'
import { GroupIcon } from './GroupIcon'

interface Props {
  contact: Contact
  analysis: Analysis | null
  /** alertas ativos desta conversa (mais graves primeiro) */
  alerts?: Alert[]
  /** "Resolver" */
  onDismissAlert?: (kind: AlertKind) => void
}

const HIGHLIGHT_MS = 2_500

export function Conversation({ contact, analysis, alerts = [], onDismissAlert }: Props) {
  const [messages, setMessages] = useState<MessageView[] | null>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  /** avaliações feitas agora (antes de a lista de alertas voltar do processo principal) */
  const [rated, setRated] = useState<Map<number, 'up' | 'down'>>(new Map())
  const [downFor, setDownFor] = useState<Alert | null>(null)
  const [missedOpen, setMissedOpen] = useState(false)
  /** "Não precisa responder" aberto (do cabeçalho, ou do 👎 no "esperando": o id do alerta) */
  const [noReplyOpen, setNoReplyOpen] = useState<{ alertId: number | null } | null>(null)
  /** decisão do "Para responder" feita agora (antes de a lista voltar do processo principal); undefined = a do contato */
  const [replyLocal, setReplyLocal] = useState<ReplyDecision | null | undefined>(undefined)
  const [toast, setToast] = useState<{ text: string; seq: number } | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  /** o mentor está lendo o fim da conversa: acompanhar mensagens novas e mudanças de altura */
  const pinned = useRef(true)
  const jid = contact.jid

  useEffect(() => {
    let alive = true
    setMessages(null)
    const load = () =>
      window.saga
        .listMessages(jid)
        .then((m) => alive && setMessages(m))
        .catch(() => alive && setMessages((old) => old ?? []))
    void load()
    const off = window.saga.onMessages(jid, () => void load())
    return () => {
      alive = false
      off()
    }
  }, [jid])

  const toBottom = () => {
    const el = threadRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }
  useLayoutEffect(toBottom, [messages, analysis])
  useEffect(() => {
    const el = threadRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    // o cartão de resumo cresce depois e encolhe a área das mensagens
    const ro = new ResizeObserver(toBottom)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // clicar num alerta: rola até a mensagem que o motivou e destaca por alguns segundos
  useEffect(() => {
    if (!highlight) return
    const t = setTimeout(() => setHighlight(null), HIGHLIGHT_MS)
    return () => clearTimeout(t)
  }, [highlight])
  const showMessage = (id: string) => {
    const el = [...(threadRef.current?.querySelectorAll<HTMLElement>('[data-msg-id]') ?? [])].find((e) => e.dataset.msgId === id)
    pinned.current = false
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    setHighlight(id)
  }

  const thank = (text = THANKS) => setToast((t) => ({ text, seq: (t?.seq ?? 0) + 1 }))
  const failed = () => thank('Não foi possível salvar a avaliação. Tente de novo.')
  const mark = (id: number, v: 'up' | 'down' | null) =>
    setRated((m) => {
      const n = new Map(m)
      if (v) n.set(id, v)
      else n.delete(id)
      return n
    })
  const rateUp = (a: Alert) => {
    mark(a.id, 'up')
    thank()
    window.saga.rateAlert(a.id, 'up').catch(() => {
      mark(a.id, null)
      failed()
    })
  }
  // a lista voltou do processo principal: vale a decisão de lá
  const decisionKey = JSON.stringify([contact.lastTs, contact.replyDecision])
  useEffect(() => setReplyLocal(undefined), [decisionKey])
  const decision = replyLocal !== undefined ? replyLocal : contact.replyDecision
  const needsReply = contact.awaitingReply && (decision?.needed ?? true)

  const saveNoReply = (reason: ReplyReason, alertId: number | null) => {
    setNoReplyOpen(null)
    const prev = replyLocal
    setReplyLocal({ needed: false, by: 'user', reason: null })
    if (alertId !== null) mark(alertId, 'down')
    thank()
    window.saga.setNeedsReply(jid, false, reason).catch(() => {
      setReplyLocal(prev)
      if (alertId !== null) mark(alertId, null)
      failed()
    })
  }
  const restoreReply = () => {
    const prev = replyLocal
    setReplyLocal({ needed: true, by: 'user', reason: null })
    thank()
    window.saga.setNeedsReply(jid, true).catch(() => {
      setReplyLocal(prev)
      failed()
    })
  }
  const confirmNoReply = () => {
    const prev = replyLocal
    setReplyLocal({ needed: false, by: 'user', reason: null })
    thank()
    window.saga.confirmNoReply(jid).catch(() => {
      setReplyLocal(prev)
      failed()
    })
  }

  const shownAlerts = alerts
    .filter((a) => rated.get(a.id) !== 'down')
    .map((a) => (rated.has(a.id) ? { ...a, rating: rated.get(a.id)! } : a))

  return (
    <section className="conversation" aria-label={`${contact.isGroup ? 'Grupo' : 'Conversa com'} ${contact.displayName}`}>
      <header className="conv-head">
        {contact.isGroup ? (
          <span className="avatar avatar-group" aria-hidden="true">
            <GroupIcon />
          </span>
        ) : (
          <span className="avatar" aria-hidden="true">
            {initials(contact.displayName)}
          </span>
        )}
        <div>
          <h2>{contact.displayName}</h2>
          {contact.isGroup && <p className="muted small">Grupo</p>}
          {contact.notes && <p className="muted small conv-notes">{contact.notes}</p>}
        </div>
        <div className="conv-actions">
          {needsReply && !contact.hidden && (
            <button
              type="button"
              className="btn btn-small no-reply-head"
              title="Tira a conversa de &quot;Para responder&quot; até chegar outra mensagem"
              onClick={() => setNoReplyOpen({ alertId: null })}
            >
              <NoReplyIcon />
              Não precisa responder
            </button>
          )}
          <button
            type="button"
            className="link-btn missed-link"
            title="Avise o Saga de um sinal que ele deixou passar"
            onClick={() => setMissedOpen(true)}
          >
            Faltou um alerta?
          </button>
        </div>
      </header>

      {contact.awaitingReply && decision?.needed === false && (
        <ReplyNote decision={decision} onRestore={restoreReply} onConfirm={confirmNoReply} />
      )}

      {shownAlerts.length > 0 && (
        <AlertBar
          alerts={shownAlerts}
          waitingSince={contact.waitingSince}
          canShow={(id) => !!messages?.some((m) => m.id === id)}
          onShow={showMessage}
          onDismiss={onDismissAlert}
          onRateUp={rateUp}
          onRateDown={(a) => (a.kind === 'esperando' ? setNoReplyOpen({ alertId: a.id }) : setDownFor(a))}
        />
      )}
      {toast && <Toast text={toast.text} seq={toast.seq} onDone={() => setToast(null)} />}
      {downFor && (
        <RateDownDialog
          alert={downFor}
          onClose={() => setDownFor(null)}
          onSave={(reason) => {
            const a = downFor
            setDownFor(null)
            mark(a.id, 'down')
            thank()
            window.saga.rateAlert(a.id, 'down', reason).catch(() => {
              mark(a.id, null)
              failed()
            })
          }}
        />
      )}
      {noReplyOpen && (
        <NoReplyDialog onClose={() => setNoReplyOpen(null)} onSave={(r) => saveNoReply(r, noReplyOpen.alertId)} />
      )}
      {missedOpen && (
        <MissedAlertDialog
          messages={messages ?? []}
          onClose={() => setMissedOpen(false)}
          onSave={(kind, msgId, text) => {
            setMissedOpen(false)
            thank()
            window.saga.reportMissedAlert(jid, kind, msgId, text).catch(failed)
          }}
        />
      )}

      <div className="summary-card" aria-live="polite">
        <h3>{contact.isGroup ? 'O que pedem a você' : 'O que a pessoa quer'}</h3>
        <p>{analysis && analysis.jid === jid ? analysis.summary : <span className="muted">Resumo a caminho…</span>}</p>
        {analysis && analysis.jid === jid && analysis.pendingAudios > 0 && (
          <p className="small pending-note">
            {analysis.pendingAudios === 1 ? '1 áudio ainda sendo transcrito' : `${analysis.pendingAudios} áudios ainda sendo transcritos`}
            {' '}— o resumo e as sugestões são refeitos quando a transcrição terminar.
          </p>
        )}
      </div>

      <div
        className="thread"
        ref={threadRef}
        tabIndex={0}
        aria-label="Mensagens"
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {messages === null && <p className="empty">Carregando mensagens…</p>}
        {messages?.length === 0 && <p className="empty">Nenhuma mensagem dos últimos 30 dias.</p>}
        {messages?.map((m, i) => {
          const prev = i > 0 ? messages[i - 1] : null
          const newDay = !prev || !sameDay(prev.ts, m.ts)
          // grupo: o nome aparece uma vez por sequência da mesma pessoa (de novo depois de outra pessoa ou de outro dia)
          const showSender =
            contact.isGroup && !m.fromMe && (newDay || !prev || prev.fromMe || senderKey(prev) !== senderKey(m))
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div className="day-sep">
                  <span>{formatDayHeading(m.ts)}</span>
                </div>
              )}
              <Bubble
                m={m}
                sender={showSender ? (m.senderName ?? 'Participante') : null}
                group={contact.isGroup}
                highlighted={highlight === m.id}
              />
            </Fragment>
          )
        })}
      </div>
    </section>
  )
}

const senderKey = (m: MessageView) => m.senderJid ?? m.senderName ?? ''

/** Cores escuras (contraste AA sobre branco) para o nome de quem mandou, fixas por pessoa. */
const SENDER_COLORS = ['#0b6e69', '#8a4b08', '#5b3fa0', '#a3324a', '#2d5f9a', '#3f6b1f', '#8c3a8c', '#6b5a12']

function senderColor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return SENDER_COLORS[h % SENDER_COLORS.length]
}

/** Faixa fina sob o cabeçalho: cada alerta com o detalhe, "Ver mensagem" (quando há) e "Resolver". */
function AlertBar({
  alerts,
  waitingSince,
  canShow,
  onShow,
  onDismiss,
  onRateUp,
  onRateDown
}: {
  alerts: Alert[]
  waitingSince: number | null
  canShow: (id: string) => boolean
  onShow: (id: string) => void
  onDismiss?: (kind: AlertKind) => void
  onRateUp: (a: Alert) => void
  onRateDown: (a: Alert) => void
}) {
  const now = Date.now()
  return (
    <section className="alert-bar" aria-label="Alertas desta conversa">
      <ul>
        {alerts.map((a) => {
          const label = alertChipLabel(a.kind, waitingSince, now)
          const detail = a.kind === 'esperando' ? 'Responda no WhatsApp e o alerta some sozinho.' : a.detail
          const linkable = a.msgId !== null && canShow(a.msgId)
          const body = (
            <>
              <span className={`alert-chip alert-${a.kind}`}>
                <AlertIcon kind={a.kind} />
                {label}
              </span>
              <span className="alert-detail">{detail}</span>
            </>
          )
          return (
            <li key={a.id} className="alert-item">
              {linkable ? (
                <button
                  type="button"
                  className="alert-main"
                  aria-label={`Ver mensagem: ${label} — ${detail}`}
                  title="Ver a mensagem na conversa"
                  onClick={() => onShow(a.msgId!)}
                >
                  {body}
                </button>
              ) : (
                <span className="alert-main">{body}</span>
              )}
              <span className="alert-rate" role="group" aria-label={`Avaliar o alerta ${label}`}>
                <button
                  type="button"
                  className={`rate-btn${a.rating === 'up' ? ' is-on' : ''}`}
                  aria-label="Alerta correto"
                  aria-pressed={a.rating === 'up'}
                  title={a.kind === 'esperando' ? 'Certo: precisa mesmo de resposta' : 'O alerta está certo'}
                  onClick={() => a.rating !== 'up' && onRateUp(a)}
                >
                  <span aria-hidden="true">👍</span>
                </button>
                <button
                  type="button"
                  className="rate-btn"
                  aria-label="Alerta errado"
                  title={a.kind === 'esperando' ? 'Errado: esta conversa não precisa de resposta' : 'O alerta está errado: conte o porquê'}
                  onClick={() => onRateDown(a)}
                >
                  <span aria-hidden="true">👎</span>
                </button>
              </span>
              {a.source === 'user' && <span className="alert-by-you muted small">marcado por você</span>}
              {onDismiss && (
                <button
                  type="button"
                  className="btn btn-small"
                  aria-label={`Resolver alerta ${label}`}
                  title="Tirar este alerta da lista"
                  onClick={() => onDismiss(a.kind)}
                >
                  Resolver
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Aviso discreto quando a conversa saiu de "Para responder": por quê, 👍 (o Saga acertou) e "Precisa sim". */
function ReplyNote({ decision, onRestore, onConfirm }: { decision: ReplyDecision; onRestore: () => void; onConfirm: () => void }) {
  const bySaga = decision.by !== 'user'
  return (
    <section className="reply-note" aria-label="Para responder">
      <NoReplyIcon />
      <p>
        {bySaga ? (
          <>
            O Saga acha que esta conversa não precisa de resposta{decision.reason ? ': ' : '.'}
            {decision.reason && <span className="reply-reason">{decision.reason}</span>}
          </>
        ) : (
          'Você marcou que esta conversa não precisa de resposta.'
        )}
      </p>
      {bySaga && (
        <button type="button" className="rate-btn" aria-label="O Saga acertou" title="Certo: não precisa de resposta" onClick={onConfirm}>
          <span aria-hidden="true">👍</span>
        </button>
      )}
      <button type="button" className="btn btn-small" title="Volta para &quot;Para responder&quot;" onClick={onRestore}>
        Precisa sim
      </button>
    </section>
  )
}

function Bubble({ m, sender, group, highlighted }: { m: MessageView; sender: string | null; group: boolean; highlighted?: boolean }) {
  return (
    <div
      data-msg-id={m.id}
      className={`bubble ${m.fromMe ? 'bubble-me' : 'bubble-them'}${group && !m.fromMe && !sender ? ' bubble-cont' : ''}${highlighted ? ' bubble-highlight' : ''}`}
    >
      {sender && (
        <p className="bubble-sender" style={{ color: senderColor(senderKey(m)) }}>
          {sender}
        </p>
      )}
      {group && m.mentionsMe && <p className="bubble-mention">menciona você</p>}
      {m.kind === 'audio' ? <AudioBody m={m} /> : <p className="bubble-text">{m.text ?? 'Mensagem sem texto (imagem, vídeo ou outro tipo).'}</p>}
      <time className="bubble-time">{formatTime(m.ts)}</time>
    </div>
  )
}

function AudioBody({ m }: { m: MessageView }) {
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState(false)
  const [retried, setRetried] = useState(false)
  const audio = useRef<HTMLAudioElement | null>(null)
  useEffect(
    () => () => {
      audio.current?.pause()
      audio.current = null
    },
    []
  )

  const toggle = async () => {
    setError(false)
    if (playing) {
      audio.current?.pause()
      setPlaying(false)
      return
    }
    try {
      if (!audio.current) {
        const url = await window.saga.audioUrl(m.id)
        if (!url) throw new Error('sem áudio')
        const a = new Audio(url)
        a.onended = () => setPlaying(false)
        a.onerror = () => {
          setPlaying(false)
          setError(true)
        }
        audio.current = a
      }
      await audio.current.play()
      setPlaying(true)
    } catch {
      setError(true)
    }
  }

  let body: React.ReactNode
  if (m.transcriptStatus === 'done') {
    body = m.transcript ? <p className="transcript">{m.transcript}</p> : <p className="transcript muted">Sem fala reconhecida.</p>
  } else if (m.transcriptStatus === 'unavailable') {
    body = <p className="transcript muted">Áudio indisponível</p>
  } else if (m.transcriptStatus === 'failed') {
    body = (
      <p className="transcript muted">
        Falhou —{' '}
        <button
          type="button"
          className="link-btn"
          disabled={retried}
          onClick={() => {
            setRetried(true)
            void window.saga.retryFailedJobs().catch(() => setRetried(false))
          }}
        >
          {retried ? 'tentando de novo…' : 'tentar de novo'}
        </button>
      </p>
    )
  } else {
    body = <p className="transcript muted">Transcrevendo…</p>
  }

  return (
    <div className="audio">
      <div className="audio-row">
        <button
          type="button"
          className="play"
          disabled={!m.hasAudio}
          aria-label={playing ? 'Pausar áudio' : 'Ouvir áudio'}
          title={m.hasAudio ? 'Ouvir o áudio original' : 'O áudio ainda não foi baixado'}
          onClick={() => void toggle()}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="audio-wave" aria-hidden="true" />
        <span className="muted small">{formatDuration(m.durationSec)}</span>
      </div>
      {error && <p className="field-error">Não foi possível tocar este áudio.</p>}
      {body}
    </div>
  )
}
