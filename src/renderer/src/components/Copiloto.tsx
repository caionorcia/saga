import { useEffect, useState } from 'react'
import type { CopilotoStatus } from '../../../shared/copiloto'
import { COPILOTO_TEXT, isCopilotoUrl } from '../../../shared/copiloto'
import { formatDay, formatTime } from '../format'

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

  const urlDirty = url.trim() !== (st.url ?? '')
  const urlBad = url.trim() !== '' && !isCopilotoUrl(url.trim())

  return (
    <section aria-labelledby="copiloto-title" id="copiloto">
      <h2 id="copiloto-title">Copiloto da Saga</h2>
      <p className="muted small">
        Envia ao Copiloto só as conversas dos mentorados cadastrados lá (e os grupos com eles): mensagens com os áudios
        transcritos, alertas, "Para responder", resumos e respostas enviadas. Não vão chaves, mídia nem outros contatos.
      </p>
      <label className="check">
        <input type="checkbox" checked={st.enabled} onChange={(e) => void save({ enabled: e.target.checked })} />
        Enviar para o Copiloto da Saga
      </label>
      <p className="muted small">Ao desligar, a fila deste computador é apagada. O que já foi enviado fica no Copiloto.</p>
      <label className="check">
        <input type="checkbox" checked={st.autoFollowups} onChange={(e) => void save({ autoFollowups: e.target.checked })} />
        Enviar follow-ups do Copiloto automaticamente
      </label>
      <p className="muted small">
        Os follow-ups que o Copiloto marcar como automáticos saem sem a tela de confirmação, só no horário de envio e com
        as travas de sempre (30 dias, ritmo, até 30 por dia); os outros continuam esperando você.
      </p>

      <label htmlFor="copiloto-url">Endereço do Copiloto</label>
      <div className="inline-field">
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

      <div className="key-row">
        <div className="key-head">
          <strong>Código</strong>
          {st.hasCode ? <span className="ok-text">código configurado ✓</span> : <span className="muted">sem código</span>}
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
          {busy ? 'Testando…' : 'Testar conexão'}
        </button>
      </div>
      <p className={msg?.bad ? 'field-error small' : 'ok-text small'} role="status" aria-live="polite">
        {msg?.text ?? ' '}
      </p>
      {st.authFailed && <p className="field-error small">{COPILOTO_TEXT.invalidCode}. Gere outro código ou confira o secret no Copiloto.</p>}
      {st.enabled && (
        <p className="muted small" data-testid="copiloto-status">
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
  )
}
