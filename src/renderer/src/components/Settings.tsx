import { useEffect, useRef, useState } from 'react'
import { Group, Info } from './SettingsParts'
import type { AlertQuality, AppState, KeyKind, ThemePref, RecentEvent, SaveSettingsInput, SettingsView } from '../../../shared/api'
import { ALERT_LABELS, eventLabel, formatDay, formatTime, updateCheckText } from '../format'
import { DiagnosticsActions } from './Diagnostics'
import { KnowledgeBaseSection } from './KnowledgeBase'
import { BackupSection } from './Backup'
import { CopilotoSection } from './Copiloto'
import { UpdateNotice } from './UpdateNotice'
import { THEME_LABELS, setThemePref, useTheme } from '../theme'
import {
  DAY_LONG,
  DAY_SHORT,
  SCHEDULE_TIMES,
  WEEK_ORDER,
  cloneSchedule,
  localTimeZone,
  parseHHMM,
  scheduleSummary,
  type SendSchedule
} from '../../../shared/sendHours'

const THEME_PREFS: ThemePref[] = ['system', 'light', 'dark']

const KEY_LABEL: Record<KeyKind, string> = {
  groq: 'Groq',
  claude: 'Claude',
  openai: 'OpenAI',
  gemini: 'Gemini (Google, gratuito)',
  mistral: 'Mistral (gratuito)'
}
const KEY_FIELD = { groq: 'groqKey', claude: 'claudeKey', openai: 'openaiKey', gemini: 'geminiKey', mistral: 'mistralKey' } as const

/** Aviso de privacidade das reservas gratuitas (sempre visível). */
export const FREE_FALLBACK_PRIVACY =
  'No plano gratuito, o provedor pode usar as conversas enviadas para melhorar os modelos dele (Google: plano gratuito do Gemini; Mistral: o plano Experiment exige aceitar isso). Use só se concordar.'

/** Menu lateral: [id do grupo, nome]. */
const GROUPS: Array<[string, string]> = [
  ['cfg-ia', 'Inteligência artificial'],
  ['cfg-envio', 'Envio de mensagens'],
  ['copiloto', 'Copiloto da Saga'],
  ['cfg-kb', 'Base de conhecimento'],
  ['cfg-backup', 'Cópia de segurança'],
  ['cfg-app', 'Aplicativo']
]

