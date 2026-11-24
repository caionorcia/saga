import { Fragment, useEffect, useRef, useState } from 'react'
import type { Analysis, Contact, MessageView } from '../../../shared/api'
import { formatDayHeading, formatDuration, formatTime, initials, sameDay } from '../format'

interface Props {
  contact: Contact
  analysis: Analysis | null
}

export function Conversation({ contact, analysis }: Props) {
  const [messages, setMessages] = useState<MessageView[] | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [messages])

  return (
    <section className="conversation" aria-label={`Conversa com ${contact.displayName}`}>
      <header className="conv-head">
        <span className="avatar" aria-hidden="true">
          {initials(contact.displayName)}
        </span>
        <div>
          <h2>{contact.displayName}</h2>
          {contact.notes && <p className="muted small conv-notes">{contact.notes}</p>}
        </div>
      </header>

      <div className="summary-card" aria-live="polite">
        <h3>O que a pessoa quer</h3>
        <p>{analysis ? analysis.summary : <span className="muted">Resumo a caminho…</span>}</p>
      </div>

      <div className="thread" tabIndex={0} aria-label="Mensagens">
        {messages === null && <p className="empty">Carregando mensagens…</p>}
        {messages?.length === 0 && <p className="empty">Nenhuma mensagem dos últimos 30 dias.</p>}
        {messages?.map((m, i) => (
          <Fragment key={m.id}>
            {(i === 0 || !sameDay(messages[i - 1].ts, m.ts)) && (
              <div className="day-sep">
                <span>{formatDayHeading(m.ts)}</span>
              </div>
            )}
            <Bubble m={m} />
          </Fragment>
        ))}
        <div ref={endRef} />
      </div>
    </section>
  )
}

function Bubble({ m }: { m: MessageView }) {
  return (
    <div className={`bubble ${m.fromMe ? 'bubble-me' : 'bubble-them'}`}>
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
