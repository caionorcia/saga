import type { AlertKind } from '../../../shared/triage'
import { alertChipLabel, formatWait, waitTone } from '../format'

/** Ícones simples (traço), 12 px, na cor do texto do selo. */
export function AlertIcon({ kind }: { kind: AlertKind }) {
  const common = {
    width: 12,
    height: 12,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: 'alert-icon'
  }
  switch (kind) {
    case 'urgente':
      return (
        <svg {...common}>
          <path d="M9 1.5 3.5 9h4L7 14.5 12.5 7h-4L9 1.5Z" />
        </svg>
      )
    case 'desanimo':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.3" />
          <path d="M5.3 11.2c1.5-1.4 3.9-1.4 5.4 0" />
          <path d="M5.8 6.2h.01M10.2 6.2h.01" strokeWidth={2.4} />
        </svg>
      )
    case 'reuniao':
      return (
        <svg {...common}>
          <rect x="2" y="3" width="12" height="11" rx="2" />
          <path d="M2 6.8h12M5.3 1.6v2.6M10.7 1.6v2.6" />
        </svg>
      )
    case 'travado':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.3" />
          <path d="M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4" />
          <path d="M8 11.6h.01" strokeWidth={2.4} />
        </svg>
      )
    case 'esperando':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.3" />
          <path d="M8 4.6V8l2.3 1.6" />
        </svg>
      )
  }
}

/** Selos de alerta de uma conversa: no máximo 2 visíveis, depois "+N". */
export function AlertChips({ kinds, waitingSince, now }: { kinds: AlertKind[]; waitingSince: number | null; now: number }) {
  if (kinds.length === 0) return null
  const shown = kinds.slice(0, 2)
  const rest = kinds.length - shown.length
  const all = kinds.map((k) => alertChipLabel(k, waitingSince, now)).join(', ')
  return (
    <span className="alert-chips" title={`Alertas: ${all}`}>
      <span className="sr-only">Alertas: {all}</span>
      {shown.map((k) => (
        <span key={k} className={`alert-chip alert-${k}`} data-testid="alert-chip" aria-hidden="true">
          <AlertIcon kind={k} />
          {alertChipLabel(k, waitingSince, now)}
        </span>
      ))}
      {rest > 0 && (
        <span className="alert-chip alert-more" aria-hidden="true">
          +{rest}
        </span>
      )}
    </span>
  )
}

/** "há 3 h", com a cor da espera (neutra, âmbar depois de 24 h, vermelha depois de 48 h). */
export function WaitBadge({ since, now }: { since: number; now: number }) {
  const text = formatWait(since, now)
  return (
    <span className={`wait-badge wait-${waitTone(since, now)}`} title={`Aguardando sua resposta ${text}`}>
      {text}
    </span>
  )
}
