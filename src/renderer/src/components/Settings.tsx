import { useEffect, useState } from 'react'
import type { AlertQuality, AppState, KeyKind, ThemePref, RecentEvent, SaveSettingsInput, SettingsView } from '../../../shared/api'
import { ALERT_LABELS, eventLabel, formatDay, formatTime, updateCheckText } from '../format'
import { DiagnosticsActions } from './Diagnostics'
import { KnowledgeBaseSection } from './KnowledgeBase'
import { BackupSection } from './Backup'
import { UpdateNotice } from './UpdateNotice'
import { THEME_LABELS, setThemePref, useTheme } from '../theme'

const THEME_PREFS: ThemePref[] = ['system', 'light', 'dark']

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

        <KnowledgeBaseSection />

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

        <BackupSection />

        <ThemeSection />

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

        <UpdatesSection />

        <AlertQualitySection />

        <section>
          <h2>Diagnóstico</h2>
          <p className="muted small">
            Se algo não funcionar (por exemplo, o QR Code não aparece), copie o diagnóstico e mande para o suporte. Ele traz
            só as versões e o registro de conexão: nunca as suas mensagens nem as chaves.
          </p>
          <DiagnosticsActions />
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

/** "Tema": Automático (segue o Windows), Claro ou Escuro; muda na hora e fica salvo. */
function ThemeSection() {
  const { pref } = useTheme()
  return (
    <section>
      <h2>Tema</h2>
      <Radio
        name="theme"
        value={pref}
        options={THEME_PREFS.map((t) => [t, THEME_LABELS[t]] as [ThemePref, string])}
        onChange={(v) => void setThemePref(v)}
      />
      <p className="muted small">Também dá para trocar pelo botão de sol/lua na barra de cima.</p>
    </section>
  )
}

