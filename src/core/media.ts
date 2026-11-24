import { isAbsolute, join, relative, resolve } from 'node:path'

/** Protocolo registrado no main para ouvir os áudios originais (`saga-media://audio/<id>`). */
export const MEDIA_SCHEME = 'saga-media'

const SAFE_ID = /^[A-Za-z0-9_-]+$/

/** Id da mensagem → nome do arquivo em `media/` (sem extensão). */
export function audioFileId(messageId: string): string {
  return messageId.replace(/[^A-Za-z0-9_-]/g, '_')
}

export function audioUrlFor(fileId: string): string {
  return `${MEDIA_SCHEME}://audio/${fileId}`
}

/**
 * `saga-media://audio/<id>` → caminho de `<mediaDir>/<id>.ogg`, ou `null` se a URL não for
 * desse formato, o id tiver algo fora de `[A-Za-z0-9_-]` ou o caminho sair de `mediaDir`.
 */
export function resolveMediaPath(mediaDir: string, url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== `${MEDIA_SCHEME}:` || u.hostname !== 'audio' || u.search || u.hash) return null
  let id: string
  try {
    id = decodeURIComponent(u.pathname.replace(/^\//, ''))
  } catch {
    return null
  }
  if (!SAFE_ID.test(id)) return null
  const base = resolve(mediaDir)
  const file = join(base, `${id}.ogg`)
  const rel = relative(base, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return file
}
