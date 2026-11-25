/** Ícone de grupo (duas pessoas), no lugar das iniciais no avatar. */
export function GroupIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="9" cy="8" r="3.6" />
      <path d="M2.5 19.2c0-3.4 2.9-5.7 6.5-5.7s6.5 2.3 6.5 5.7c0 .5-.4.8-.8.8H3.3c-.4 0-.8-.3-.8-.8z" />
      <circle cx="16.6" cy="9" r="2.9" opacity=".8" />
      <path d="M16.2 13.6c3 0 5.3 1.9 5.3 4.8 0 .4-.3.7-.7.7h-3.9c.1-.3.1-.6.1-.9 0-1.8-.8-3.4-2.1-4.4.4-.1.8-.2 1.3-.2z" opacity=".8" />
    </svg>
  )
}
