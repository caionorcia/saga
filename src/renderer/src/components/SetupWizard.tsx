import { useEffect, useState } from 'react'
import type { AppState, KeyKind } from '../../../shared/api'

interface Props {
  state: AppState
  onFinish: () => void
}

const STEPS = 5

export function SetupWizard({ state, onFinish }: Props) {
  const [step, setStep] = useState(1)

  // com o celular vinculado, segue sozinho para a importação
  useEffect(() => {
    if (step === 4 && state.conn === 'open') setStep(5)
  }, [step, state.conn])

  return (
    <main className="wizard">
      <div className="wizard-card">
        <p className="wizard-progress" aria-label={`Passo ${step} de ${STEPS}`}>
          Passo {step} de {STEPS}
        </p>
        {step === 1 && <Welcome onNext={() => setStep(2)} />}
        {step === 2 && <KeyStep kind="groq" onNext={() => setStep(3)} onBack={() => setStep(1)} />}
        {step === 3 && <KeyStep kind="claude" onNext={() => setStep(4)} onBack={() => setStep(2)} />}
        {step === 4 && <QrStep state={state} onBack={() => setStep(3)} />}
        {step === 5 && <ImportStep state={state} onFinish={onFinish} />}
      </div>
    </main>
  )
}

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <>
      <h1>Bem-vindo ao Saga</h1>
      <p>
        O Saga lê as conversas do seu WhatsApp, transcreve os áudios e sugere respostas para você revisar. Ele
        <strong> nunca envia mensagens</strong>: você copia o texto e cola no WhatsApp.
      </p>
      <div className="notice" role="note">
        <strong>Antes de começar, um aviso importante</strong>
        <p>
          O Saga se conecta ao WhatsApp como um aparelho vinculado (o mesmo que o WhatsApp Web). Esse tipo de uso não é
          oficial, e existe um pequeno risco de o WhatsApp limitar a conta. Para reduzir esse risco, o Saga só lê, vai
          devagar e nunca marca nada como lido.
        </p>
      </div>
      <div className="wizard-actions">
        <button type="button" className="btn btn-primary" onClick={onNext}>
          Entendi, vamos começar
        </button>
      </div>
    </>
  )
}

function KeyStep({ kind, onNext, onBack }: { kind: Extract<KeyKind, 'groq' | 'claude'>; onNext: () => void; onBack: () => void }) {
  const isGroq = kind === 'groq'
  const [key, setKey] = useState('')
  const [test, setTest] = useState<'idle' | 'testing' | 'ok' | 'bad'>('idle')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keepGroq, setKeepGroq] = useState(false)

  const runTest = async () => {
    setTest('testing')
    setError(null)
    try {
      setTest((await window.saga.testKey(kind, key.trim())) ? 'ok' : 'bad')
    } catch {
      setTest('bad')
    }
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const r = await window.saga.saveSettings(isGroq ? { groqKey: key.trim() } : { claudeKey: key.trim(), provider: keepGroq ? 'groq' : 'claude' })
      if (r.ok) onNext()
      else setError(r.message)
    } catch {
      setError('Não foi possível salvar a chave. Tente de novo.')
    } finally {
      setSaving(false)
    }
  }

  const id = `key-${kind}`
  return (
    <>
      <h1>{isGroq ? 'Chave do Groq (grátis)' : 'Chave do Claude (opcional)'}</h1>
      {isGroq ? (
        <>
          <p>O Groq transcreve os áudios e escreve as sugestões, sem custo. Para usar, você precisa de uma chave:</p>
          <ol className="steps">
            <li>
              Abra <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">https://console.groq.com/keys</a> e entre
              com a sua conta (pode ser a do Google).
            </li>
            <li>
              Clique em <strong>Create API Key</strong>, dê um nome (por exemplo, Saga) e confirme.
            </li>
            <li>Copie a chave que aparece (começa com “gsk_”) e cole abaixo.</li>
          </ol>
        </>
      ) : (
        <p>
          Se quiser sugestões ainda melhores, você pode usar o Claude, da Anthropic (pago, por uso). Dá para configurar depois
          em Configurações. Se preferir só o Groq, clique em <strong>Pular</strong>.
        </p>
      )}
      <label htmlFor={id}>{isGroq ? 'Chave do Groq' : 'Chave do Claude'}</label>
      <input
        id={id}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={key}
        placeholder={isGroq ? 'gsk_…' : 'sk-ant-…'}
        onChange={(e) => {
          setKey(e.target.value)
          setTest('idle')
        }}
      />
      <div className="test-row">
        <button type="button" className="btn" disabled={!key.trim() || test === 'testing'} onClick={() => void runTest()}>
          {test === 'testing' ? 'Testando…' : 'Testar'}
        </button>
        {test === 'ok' && <span className="ok-text" role="status">Chave funcionando ✓</span>}
        {test === 'bad' && <span className="field-error" role="status">Essa chave não funcionou. Confira se copiou inteira.</span>}
      </div>
      {!isGroq && (
        <>
          <p className="muted small">
            Ao salvar a chave do Claude, ele passa a escrever as sugestões (pago, por uso). Se preferir continuar com o Groq
            (grátis), marque a opção abaixo; a chave fica guardada para você trocar depois.
          </p>
          <label className="check">
            <input type="checkbox" checked={keepGroq} onChange={(e) => setKeepGroq(e.target.checked)} />
            Continuar usando o Groq (grátis) para as sugestões
          </label>
        </>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="wizard-actions">
        <button type="button" className="btn" onClick={onBack}>
          Voltar
        </button>
        {!isGroq && (
          <button type="button" className="btn" onClick={onNext}>
            Pular
          </button>
        )}
        <button type="button" className="btn btn-primary" disabled={test !== 'ok' || saving} onClick={() => void save()}>
          Continuar
        </button>
      </div>
    </>
  )
}

function QrStep({ state, onBack }: { state: AppState; onBack: () => void }) {
  return (
    <>
      <h1>Vincule o seu WhatsApp</h1>
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
      <p className="muted small">O código muda de tempos em tempos; se expirar, um novo aparece sozinho.</p>
      <div className="wizard-actions">
        <button type="button" className="btn" onClick={onBack}>
          Voltar
        </button>
      </div>
    </>
  )
}

function ImportStep({ state, onFinish }: { state: AppState; onFinish: () => void }) {
  const { done, pending, running, failed } = state.queue
  const total = done + pending + running + failed
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)
  return (
    <>
      <h1>Importando as conversas</h1>
      <p>O Saga está trazendo os últimos 30 dias de conversas e baixando os áudios, aos poucos, para não sobrecarregar o WhatsApp. Você já pode começar a usar enquanto isso.</p>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Progresso da importação">
        <div style={{ width: `${pct}%` }} />
      </div>
      <p className="muted">{total === 0 ? 'Aguardando as primeiras conversas…' : `${done} de ${total} itens prontos`}</p>
      <div className="wizard-actions">
        <button type="button" className="btn btn-primary" onClick={onFinish}>
          Começar a usar
        </button>
      </div>
    </>
  )
}
