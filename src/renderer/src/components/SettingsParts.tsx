import type { ReactNode } from 'react'

/** Grupo das Configurações: título, uma linha de explicação e os cartões. `id` é o alvo do menu lateral. */
export function Group({ id, title, desc, children, extra }: { id: string; title: string; desc: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <section className="settings-group" id={id} aria-labelledby={`${id}-title`} tabIndex={-1}>
      <header className="settings-group-head">
        <h2 id={`${id}-title`}>{title}</h2>
        <p className="help">{desc}</p>
        {extra}
      </header>
      {children}
    </section>
  )
}

/** Texto de apoio que fica fechado ("Saiba mais"), para a tela não virar um muro de texto. */
export function Info({ summary = 'Saiba mais', children }: { summary?: string; children: ReactNode }) {
  return (
    <details className="s-info">
      <summary>{summary}</summary>
      <span className="s-info-body">{children}</span>
    </details>
  )
}
