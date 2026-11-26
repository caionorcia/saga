import { useEffect, useState } from 'react'
import type { BackupCounts, BackupPreview, BackupStatus, UiPrefs } from '../../../shared/backup'
import { BACKUP_PASSWORD_MIN } from '../../../shared/backup'
import { formatDay, formatTime } from '../format'
import { applyTheme } from '../theme'
import { formatSize } from './KnowledgeBase'

/** Preferências da tela que vão junto na cópia (filtros da lista e Foco). */
const UI_PREF_KEYS = ['saga.contactKind', 'saga.contactView', 'saga.focus']

function readUiPrefs(): UiPrefs {
  const out: UiPrefs = {}
  try {
    for (const k of UI_PREF_KEYS) {
      const v = localStorage.getItem(k)
      if (v !== null) out[k] = v
    }
  } catch {
    // sem armazenamento: vai sem
  }
  return out
}

function writeUiPrefs(p: UiPrefs, onlyMissing: boolean): void {
  try {
    for (const k of UI_PREF_KEYS) if (p[k] !== undefined && (!onlyMissing || localStorage.getItem(k) === null)) localStorage.setItem(k, p[k])
  } catch {
    // sem armazenamento
  }
}

const when = (ts: number) => `${formatDay(ts)}, ${formatTime(ts)}`
const n = (v: number, one: string, many: string) => `${v.toLocaleString('pt-BR')} ${v === 1 ? one : many}`

/** "42 respostas aprovadas, 9 contatos com nome ou notas, …" (só o que tem). */
export function countsList(c: BackupCounts): string[] {
  const out = [
    c.approvedReplies && n(c.approvedReplies, 'resposta aprovada', 'respostas aprovadas'),
    c.contacts && n(c.contacts, 'contato com nome ou notas', 'contatos com nome ou notas'),
    c.alertFeedback + c.replyFeedback && n(c.alertFeedback + c.replyFeedback, 'avaliação', 'avaliações'),
    c.kbFiles && `${n(c.kbFiles, 'arquivo', 'arquivos')} da base de conhecimento${c.kbPackages ? ` (${n(c.kbPackages, 'pacote', 'pacotes')})` : ''}`,
    c.settings && n(c.settings, 'configuração', 'configurações'),
    c.messages && n(c.messages, 'mensagem', 'mensagens')
  ]
  return out.filter((x): x is string => !!x)
}

type Restore =
  | { step: 'idle' }
  | { step: 'password'; token: string; createdAt: number; error: string | null; busy: boolean }
  | { step: 'preview'; token: string; preview: BackupPreview; confirmReplace: boolean; busy: boolean }

