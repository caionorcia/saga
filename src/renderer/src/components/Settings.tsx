import { useEffect, useState } from 'react'
import type { KeyKind, RecentEvent, SaveSettingsInput, SettingsView } from '../../../shared/api'
import { eventLabel, formatDay, formatTime } from '../format'

const KEY_LABEL: Record<KeyKind, string> = { groq: 'Groq', claude: 'Claude', openai: 'OpenAI' }
const KEY_FIELD = { groq: 'groqKey', claude: 'claudeKey', openai: 'openaiKey' } as const

export function Settings() {
  const [s, setS] = useState<SettingsView | null>(null)
  const [events, setEvents] = useState<RecentEvent[]>([])
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null)
  const [cap, setCap] = useState('')

  useEffect(() => {
    let alive = true
    window.saga
      .getSettings()
      .then((v) => {
        if (!alive) return
        setS(v)
        setCap(v.dailyCapUsd.toFixed(2).replace('.', ','))
      })
      .catch(() => alive && setMsg({ text: 'Não foi possível carregar as configurações.', bad: true }))
    window.saga
      .recentEvents(20)
      .then((e) => alive && setEvents(e))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const save = async (patch: SaveSettingsInput) => {
    setMsg(null)
    try {
      const r = await window.saga.saveSettings(patch)
      if (r.ok) {
        setS(r.settings)
        setMsg({ text: 'Salvo ✓', bad: false })
      } else setMsg({ text: r.message, bad: true })
      return r.ok
    } catch {
      setMsg({ text: 'Não foi possível salvar. Tente de novo.', bad: true })
      return false
    }
  }

  const saveCap = () => {
    const v = Number(cap.replace(',', '.'))
    if (!Number.isFinite(v) || v < 0) {
      setMsg({ text: 'Digite um valor em dólares, por exemplo 1,00.', bad: true })
      return
    }
    if (s && v !== s.dailyCapUsd) void save({ dailyCapUsd: v })
  }

  if (!s) {
    return (
      <main className="settings">
        <p className="empty" role={msg?.bad ? 'alert' : 'status'}>{msg?.text ?? 'Carregando…'}</p>
      </main>
    )
  }

  return (
    <main className="settings">
      <div className="settings-inner">
        <h1>Configurações</h1>
        <p className={msg?.bad ? 'field-error' : 'ok-text'} role="status" aria-live="polite">
          {msg?.text ?? ' '}
        </p>

        <section>
          <h2>Chaves de acesso</h2>
          <p className="muted small">As chaves ficam guardadas de forma protegida no seu computador e nunca aparecem aqui.</p>
          {(['groq', 'claude', 'openai'] as const).map((k) => (
            <KeyRow key={k} kind={k} configured={s.keys[k]} onSave={(key) => save({ [KEY_FIELD[k]]: key })} />
          ))}
        </section>

        <section>
          <h2>Quem escreve as sugestões</h2>
          <Radio
            name="provider"
            value={s.provider}
            options={[
              ['groq', 'Groq (grátis)'],
              ['claude', 'Claude (pago, por uso)']
            ]}
            onChange={(v) => void save({ provider: v })}
          />
        </section>

        <section>
          <h2>Transcrição dos áudios</h2>
          <Radio
            name="transcriber"
            value={s.transcriber}
            options={[
              ['groq', 'Groq (grátis)'],
              ['openai', 'OpenAI (pago)']
            ]}
            onChange={(v) => void save({ transcriber: v })}
          />
        </section>

        <section>
          <h2>Gasto</h2>
          <label htmlFor="cap">Teto de gasto por dia (em dólares)</label>
          <div className="inline-field">
            <span aria-hidden="true">US$</span>
            <input
              id="cap"
              inputMode="decimal"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              onBlur={saveCap}
              onKeyDown={(e) => e.key === 'Enter' && saveCap()}
            />
          </div>
          <p className="muted small">Ao chegar nesse valor, o Saga para de usar IA paga até o dia seguinte.</p>
        </section>

        <section>
          <h2>Windows</h2>
          <label className="check">
            <input type="checkbox" checked={s.startWithWindows} onChange={(e) => void save({ startWithWindows: e.target.checked })} />
            Iniciar o Saga junto com o Windows
          </label>
        </section>

        <section>
          <h2>Ritmo dos downloads</h2>
          <p>
            Um áudio a cada 4 a 12 segundos, no máximo 300 por hora e 2.000 por dia. Nos primeiros 15 minutos depois de abrir o
            Saga ele anda na metade da velocidade. Isso protege a sua conta e não pode ser alterado.
          </p>
        </section>

        <section>
          <h2>Eventos recentes</h2>
          {events.length === 0 ? (
            <p className="muted">Nada para mostrar por enquanto.</p>
          ) : (
            <ul className="events">
              {events.map((e) => (
                <li key={e.id}>
                  <time>
                    {formatDay(e.ts)}, {formatTime(e.ts)}
                  </time>
                  <span>
                    {eventLabel(e.kind)}
                    {e.detail && (
                      <details>
                        <summary>detalhes</summary>
                        <code>{e.detail}</code>
                      </details>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  )
}

function Radio<T extends string>({
  name,
  value,
  options,
  onChange
}: {
  name: string
  value: T
  options: Array<[T, string]>
  onChange: (v: T) => void
}) {
  return (
    <div role="radiogroup" className="radios">
      {options.map(([v, label]) => (
        <label key={v} className="check">
          <input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} />
          {label}
        </label>
      ))}
    </div>
  )
}

function KeyRow({ kind, configured, onSave }: { kind: KeyKind; configured: boolean; onSave: (key: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [test, setTest] = useState<'idle' | 'testing' | 'ok' | 'bad'>('idle')
  const id = `cfg-key-${kind}`

  const close = () => {
    setEditing(false)
    setValue('')
    setTest('idle')
  }

  return (
    <div className="key-row">
      <div className="key-head">
        <strong>{KEY_LABEL[kind]}</strong>
        {configured ? <span className="ok-text">configurada ✓</span> : <span className="muted">não configurada</span>}
        {!editing && (
          <button type="button" className="btn btn-small" onClick={() => setEditing(true)}>
            {configured ? 'Trocar' : 'Adicionar'}
          </button>
        )}
        {configured && !editing && !confirming && (
          <button type="button" className="btn btn-small" onClick={() => setConfirming(true)}>
            Remover
          </button>
        )}
        {confirming && (
          <span className="confirm">
            Remover a chave do {KEY_LABEL[kind]}?
            <button
              type="button"
              className="btn btn-small btn-danger"
              onClick={() => {
                setConfirming(false)
                void onSave('')
              }}
            >
              Sim, remover
            </button>
            <button type="button" className="btn btn-small" onClick={() => setConfirming(false)}>
              Cancelar
            </button>
          </span>
        )}
      </div>
      {editing && (
        <div className="key-edit">
          <label htmlFor={id}>Nova chave do {KEY_LABEL[kind]}</label>
          <input id={id} type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => { setValue(e.target.value); setTest('idle') }} />
          <div className="test-row">
            <button
              type="button"
              className="btn"
              disabled={!value.trim() || test === 'testing'}
              onClick={async () => {
                setTest('testing')
                try {
                  setTest((await window.saga.testKey(kind, value.trim())) ? 'ok' : 'bad')
                } catch {
                  setTest('bad')
                }
              }}
            >
              {test === 'testing' ? 'Testando…' : 'Testar'}
            </button>
            {test === 'ok' && <span className="ok-text">Funcionando ✓</span>}
            {test === 'bad' && <span className="field-error">Essa chave não funcionou.</span>}
            <button
              type="button"
              className="btn btn-primary"
              disabled={!value.trim()}
              onClick={async () => {
                if (await onSave(value.trim())) close()
              }}
            >
              Salvar
            </button>
            <button type="button" className="btn" onClick={close}>
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
