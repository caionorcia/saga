import { useEffect, useState } from 'react'
import type { CopilotoStatus } from '../../../shared/copiloto'
import { COPILOTO_TEXT, groupHistoryLine, groupRepairLine, historyFetchLine, isCopilotoUrl, noAnchorLine } from '../../../shared/copiloto'
import { formatDay, formatTime } from '../format'
import { Group, Info } from './SettingsParts'

const when = (ts: number) => `${formatDay(ts)}, ${formatTime(ts)}`
const POLL_MS = 5_000

/**
 * "Copiloto da Saga" (v0.5.0): liga/desliga o envio ao Copiloto, o endereço, o código (aparece uma vez só) e o teste.
 * O código nunca volta para cá depois de gerado: a tela só sabe se ele está configurado.
 */
export function CopilotoSection() {
  const [st, setSt] = useState<CopilotoStatus | null>(null)
  const [url, setUrl] = useState('')
  const [code, setCode] = useState<string | null>(null)
  const [confirmNew, setConfirmNew] = useState(false)
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const load = (first: boolean) =>
      window.saga
        .copilotoStatus()
        .then((s) => {
          if (!alive) return
          setSt(s)
          if (first) setUrl(s.url ?? '')
        })
        .catch(() => {})
    void load(true)
    const t = setInterval(() => void load(false), POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  if (!st) return null

  const save = async (patch: { enabled?: boolean; url?: string; autoFollowups?: boolean }) => {
    setMsg(null)
    try {
      const r = await window.saga.copilotoSave(patch)
      if (r.ok) {
        setSt(r.status)
        setMsg({ text: 'Salvo ✓', bad: false })
      } else setMsg({ text: r.message, bad: true })
    } catch {
      setMsg({ text: 'Não foi possível salvar. Tente de novo.', bad: true })
    }
  }

  const gen = async () => {
    setConfirmNew(false)
    setMsg(null)
    try {
      const r = await window.saga.copilotoGenerateCode()
      if (r.ok) {
        setCode(r.code)
        setSt(await window.saga.copilotoStatus())
      } else setMsg({ text: r.message, bad: true })
    } catch {
      setMsg({ text: 'Não foi possível gerar o código. Tente de novo.', bad: true })
    }
  }

  const test = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.saga.copilotoTest()
      setMsg(
        r.ok
          ? { text: `Conexão ok: ${r.phones} telefone(s) de mentorados no Copiloto; ${r.chats} conversa(s) neste computador.`, bad: false }
          : { text: r.message, bad: true }
      )
      setSt(await window.saga.copilotoStatus())
    } catch {
      setMsg({ text: COPILOTO_TEXT.network, bad: true })
    } finally {
      setBusy(false)
    }
  }

  // v0.8.1: reenvio do histórico dos grupos (e os nomes dos grupos de novo)
  const repair = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.saga.copilotoRepairGroups()
      if (r.ok) {
        setSt(r.status)
        setMsg({
          text: r.status.groupRepairPending ? 'Pedido feito: o reenvio começa assim que a lista de mentorados chegar.' : 'Histórico dos grupos colocado na fila ✓',
          bad: false
        })
      } else setMsg({ text: r.message, bad: true })
    } catch {
      setMsg({ text: 'Não foi possível reenviar. Tente de novo.', bad: true })
    } finally {
      setBusy(false)
    }
  }

  // v0.8.3: pede ao celular, aos poucos, o histórico dos grupos dos mentorados (só leitura)
  const fetchHistory = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.saga.copilotoFetchGroupHistory()
      if (r.ok) {
        setSt(r.status)
        setMsg({ text: 'Busca no celular começou. Deixe o celular ligado e com internet ✓', bad: false })
      } else setMsg({ text: r.message, bad: true })
    } catch {
      setMsg({ text: 'Não foi possível começar a busca. Tente de novo.', bad: true })
    } finally {
      setBusy(false)
    }
  }
  const fetching = st.historyFetch?.state === 'running'

  const urlDirty = url.trim() !== (st.url ?? '')
  const urlBad = url.trim() !== '' && !isCopilotoUrl(url.trim())

  return (
    <Group
      id="copiloto"
      title="Copiloto da Saga"
      desc="Envia ao Copiloto só as conversas dos mentorados cadastrados lá (e os grupos com eles)."
      extra={
        <Info summary="O que vai e o que não vai">
          Vão as mensagens com os áudios transcritos, alertas, "Para responder", resumos e respostas enviadas. Não vão chaves,
          mídia nem outros contatos.
        </Info>
      }
    >
      <section className="s-card" aria-labelledby="copiloto-send-title">
        <h3 id="copiloto-send-title">Envio ao Copiloto</h3>
        <label className="check">
          <input type="checkbox" checked={st.enabled} onChange={(e) => void save({ enabled: e.target.checked })} />
          Enviar para o Copiloto da Saga
        </label>
        <p className="help check-help">Ao desligar, a fila deste computador é apagada. O que já foi enviado fica no Copiloto.</p>
        <label className="check">
          <input type="checkbox" checked={st.autoFollowups} onChange={(e) => void save({ autoFollowups: e.target.checked })} />
          Enviar follow-ups do Copiloto automaticamente
        </label>
        <p className="help check-help">
          Os follow-ups que o Copiloto marcar como automáticos saem sem a tela de confirmação, só no horário de envio e com
          as travas de sempre (30 dias, ritmo, até 30 por dia); os outros continuam esperando você.
        </p>
      </section>

      <section className="s-card" aria-labelledby="copiloto-conn-title">
        <h3 id="copiloto-conn-title">Conexão</h3>
        <label htmlFor="copiloto-url">Endereço do Copiloto</label>
        <div className="inline-field url-field">
          <input
            id="copiloto-url"
            type="url"
            spellCheck={false}
            autoComplete="off"
            placeholder="https://…/functions/v1/sagazap-webhook"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button type="button" className="btn" disabled={!urlDirty || urlBad} onClick={() => void save({ url: url.trim() })}>
            Salvar endereço
          </button>
        </div>
        {urlBad && <p className="field-error small">{COPILOTO_TEXT.invalidUrl}</p>}

        <div className="key-row key-row-boxed">
          <div className="key-head">
            <strong className="key-name">Código</strong>
            {st.hasCode ? <span className="pill pill-ok">código configurado ✓</span> : <span className="pill pill-neutral">sem código</span>}
            <span className="key-actions">
              {!st.hasCode && (
                <button type="button" className="btn btn-small" onClick={() => void gen()}>
                  Gerar código
                </button>
              )}
              {st.hasCode && !confirmNew && (
                <button type="button" className="btn btn-small" onClick={() => setConfirmNew(true)}>
                  Gerar outro código
                </button>
              )}
              {confirmNew && (
                <span className="confirm">
                  O código atual para de funcionar.
                  <button type="button" className="btn btn-small btn-danger" onClick={() => void gen()}>
                    Gerar outro
                  </button>
                  <button type="button" className="btn btn-small" onClick={() => setConfirmNew(false)}>
                    Cancelar
                  </button>
                </span>
              )}
            </span>
          </div>
          {code && (
            <div className="key-edit">
              <p className="small">
                Cole este código no Lovable Cloud como o secret <code>SAGAZAP_WEBHOOK_SECRET</code>. Ele aparece só agora.
              </p>
              <div className="test-row">
                <code className="copiloto-code" aria-label="Código do Copiloto">
                  {code}
                </code>
                <button type="button" className="btn" onClick={() => void window.saga.copyToClipboard(code)}>
                  Copiar
                </button>
                <button type="button" className="btn" onClick={() => setCode(null)}>
                  Pronto
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="export-row">
          <button type="button" className="btn" disabled={busy || !st.url || !st.hasCode} onClick={() => void test()}>
            {busy ? 'Aguarde…' : 'Testar conexão'}
          </button>
          {st.enabled && (
            <button type="button" className="btn" disabled={busy} onClick={() => void repair()}>
              Reenviar histórico dos grupos
            </button>
          )}
          {st.enabled && (
            <button type="button" className="btn" disabled={busy || fetching} onClick={() => void fetchHistory()}>
              Buscar no celular o histórico completo dos mentorados
            </button>
          )}
        </div>
        {st.enabled && (
          <Info summary="O que faz o reenvio?">
            Põe de novo na fila os últimos 30 dias dos grupos dos mentorados e pede os nomes dos grupos ao WhatsApp. Nada é
            duplicado no Copiloto.
          </Info>
        )}
        {st.enabled && (
          <Info summary="E a busca no celular?">
            Para as conversas e os grupos dos mentorados que já têm alguma mensagem aqui, o SagaZap pede ao seu celular as
            mensagens anteriores, até o celular não ter mais: um pedido a cada 20 segundos, no máximo 60 por dia, só com o
            WhatsApp conectado. O celular precisa estar ligado e com internet. Nada é enviado a ninguém. O histórico antigo
            fica só neste computador (o Copiloto recebe só os últimos 30 dias e pode pesquisar o resto). Vincular o aparelho
            de novo é o caminho mais rápido (veja o guia).
          </Info>
        )}
        <p className={`s-msg ${msg?.bad ? 'field-error small' : 'ok-text small'}`} role="status" aria-live="polite">
          {msg?.text ?? ' '}
        </p>
        {st.authFailed && <p className="field-error small">{COPILOTO_TEXT.invalidCode}. Gere outro código ou confira o secret no Copiloto.</p>}
        {st.enabled && (
          <p className="status-line" data-testid="copiloto-status">
            <span data-testid="copiloto-group-history">{groupHistoryLine(st.groupHistory)}</span>
            <br />
            {st.historyFetch && (
              <>
                <span data-testid="copiloto-history-fetch">{historyFetchLine(st.historyFetch)}</span>
                <br />
                {st.historyFetch.noAnchor > 0 && (
                  <>
                    <span data-testid="copiloto-history-no-anchor">{noAnchorLine(st.historyFetch.noAnchor)}</span>
                    <br />
                  </>
                )}
              </>
            )}
            {st.groupRepair && (
              <>
                <span data-testid="copiloto-group-repair">{groupRepairLine(st.groupRepair)}</span>
                <br />
              </>
            )}
            Pendentes: {st.pending} · Último envio: {st.lastSentAt ? when(st.lastSentAt) : 'ainda não'}
            {st.lastError && !st.authFailed && (
              <>
                {' '}
                · Último erro: {st.lastError}
                {st.lastErrorAt ? ` (${when(st.lastErrorAt)})` : ''}
              </>
            )}
          </p>
        )}
      </section>
    </Group>
  )
}
