import { useState } from 'react'

/** "Copiar diagnóstico" e "Abrir pasta de registros" (passo do QR e configurações). */
export function DiagnosticsActions() {
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null)
  const copy = async () => {
    setMsg(null)
    try {
      await window.saga.copyDiagnostics()
      setMsg({ text: 'Diagnóstico copiado ✓ Cole numa mensagem para o suporte.', bad: false })
    } catch {
      setMsg({ text: 'Não foi possível copiar o diagnóstico.', bad: true })
    }
  }
  const open = async () => {
    setMsg(null)
    try {
      await window.saga.openLogsFolder()
    } catch {
      setMsg({ text: 'Não foi possível abrir a pasta de registros.', bad: true })
    }
  }
  return (
    <div className="diag-actions">
      <button type="button" className="btn btn-small" onClick={() => void copy()}>
        Copiar diagnóstico
      </button>
      <button type="button" className="btn btn-small" onClick={() => void open()}>
        Abrir pasta de registros
      </button>
      {msg && (
        <p className={msg.bad ? 'field-error small' : 'ok-text small'} role="status">
          {msg.text}
        </p>
      )}
    </div>
  )
}