/** "Atualizações": versão instalada, a última procura e "Verificar agora". */
function UpdatesSection() {
  const [st, setSt] = useState<Pick<AppState, 'update' | 'updateCheck'> | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    const off = window.saga.onState((s) => alive && setSt({ update: s.update, updateCheck: s.updateCheck }))
    window.saga
      .getState()
      .then((s) => alive && setSt((old) => old ?? { update: s.update, updateCheck: s.updateCheck }))
      .catch(() => {})
    return () => {
      alive = false
      off()
    }
  }, [])

  const checkNow = async () => {
    setBusy(true)
    setFailed(false)
    try {
      const c = await window.saga.checkForUpdates()
      setSt((old) => (old ? { ...old, updateCheck: c } : old))
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  if (!st) return null
  const c = st.updateCheck
  const checking = busy || c.checking
  return (
    <section aria-labelledby="updates-title">
      <h2 id="updates-title">Atualizações</h2>
      <p>
        Versão instalada: <strong>{c.currentVersion || '—'}</strong>
      </p>
      <p className="muted small" role="status" aria-live="polite">
        {checking ? 'Procurando uma versão nova…' : failed ? 'Não foi possível verificar agora. Tente de novo.' : updateCheckText(c, st.update)}
      </p>
      {st.update.status !== 'none' && (
        <p className="update-row">
          <UpdateNotice update={st.update} />
        </p>
      )}
      <div className="export-row">
        <button type="button" className="btn" disabled={checking || !c.enabled} onClick={() => void checkNow()}>
          {checking ? 'Verificando…' : 'Verificar agora'}
        </button>
      </div>
      <p className="muted small">
        O Saga procura sozinho a cada hora e quando você abre a janela. Se preferir, baixe a versão nova em{' '}
        <a href="https://github.com/caionorcia/saga/releases/latest" target="_blank" rel="noreferrer">
          github.com/caionorcia/saga/releases
        </a>{' '}
        e instale por cima: suas conversas e configurações são mantidas.
      </p>
    </section>
  )
}

const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)}%`)

/** "Qualidade dos alertas": quanto os alertas da IA acertam (👍/👎 do mentor) e a exportação em CSV. */
function AlertQualitySection() {
  const [q, setQ] = useState<AlertQuality | null>(null)
  const [anon, setAnon] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null)

  useEffect(() => {
    let alive = true
    window.saga
      .alertQuality()
      .then((v) => alive && setQ(v))
      .catch(() => alive && setMsg({ text: 'Não foi possível carregar as avaliações.', bad: true }))
    return () => {
      alive = false
    }
  }, [])

  const total = q ? q.kinds.reduce((n, k) => n + k.up + k.down + k.missed, 0) + q.reply.removed + q.reply.restored + q.reply.confirmed : 0
  const exportCsv = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.saga.exportAlertFeedback({ anonymize: anon })
      if (r.status === 'saved') setMsg({ text: `Arquivo salvo com ${r.rows === 1 ? '1 avaliação' : `${r.rows} avaliações`} ✓`, bad: false })
      else if (r.status === 'empty') setMsg({ text: 'Ainda não há avaliações para exportar.', bad: false })
    } catch {
      setMsg({ text: 'Não foi possível salvar o arquivo. Tente de novo.', bad: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="quality-title">
      <h2 id="quality-title">Qualidade dos alertas</h2>
      <p className="muted small">
        Suas avaliações (👍 e 👎 nos alertas, "Faltou um alerta?" e "Não precisa responder") dos últimos {q?.days ?? 30} dias.
        O Saga usa os exemplos para errar menos.
      </p>
      {q && (
        <table className="quality-table">
          <thead>
            <tr>
              <th scope="col">Tipo</th>
              <th scope="col">👍 Certos</th>
              <th scope="col">👎 Errados</th>
              <th scope="col">Faltou</th>
              <th scope="col">% de acerto</th>
            </tr>
          </thead>
          <tbody>
            {q.kinds.map((k) => (
              <tr key={k.kind}>
                <th scope="row">{ALERT_LABELS[k.kind]}</th>
                <td>{k.up}</td>
                <td>{k.down}</td>
                <td>{k.missed}</td>
                <td>{pct(k.correctRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {q && (
        <table className="quality-table quality-reply">
          <thead>
            <tr>
              <th scope="col">Lista</th>
              <th scope="col" title="Conversas que você tirou com &quot;Não precisa responder&quot;">Removidos por você</th>
              <th scope="col" title="Conversas que o Saga tirou e você devolveu com &quot;Precisa sim&quot;">Devolvidos</th>
              <th scope="col" title="Decisões do Saga que você confirmou com 👍">Confirmados</th>
              <th scope="col">% de acerto do Saga</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Para responder</th>
              <td>{q.reply.removed}</td>
              <td>{q.reply.restored}</td>
              <td>{q.reply.confirmed}</td>
              <td>{pct(q.reply.correctRate)}</td>
            </tr>
          </tbody>
        </table>
      )}
      {q && total === 0 && <p className="muted small">Nenhuma avaliação ainda. Use 👍 e 👎 na faixa de alertas da conversa.</p>}
      <div className="export-row">
        <button type="button" className="btn" disabled={busy} onClick={() => void exportCsv()}>
          {busy ? 'Exportando…' : 'Exportar avaliações (CSV)'}
        </button>
        <label className="check">
          <input type="checkbox" checked={anon} onChange={(e) => setAnon(e.target.checked)} />
          Anonimizar nomes
        </label>
      </div>
      <p className="notice export-warn">
        <strong>Atenção:</strong> o arquivo traz trechos das mensagens das conversas. Guarde e compartilhe com cuidado. "Anonimizar nomes"
        troca o nome da conversa por "Contato 1", "Contato 2"…, mas nomes citados dentro das mensagens continuam lá.
      </p>
      {msg && (
        <p className={msg.bad ? 'field-error' : 'ok-text'} role="status">
          {msg.text}
        </p>
      )}
    </section>
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