export function Settings({ focus }: { focus?: { id: string; seq: number } | null } = {}) {
  const [s, setS] = useState<SettingsView | null>(null)
  const [events, setEvents] = useState<RecentEvent[]>([])
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null)
  const [cap, setCap] = useState('')
  const scroller = useRef<HTMLElement>(null)
  const [active, setActive] = useState(GROUPS[0][0])

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

  // aberto pela barra de status: rola até a seção pedida
  const loaded = !!s
  useEffect(() => {
    if (!focus || !loaded) return
    const el = document.getElementById(focus.id)
    el?.scrollIntoView?.({ block: 'start' })
    el?.focus?.({ preventScroll: true })
  }, [focus?.seq, loaded])

  // menu lateral: marca o grupo que está no topo da área rolável
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = () => {
      const top = el.getBoundingClientRect().top + 48
      let cur = GROUPS[0][0]
      for (const [id] of GROUPS) {
        const g = document.getElementById(id)
        if (g && g.getBoundingClientRect().top <= top) cur = id
      }
      // no fim da rolagem, o último grupo (curto) fica marcado
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) cur = GROUPS[GROUPS.length - 1][0]
      setActive(cur)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [loaded])

  const goTo = (id: string) => {
    const g = document.getElementById(id)
    g?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
    g?.focus?.({ preventScroll: true })
    setActive(id)
  }

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
    <main className="settings" ref={scroller}>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Partes das configurações">
          <h1>Configurações</h1>
          <ul>
            {GROUPS.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  aria-current={active === id ? 'true' : undefined}
                  onClick={(e) => {
                    e.preventDefault()
                    goTo(id)
                  }}
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
          <p className={`settings-saved ${msg?.bad ? 'field-error' : 'ok-text'}`} role="status" aria-live="polite">
            {msg?.text ?? ''}
          </p>
        </nav>

        <div className="settings-content">
          <Group id="cfg-ia" title="Inteligência artificial" desc="Quem escreve as sugestões, quem transcreve os áudios, as chaves e o gasto.">
            <section className="s-card" aria-labelledby="who-title">
              <h3 id="who-title">Quem faz o trabalho</h3>
              <div className="s-cols">
                <fieldset>
                  <legend>Quem escreve as sugestões</legend>
                  <Radio
                    name="provider"
                    value={s.provider}
                    options={[
                      ['groq', 'Groq (grátis)'],
                      ['claude', 'Claude (pago, por uso)']
                    ]}
                    onChange={(v) => void save({ provider: v })}
                  />
                </fieldset>
                <fieldset>
                  <legend>Transcrição dos áudios</legend>
                  <Radio
                    name="transcriber"
                    value={s.transcriber}
                    options={[
                      ['groq', 'Groq (grátis)'],
                      ['openai', 'OpenAI (pago)']
                    ]}
                    onChange={(v) => void save({ transcriber: v })}
                  />
                </fieldset>
              </div>
            </section>

            <section className="s-card" aria-labelledby="keys-title-settings">
              <h3 id="keys-title-settings">Chaves de acesso</h3>
              <p className="help">Ficam guardadas de forma protegida neste computador e nunca aparecem aqui.</p>
              <div className="key-list">
                {(['groq', 'claude', 'openai'] as const).map((k) => (
                  <KeyRow key={k} kind={k} configured={s.keys[k]} onSave={(key) => save({ [KEY_FIELD[k]]: key })} />
                ))}
              </div>
            </section>

            <section className="s-card" aria-labelledby="free-title-settings">
              <h3 id="free-title-settings">IAs gratuitas de reserva (opcional)</h3>
              <p className="help">
                Quando a Groq chega ao limite gratuito do dia, o SagaZap passa sozinho para o Gemini e depois para o Mistral, só
                enquanto for preciso. Sem chave salva, a reserva fica desligada.
              </p>
              <p className="s-note" role="note">
                {FREE_FALLBACK_PRIVACY}
              </p>
              <div className="key-list">
                {(['gemini', 'mistral'] as const).map((k) => (
                  <KeyRow key={k} kind={k} configured={s.keys[k]} onSave={(key) => save({ [KEY_FIELD[k]]: key })} />
                ))}
              </div>
            </section>

            <section className="s-card" aria-labelledby="cap-title">
              <h3 id="cap-title">Gasto</h3>
              <div className="s-row">
                <div className="s-row-text">
                  <label htmlFor="cap">Teto de gasto por dia (em dólares)</label>
                  <p className="help">Ao chegar nesse valor, o SagaZap para de usar IA paga até o dia seguinte.</p>
                </div>
                <div className="inline-field money-field">
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
              </div>
            </section>

            <AlertQualitySection />
          </Group>

          <Group id="cfg-envio" title="Envio de mensagens" desc="O botão Enviar nas sugestões e os dias e horários em que o SagaZap pode enviar.">
            <section className="s-card" aria-labelledby="send-title-settings">
              <h3 id="send-title-settings">Envio direto</h3>
              <label className="check">
                <input type="checkbox" checked={s.directSend} onChange={(e) => void save({ directSend: e.target.checked })} />
                Mostrar o botão Enviar nas sugestões
              </label>
              <div className="help check-help">
                Cada envio pede a sua confirmação.
                <Info summary="Limites de segurança">
                  O SagaZap só responde a quem mandou mensagem nos últimos 30 dias e envia no máximo uma mensagem a cada 30 a 90
                  segundos (40 por hora, 200 por dia).
                </Info>
              </div>
              <fieldset className="send-options" disabled={!s.directSend}>
                <legend className="sr-only">Como o SagaZap envia</legend>
                <label className="check">
                  <input type="checkbox" checked={s.sendTyping} onChange={(e) => void save({ sendTyping: e.target.checked })} />
                  Mostrar "digitando…" antes de enviar
                </label>
                <label className="check">
                  <input type="checkbox" checked={s.sendMarkRead} onChange={(e) => void save({ sendMarkRead: e.target.checked })} />
                  Marcar como lidas as mensagens da conversa respondida
                </label>
                <label className="check">
                  <input type="checkbox" checked={s.sendQuoteInGroups} onChange={(e) => void save({ sendQuoteInGroups: e.target.checked })} />
                  Nos grupos, citar a mensagem que está sendo respondida
                </label>
              </fieldset>
            </section>
            <SendHoursSection schedule={s.sendSchedule} disabled={!s.directSend} onSave={(v) => save({ sendSchedule: v })} />
          </Group>

          <CopilotoSection />

          <KnowledgeBaseSection />

          <BackupSection />

          <Group id="cfg-app" title="Aplicativo" desc="Aparência, início, atualizações e ajuda para o suporte.">
            <div className="s-cols s-cols-cards">
              <ThemeSection />
              <section className="s-card" aria-labelledby="startup-title">
                <h3 id="startup-title">Windows</h3>
                <label className="check">
                  <input type="checkbox" checked={s.startWithWindows} onChange={(e) => void save({ startWithWindows: e.target.checked })} />
                  Iniciar o SagaZap junto com o Windows
                </label>
              </section>
            </div>

            <UpdatesSection />

            <section className="s-card" aria-labelledby="diag-title">
              <h3 id="diag-title">Diagnóstico</h3>
              <p className="help">
                Se algo não funcionar (por exemplo, o QR Code não aparece), copie o diagnóstico e mande para o suporte. Ele traz
                só as versões e o registro de conexão: nunca as suas mensagens nem as chaves.
              </p>
              <DiagnosticsActions />
              <details className="s-more">
                <summary>Eventos recentes</summary>
                {events.length === 0 ? (
                  <p className="help">Nada para mostrar por enquanto.</p>
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
              </details>
            </section>

            <section className="s-card" aria-labelledby="pace-title">
              <h3 id="pace-title">Ritmo dos downloads</h3>
              <p className="help">
                Um áudio a cada 4 a 12 segundos, no máximo 300 por hora e 2.000 por dia. Nos primeiros 15 minutos depois de abrir o
                SagaZap ele anda na metade da velocidade. Isso protege a sua conta e não pode ser alterado.
              </p>
            </section>
          </Group>
        </div>
      </div>
    </main>
  )
}

/**
 * "Horário de envio" (v0.4.1): liga/desliga a regra e, para cada dia (Seg..Dom), se pode enviar e de que horas a que
 * horas (de 15 em 15 minutos). Salva a cada mudança; um dia com o fim antes do início não é salvo.
 */
function SendHoursSection({ schedule, disabled, onSave }: { schedule: SendSchedule; disabled: boolean; onSave: (v: SendSchedule) => Promise<boolean> }) {
  const [draft, setDraft] = useState(() => cloneSchedule(schedule))
  const saved = JSON.stringify(schedule)
  useEffect(() => setDraft(cloneSchedule(JSON.parse(saved) as SendSchedule)), [saved])
  const badDays = WEEK_ORDER.filter((i) => (parseHHMM(draft.days[i].end) ?? 0) <= (parseHHMM(draft.days[i].start) ?? 0))

  const update = (fn: (d: SendSchedule) => void) => {
    const next = cloneSchedule(draft)
    fn(next)
    setDraft(next)
    const bad = next.days.some((d) => (parseHHMM(d.end) ?? 0) <= (parseHHMM(d.start) ?? 0))
    if (!bad) void onSave(next)
  }

  const off = disabled || !draft.enabled
  return (
    <section className="s-card send-hours" id="send-hours" tabIndex={-1} aria-labelledby="send-hours-title">
      <h3 id="send-hours-title">Horário de envio</h3>
      {disabled && <p className="help">Ligue o Envio direto para usar o horário.</p>}
      <label className="check">
        <input type="checkbox" checked={draft.enabled} disabled={disabled} onChange={(e) => update((d) => (d.enabled = e.target.checked))} />
        Só enviar nos dias e horários abaixo
      </label>
      <div className="help check-help">
        Fora deles, só envia se você marcar <strong>Forçar envio</strong> na confirmação.
        <Info summary="E o que já está na fila?">
          Um envio que ainda está na fila quando o horário acaba não sai depois: fica como "Não enviada" e você decide se envia
          de novo.
        </Info>
      </div>
      <table className="hours-table" aria-label="Dias e horários de envio">
        <tbody>
          {WEEK_ORDER.map((i) => {
            const day = draft.days[i]
            const bad = badDays.includes(i)
            return (
              <tr key={i} className={`${day.on ? '' : 'hours-off'}${bad ? ' hours-bad' : ''}`}>
                <th scope="row">
                  <label className="check">
                    <input type="checkbox" checked={day.on} disabled={off} onChange={(e) => update((d) => (d.days[i].on = e.target.checked))} />
                    <span className="hours-day">{DAY_SHORT[i]}</span>
                  </label>
                </th>
                <td>
                  <select
                    aria-label={`Início de ${DAY_LONG[i]}`}
                    value={day.start}
                    disabled={off || !day.on}
                    onChange={(e) => update((d) => (d.days[i].start = e.target.value))}
                  >
                    {SCHEDULE_TIMES.filter((t) => t !== '24:00').map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="hours-sep" aria-hidden="true">
                  às
                </td>
                <td>
                  <select
                    aria-label={`Fim de ${DAY_LONG[i]}`}
                    aria-invalid={bad || undefined}
                    value={day.end}
                    disabled={off || !day.on}
                    onChange={(e) => update((d) => (d.days[i].end = e.target.value))}
                  >
                    {SCHEDULE_TIMES.filter((t) => t !== '00:00').map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="hours-note">{!day.on ? <span className="muted small">sem envio</span> : null}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {badDays.length > 0 && (
        <p className="field-error" role="alert">
          O fim precisa ser depois do início ({badDays.map((i) => DAY_SHORT[i]).join(', ')}). Esse horário ainda não foi salvo.
        </p>
      )}
      <p className="help">
        {draft.enabled ? `Agora: ${scheduleSummary(draft)}. ` : 'Desligado: o SagaZap pode enviar a qualquer hora. '}
        Vale o relógio deste computador (fuso {localTimeZone()}).
      </p>
    </section>
  )
}

/** "Tema": Automático (segue o Windows), Claro ou Escuro; muda na hora e fica salvo. */
function ThemeSection() {
  const { pref } = useTheme()
  return (
    <section className="s-card" aria-labelledby="theme-title">
      <h3 id="theme-title">Tema</h3>
      <Radio
        name="theme"
        value={pref}
        options={THEME_PREFS.map((t) => [t, THEME_LABELS[t]] as [ThemePref, string])}
        onChange={(v) => void setThemePref(v)}
      />
      <p className="help">Também dá para trocar pelo botão de sol/lua na barra de cima.</p>
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
    <section className="s-card" aria-labelledby="updates-title">
      <h3 id="updates-title">Atualizações</h3>
      <div className="s-row">
        <div className="s-row-text">
          <p>
            Versão instalada: <strong>{c.currentVersion || '—'}</strong>
          </p>
          <p className="help" role="status" aria-live="polite">
            {checking ? 'Procurando uma versão nova…' : failed ? 'Não foi possível verificar agora. Tente de novo.' : updateCheckText(c, st.update)}
          </p>
        </div>
        <button type="button" className="btn" disabled={checking || !c.enabled} onClick={() => void checkNow()}>
          {checking ? 'Verificando…' : 'Verificar agora'}
        </button>
      </div>
      {st.update.status !== 'none' && (
        <p className="update-row">
          <UpdateNotice update={st.update} />
        </p>
      )}
      <Info summary="Como funciona">
        O SagaZap procura sozinho a cada hora e quando você abre a janela. Se preferir, baixe a versão nova em{' '}
        <a href="https://github.com/caionorcia/saga/releases/latest" target="_blank" rel="noreferrer">
          github.com/caionorcia/saga/releases
        </a>{' '}
        e instale por cima: suas conversas e configurações são mantidas.
      </Info>
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
    <section className="s-card" aria-labelledby="quality-title">
      <h3 id="quality-title">Qualidade dos alertas</h3>
      <p className="help">
        Suas avaliações (👍 e 👎 nos alertas, "Faltou um alerta?" e "Não precisa responder") dos últimos {q?.days ?? 30} dias.
        O SagaZap usa os exemplos para errar menos.
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
              <th scope="col" title="Conversas que o SagaZap tirou e você devolveu com &quot;Precisa sim&quot;">Devolvidos</th>
              <th scope="col" title="Decisões do SagaZap que você confirmou com 👍">Confirmados</th>
              <th scope="col">% de acerto do SagaZap</th>
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
      {q && total === 0 && <p className="help">Nenhuma avaliação ainda. Use 👍 e 👎 na faixa de alertas da conversa.</p>}
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
        <strong className="key-name">{KEY_LABEL[kind]}</strong>
        {configured ? <span className="pill pill-ok">configurada ✓</span> : <span className="pill pill-neutral">não configurada</span>}
        <span className="key-actions">
        {!editing && (
          <button type="button" className="btn btn-small" onClick={() => setEditing(true)}>
            {configured ? 'Trocar' : 'Adicionar'}
          </button>
        )}
        {configured && !editing && !confirming && (
          <button type="button" className="btn btn-small btn-quiet-danger" onClick={() => setConfirming(true)}>
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
        </span>
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