/** Configurações › "Cópia de segurança": exportar, restaurar e a cópia automática semanal. */
export function BackupSection() {
  const [st, setSt] = useState<BackupStatus | null>(null)
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null)
  const [protect, setProtect] = useState(true)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [withMessages, setWithMessages] = useState(false)
  const [busy, setBusy] = useState(false)
  const [restore, setRestore] = useState<Restore>({ step: 'idle' })
  const [restorePw, setRestorePw] = useState('')
  const [autoPw, setAutoPw] = useState('')

  useEffect(() => {
    let alive = true
    window.saga
      .backupStatus()
      .then((s) => alive && setSt(s))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const pwError =
    protect && pw.length > 0 && pw.length < BACKUP_PASSWORD_MIN
      ? `A senha precisa ter pelo menos ${BACKUP_PASSWORD_MIN} caracteres.`
      : protect && pw2.length > 0 && pw !== pw2
        ? 'As duas senhas não são iguais.'
        : null
  const canExport = !busy && (!protect || (pw.length >= BACKUP_PASSWORD_MIN && pw === pw2))

  const doExport = async () => {
    setMsg(null)
    setBusy(true)
    try {
      const r = await window.saga.exportBackup({ includeMessages: withMessages, password: protect ? pw : undefined, uiPrefs: readUiPrefs() })
      if (r.status === 'saved') {
        const size = formatSize(r.bytes)
        setMsg({
          text: r.encrypted ? `Cópia salva ✓ (${size}, protegida com senha). Guarde a senha: sem ela a cópia não abre.` : `Cópia salva ✓ (${size}).`,
          bad: false
        })
        setPw('')
        setPw2('')
        setSt(await window.saga.backupStatus())
      } else if (r.status === 'error') setMsg({ text: r.message, bad: true })
    } catch {
      setMsg({ text: 'Não foi possível exportar a cópia. Tente de novo.', bad: true })
    } finally {
      setBusy(false)
    }
  }

  const openRestore = async () => {
    setMsg(null)
    try {
      const r = await window.saga.restoreOpen()
      if (r.status === 'canceled') return
      if (r.status === 'error') setMsg({ text: r.message, bad: true })
      else if (r.status === 'needs_password') {
        setRestorePw('')
        setRestore({ step: 'password', token: r.token, createdAt: r.createdAt, error: null, busy: false })
      } else setRestore({ step: 'preview', token: r.token, preview: r.preview, confirmReplace: false, busy: false })
    } catch {
      setMsg({ text: 'Não foi possível abrir a cópia.', bad: true })
    }
  }

  const unlock = async () => {
    if (restore.step !== 'password') return
    setRestore({ ...restore, busy: true, error: null })
    try {
      const r = await window.saga.restoreUnlock(restore.token, restorePw)
      if (r.status === 'preview') setRestore({ step: 'preview', token: r.token, preview: r.preview, confirmReplace: false, busy: false })
      else if (r.status === 'error') setRestore({ ...restore, busy: false, error: r.message })
    } catch {
      setRestore({ ...restore, busy: false, error: 'Não foi possível abrir a cópia.' })
    }
  }

  const apply = async (mode: 'merge' | 'replace') => {
    if (restore.step !== 'preview') return
    setRestore({ ...restore, busy: true })
    try {
      const r = await window.saga.restoreApply(restore.token, mode)
      setRestore({ step: 'idle' })
      if (r.status === 'restored') {
        writeUiPrefs(r.uiPrefs, mode === 'merge')
        try {
          applyTheme((await window.saga.getSettings()).theme)
        } catch {
          // fica o tema atual
        }
        const what = countsList(r.counts)
        setMsg({ text: `Cópia restaurada ✓ ${what.length ? `Entrou: ${what.join(', ')}.` : 'Nada novo: tudo já estava aqui.'} Digite as chaves de acesso de novo, se ainda não digitou.`, bad: false })
      } else setMsg({ text: r.message, bad: true })
    } catch {
      setRestore({ step: 'idle' })
      setMsg({ text: 'Não foi possível restaurar a cópia. Nada foi alterado.', bad: true })
    }
  }

  const setAuto = async (patch: Parameters<typeof window.saga.setAutoBackup>[0]) => {
    try {
      setSt(await window.saga.setAutoBackup(patch))
      return true
    } catch {
      setMsg({ text: 'Não foi possível salvar. Tente de novo.', bad: true })
      return false
    }
  }

  return (
    <section aria-labelledby="backup-title" className="backup-section">
      <h2 id="backup-title">Cópia de segurança</h2>
      <p className="muted small">
        Guarde o que o SagaZap aprendeu — respostas aprovadas, nomes e notas dos contatos, avaliações, a base de conhecimento e as
        configurações — para não perder se trocar de computador. As <strong>chaves de acesso</strong> e a ligação com o WhatsApp
        não vão na cópia: no computador novo, digite as chaves de novo e vincule o WhatsApp (as mensagens voltam sozinhas).
      </p>
      <p className="small backup-last">{st?.lastAt ? `Última cópia: ${when(st.lastAt)}` : 'Nenhuma cópia feita ainda.'}</p>

      <div className="backup-box">
        <h3>Exportar</h3>
        <label className="check">
          <input type="checkbox" checked={protect} onChange={(e) => setProtect(e.target.checked)} />
          Proteger com senha (recomendado)
        </label>
        {protect && (
          <div className="backup-pw">
            <label htmlFor="bk-pw">Senha da cópia</label>
            <input id="bk-pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
            <label htmlFor="bk-pw2">Repita a senha</label>
            <input id="bk-pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
            <p className={pwError ? 'field-error' : 'muted small'}>{pwError ?? 'Anote a senha num lugar seguro: sem ela a cópia não abre.'}</p>
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={withMessages} onChange={(e) => setWithMessages(e.target.checked)} />
          Incluir mensagens e transcrições (arquivo maior)
        </label>
        <button type="button" className="btn btn-primary" disabled={!canExport} onClick={() => void doExport()}>
          {busy ? 'Exportando…' : 'Exportar cópia'}
        </button>
      </div>

      <div className="backup-box">
        <h3>Restaurar</h3>
        {restore.step === 'idle' && (
          <>
            <p className="muted small">Escolha um arquivo .sagabackup. Antes de mudar qualquer coisa, o SagaZap mostra o que tem na cópia.</p>
            <button type="button" className="btn" onClick={() => void openRestore()}>
              Restaurar cópia
            </button>
          </>
        )}
        {restore.step === 'password' && (
          <form
            className="backup-unlock"
            onSubmit={(e) => {
              e.preventDefault()
              void unlock()
            }}
          >
            <p className="small">Cópia de {when(restore.createdAt)}, protegida com senha.</p>
            <label htmlFor="bk-restore-pw">Senha desta cópia</label>
            <input id="bk-restore-pw" type="password" autoComplete="current-password" autoFocus value={restorePw} onChange={(e) => setRestorePw(e.target.value)} />
            {restore.error && (
              <p className="field-error" role="alert">
                {restore.error}
              </p>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => setRestore({ step: 'idle' })}>
                Cancelar
              </button>
              <button type="submit" className="btn btn-primary" disabled={!restorePw || restore.busy}>
                Abrir
              </button>
            </div>
          </form>
        )}
        {restore.step === 'preview' && (
          <div className="backup-preview" aria-label="O que tem na cópia">
            <p className="small">
              <strong>Cópia de {when(restore.preview.createdAt)}</strong>
              {restore.preview.appVersion && ` (SagaZap ${restore.preview.appVersion})`}
              {restore.preview.encrypted && ' · protegida com senha'}
            </p>
            <ul className="small">
              {countsList(restore.preview.counts).map((t) => (
                <li key={t}>{t}</li>
              ))}
              {countsList(restore.preview.counts).length === 0 && <li>A cópia está vazia.</li>}
            </ul>
            {!restore.confirmReplace ? (
              <div className="backup-actions">
                <button type="button" className="btn btn-primary" disabled={restore.busy} onClick={() => void apply('merge')}>
                  Juntar com o que já existe
                </button>
                <button type="button" className="btn" disabled={restore.busy} onClick={() => setRestore({ ...restore, confirmReplace: true })}>
                  Substituir
                </button>
                <button type="button" className="link-btn" onClick={() => setRestore({ step: 'idle' })}>
                  Cancelar
                </button>
              </div>
            ) : (
              <div className="backup-confirm" role="alertdialog" aria-labelledby="bk-confirm-title">
                <p id="bk-confirm-title" className="small">
                  <strong>Substituir apaga</strong> as respostas aprovadas, avaliações, nomes e notas e a base de conhecimento deste
                  computador e põe as da cópia no lugar. As mensagens não são apagadas. Continuar?
                </p>
                <div className="backup-actions">
                  <button type="button" className="btn btn-danger" disabled={restore.busy} onClick={() => void apply('replace')}>
                    Sim, substituir
                  </button>
                  <button type="button" className="btn" onClick={() => setRestore({ ...restore, confirmReplace: false })}>
                    Voltar
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="backup-box">
        <h3>Cópia automática</h3>
        <label className="check">
          <input type="checkbox" checked={!!st?.auto.enabled} disabled={!st} onChange={(e) => void setAuto({ enabled: e.target.checked })} />
          Fazer cópia automática semanal
        </label>
        <p className="muted small">
          Uma vez por semana, quando o computador estiver parado, o SagaZap grava uma cópia na pasta escolhida e guarda as 5 mais
          novas. Dica: escolha uma pasta do <strong>Google Drive</strong> ou do <strong>OneDrive</strong> no seu computador — assim a
          cópia também fica guardada na nuvem.
        </p>
        <div className="backup-folder">
          <span className="small">{st?.auto.folder ? <>Pasta: <code>{st.auto.folder}</code></> : 'Nenhuma pasta escolhida.'}</span>
          <button
            type="button"
            className="btn btn-small"
            onClick={() =>
              void window.saga
                .chooseBackupFolder()
                .then(setSt)
                .catch(() => {})
            }
          >
            Escolher pasta
          </button>
        </div>
        {st?.auto.enabled && !st.auto.folder && <p className="field-error">Escolha a pasta para a cópia automática funcionar.</p>}
        <form
          className="backup-auto-pw"
          onSubmit={(e) => {
            e.preventDefault()
            if (autoPw.length >= BACKUP_PASSWORD_MIN) void setAuto({ password: autoPw }).then((ok) => ok && setAutoPw(''))
          }}
        >
          <label htmlFor="bk-auto-pw">{st?.auto.hasPassword ? 'As cópias automáticas têm senha. Trocar a senha:' : 'Senha das cópias automáticas (recomendado)'}</label>
          <div className="inline-field">
            <input id="bk-auto-pw" type="password" autoComplete="new-password" value={autoPw} onChange={(e) => setAutoPw(e.target.value)} />
            <button type="submit" className="btn btn-small" disabled={autoPw.length < BACKUP_PASSWORD_MIN}>
              Salvar senha
            </button>
            {st?.auto.hasPassword && (
              <button type="button" className="link-btn small" onClick={() => void setAuto({ password: '' })}>
                Tirar a senha
              </button>
            )}
          </div>
        </form>
        <p className="small muted">
          {st?.auto.lastAt ? `Última cópia automática: ${when(st.auto.lastAt)}` : 'Ainda não houve cópia automática.'}
          {st?.auto.lastError && <span className="field-error"> — a última tentativa falhou ({st.auto.lastError}). Confira a pasta.</span>}
        </p>
      </div>

      <p className={msg?.bad ? 'field-error' : 'ok-text small'} role="status" aria-live="polite">
        {msg?.text ?? ' '}
      </p>
    </section>
  )
}
