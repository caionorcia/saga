import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'

export const ONE_GB = 1024 ** 3

/**
 * `true` se o disco onde fica `dir` tem pelo menos `minBytes` livres para o usuário.
 * Se `dir` ainda não existe, mede o primeiro pai existente. Se nem isso der para medir,
 * devolve `true` (não pausar a fila por falha de medição; a gravação em si falharia).
 */
export async function hasFreeSpace(dir: string, minBytes: number): Promise<boolean> {
  let p = dir
  for (;;) {
    try {
      const s = await statfs(p)
      return Number(s.bavail) * Number(s.bsize) >= minBytes
    } catch {
      const parent = dirname(p)
      if (parent === p) return true
      p = parent
    }
  }
}
