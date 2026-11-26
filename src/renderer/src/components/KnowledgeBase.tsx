import { useCallback, useEffect, useRef, useState } from 'react'
import { KB_LIMITS, KB_ROLES, KB_ROLE_LABELS, type KbImportResult, type KbPackageView, type KbRole } from '../../../shared/kb'
import { formatDay } from '../format'

const ROLE_HELP: Record<KbRole, string> = {
  regras: 'um resumo curto vai em toda sugestão',
  conhecimento: 'trechos buscados quando a conversa pede; aparecem em "Baseado em"',
  interno: 'a IA usa só para entender o método e o tom; nunca cita nomes, preços nem trechos',
  desligado: 'não é usado'
}

/** "1,2 KB" */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toLocaleString('pt-BR', { maximumFractionDigits: kb < 10 ? 1 : 0 })} KB`
  return `${(kb / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`
}

function resultText(r: KbImportResult): { text: string; bad: boolean } | null {
  if (r.status === 'canceled') return null
  if (r.status === 'error') return { text: r.message, bad: true }
  const parts = [`${r.files === 1 ? '1 arquivo' : `${r.files} arquivos`}, ${r.sections === 1 ? '1 seção' : `${r.sections} seções`}`]
  if (r.duplicates) parts.push(`${r.duplicates} repetido${r.duplicates === 1 ? '' : 's'} entrou${r.duplicates === 1 ? '' : 'aram'} uma vez só`)
  if (r.skipped) parts.push(`${r.skipped} ignorado${r.skipped === 1 ? '' : 's'} (não são texto ou são grandes demais)`)
  return { text: `${r.replaced ? 'Atualizado' : 'Importado'}: ${r.packageName} — ${parts.join('; ')} ✓`, bad: false }
}

/** Configurações › "Base de conhecimento": importar pacotes, ver os arquivos e escolher o papel de cada um. */
export function KnowledgeBaseSection() {
  const [pkgs, setPkgs] = useState<KbPackageView[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null)
  const [pasting, setPasting] = useState(false)
  const [removing, setRemoving] = useState<number | null>(null)

  const reload = useCallback(async () => {
    try {
      setPkgs(await window.saga.kbList())
    } catch {
      setMsg({ text: 'Não foi possível carregar a base de conhecimento.', bad: true })
      setPkgs((p) => p ?? [])
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const run = async (fn: () => Promise<KbImportResult>) => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await fn()
      setMsg(resultText(r))
      if (r.status === 'imported') await reload()
      return r
    } catch {
      setMsg({ text: 'Não foi possível importar. Tente de novo.', bad: true })
      return null
    } finally {
      setBusy(false)
    }
  }

  const change = async (fn: () => Promise<void>) => {
    setMsg(null)
    try {
      await fn()
    } catch {
      setMsg({ text: 'Não foi possível salvar. Tente de novo.', bad: true })
    }
    await reload()
  }

  return (
    <section aria-labelledby="kb-title" className="kb-section">
      <h2 id="kb-title">Base de conhecimento</h2>
      <p className="muted small">
        Importe o material do seu método (um pacote .zip, uma skill .skill, uma pasta ou arquivos .md, .txt e .docx). O Saga usa as regras em
        toda sugestão e busca os trechos que ajudam a responder cada mensagem. Fica tudo só neste computador.
      </p>
      <p className="notice kb-warn" role="note">
        <strong>Atenção:</strong> quando a base é usada, trechos dela vão junto com a conversa para a IA que escreve as sugestões (Groq ou
        Claude). Marque como "Interno" o que tem nomes, preços ou falas de outras pessoas, e como "Desligado" o que não deve ser usado.
      </p>
      <div className="kb-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => window.saga.kbImport('archive'))}>
          Importar pacote / skill
        </button>
        <button type="button" className="link-btn" disabled={busy} onClick={() => void run(() => window.saga.kbImport('folder'))}>
          ou uma pasta
        </button>
        <span className="kb-actions-sep" aria-hidden="true" />
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void run(() => window.saga.kbAddFile())}>
          Adicionar arquivo
        </button>
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setPasting(true)}>
          Colar texto
        </button>
      </div>
      <p className={msg?.bad ? 'field-error' : 'ok-text small'} role="status" aria-live="polite">
        {busy ? 'Importando…' : (msg?.text ?? '')}
      </p>

      {pkgs !== null && pkgs.length === 0 && <p className="muted small">Nenhum material importado ainda. Sem base, as sugestões seguem só o seu estilo.</p>}

      {pkgs?.map((p) => {
        const active = p.files.filter((f) => f.enabled && f.role !== 'desligado').length
        return (
          <div key={p.id} className={`kb-package${p.enabled ? '' : ' is-off'}`}>
            <div className="kb-package-head">
              <div className="kb-package-title">
                <strong>{p.name}</strong>
                <span className="muted small">
                  {p.files.length === 1 ? '1 arquivo' : `${p.files.length} arquivos`} ({active} em uso) · {p.kind === 'manual' ? 'atualizado' : 'importado'} em{' '}
                  {formatDay(p.importedAt)}
                  {p.duplicates > 0 && ` · ${p.duplicates} repetido${p.duplicates === 1 ? '' : 's'}`}
                  {p.skipped > 0 && ` · ${p.skipped} ignorado${p.skipped === 1 ? '' : 's'}`}
                </span>
              </div>
              <label className="check kb-switch">
                <input type="checkbox" checked={p.enabled} onChange={(e) => void change(() => window.saga.kbSetPackageEnabled(p.id, e.target.checked))} />
                Usar
              </label>
              {removing === p.id ? (
                <span className="confirm">
                  Remover?
                  <button
                    type="button"
                    className="btn btn-small btn-danger"
                    onClick={() => {
                      setRemoving(null)
                      void change(() => window.saga.kbRemovePackage(p.id))
                    }}
                  >
                    Sim, remover
                  </button>
                  <button type="button" className="btn btn-small" onClick={() => setRemoving(null)}>
                    Cancelar
                  </button>
                </span>
              ) : (
                <button type="button" className="btn btn-small" onClick={() => setRemoving(p.id)}>
                  Remover
                </button>
              )}
            </div>
            <table className="kb-files">
              <thead>
                <tr>
                  <th scope="col">Arquivo</th>
                  <th scope="col">Papel</th>
                  <th scope="col" className="num">
                    Tamanho
                  </th>
                  <th scope="col" className="num">
                    Seções
                  </th>
                  <th scope="col" className="num">
                    Usar
                  </th>
                </tr>
              </thead>
              <tbody>
                {p.files.map((f) => (
                  <tr key={f.id} className={f.enabled && f.role !== 'desligado' ? undefined : 'is-off'}>
                    <th scope="row">
                      <span className="kb-file-title">{f.title}</span>
                      <span className="kb-file-path muted" title={f.path}>
                        {f.path}
                      </span>
                    </th>
                    <td>
                      <select
                        aria-label={`Papel de ${f.title}`}
                        value={f.role}
                        title={f.role === f.autoRole ? `Escolhido pelo Saga: ${f.roleReason}` : 'Escolhido por você'}
                        onChange={(e) => void change(() => window.saga.kbUpdateFile(f.id, { role: e.target.value as KbRole }))}
                      >
                        {KB_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {KB_ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                      <span className="kb-role-why muted">{f.role === f.autoRole ? f.roleReason : 'Escolhido por você'}</span>
                    </td>
                    <td className="num">{formatSize(f.size)}</td>
                    <td className="num">{f.sections}</td>
                    <td className="num">
                      <input
                        type="checkbox"
                        className="kb-toggle"
                        aria-label={`Usar ${f.title}`}
                        checked={f.enabled}
                        onChange={(e) => void change(() => window.saga.kbUpdateFile(f.id, { enabled: e.target.checked }))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}

      {pkgs && pkgs.length > 0 && (
        <dl className="kb-legend small">
          {KB_ROLES.map((r) => (
            <div key={r}>
              <dt>{KB_ROLE_LABELS[r]}</dt>
              <dd className="muted">{ROLE_HELP[r]}</dd>
            </div>
          ))}
        </dl>
      )}

      {pasting && (
        <PasteDialog
          onClose={() => setPasting(false)}
          onSave={async (title, text) => {
            const r = await run(() => window.saga.kbAddText(title, text))
            if (r?.status === 'imported') setPasting(false)
          }}
        />
      )}
    </section>
  )
}

function PasteDialog({ onClose, onSave }: { onClose: () => void; onSave: (title: string, text: string) => Promise<void> }) {
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <div className="overlay" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <form
        className="dialog kb-paste"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kb-paste-title"
        onSubmit={(e) => {
          e.preventDefault()
          if (title.trim() && text.trim()) void onSave(title.trim(), text)
        }}
      >
        <h2 id="kb-paste-title">Colar texto na base</h2>
        <label htmlFor="kb-paste-name">Título</label>
        <input id="kb-paste-name" ref={ref} maxLength={KB_LIMITS.titleChars} value={title} onChange={(e) => setTitle(e.target.value)} />
        <label htmlFor="kb-paste-text">Texto</label>
        <textarea id="kb-paste-text" rows={10} maxLength={KB_LIMITS.pasteChars} value={text} onChange={(e) => setText(e.target.value)} />
        <p className="muted small">Use títulos com # para dividir em seções. Um texto com o mesmo título substitui o anterior.</p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={!title.trim() || !text.trim()}>
            Adicionar
          </button>
        </div>
      </form>
    </div>
  )
}
