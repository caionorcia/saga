import type { Plugin } from 'vite'

/**
 * Só no servidor de desenvolvimento: o HMR do Vite precisa de um script inline e de WebSocket.
 * O build de produção mantém a CSP estrita do index.html.
 */
export function devCsp(): Plugin {
  return {
    name: 'saga-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /(http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/,
        `$1default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' saga-media: data:; connect-src 'self' ws: http:$2`
      )
    }
  }
}
