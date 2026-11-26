import { setForceSend, useForceSend } from '../forceSend'
import { ClockIcon } from './SendDialog'

const TIP =
  'Fora do horário de envio, a confirmação desta conversa já abre com "Forçar envio" marcado. ' +
  'Você ainda confirma cada envio. Desliga sozinho em 30 minutos ou ao fechar a conversa.'

/** "Forçar envio" no cabeçalho da conversa (v0.4.1): só para esta conversa, só na memória, desliga sozinho. */
export function ForceSendToggle({ jid }: { jid: string }) {
  const on = useForceSend(jid)
  return (
    <button
      type="button"
      className={`btn btn-small force-toggle${on ? ' force-on' : ''}`}
      aria-pressed={on}
      title={TIP}
      onClick={() => setForceSend(jid, !on)}
    >
      <ClockIcon />
      {on ? 'Forçar envio: ligado' : 'Forçar envio'}
    </button>
  )
}
