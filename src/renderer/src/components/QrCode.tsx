import { useState } from 'react'
import type { AppState } from '../../../shared/api'

/** QR Code para vincular o WhatsApp, com a instrução e o botão "Gerar novo QR Code" (assistente e tela principal). */
export function QrCode({ state }: { state: AppState }) {
  const [busy, setBusy] = useState(false)
  const renew = async () => {
    setBusy(true)
    try {
      await window.saga.manualReconnect()
    } catch {
      // o próximo estado do app mostra o resultado
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <p>
        No celular: <strong>WhatsApp › Aparelhos conectados › Conectar um aparelho</strong>. Depois aponte a câmera para o
        código abaixo.
      </p>
      <div className="qr-box">
        {state.qr ? (
          <img src={state.qr} alt="QR Code para vincular o WhatsApp" width={240} height={240} />
        ) : (
          <p className="muted" role="status">
            {state.conn === 'open' ? 'Conectado!' : 'Preparando o QR Code…'}
          </p>
        )}
      </div>
      <p className="muted small">
        O código muda de tempos em tempos. Se ele não aparecer ou o celular não aceitar, clique em{' '}
        <strong>Gerar novo QR Code</strong>.
      </p>
      <button type="button" className="btn" disabled={busy || state.conn === 'open'} onClick={() => void renew()}>
        Gerar novo QR Code
      </button>
    </>
  )
}
