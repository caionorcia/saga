import { describe, expect, it } from 'vitest'
import { join, resolve, sep } from 'node:path'
import { audioFileId, audioUrlFor, resolveMediaPath } from '../../src/core/media'

const MEDIA = resolve('/dados/saga/media')

describe('saga-media://', () => {
  it('audioFileId troca caracteres fora de [A-Za-z0-9_-] por _', () => {
    expect(audioFileId('3EB0ABC123')).toBe('3EB0ABC123')
    expect(audioFileId('a.b/c')).toBe('a_b_c')
  })

  it('url → caminho dentro de media/', () => {
    expect(audioUrlFor('3EB0_x-1')).toBe('saga-media://audio/3EB0_x-1')
    expect(resolveMediaPath(MEDIA, 'saga-media://audio/3EB0_x-1')).toBe(join(MEDIA, '3EB0_x-1.ogg'))
  })

  it('segmentos ".." nunca saem de media/', () => {
    for (const u of ['saga-media://audio/../saga', 'saga-media://audio/../../../etc/passwd', 'saga-media://audio/x/../../y']) {
      const p = resolveMediaPath(MEDIA, u)
      if (p !== null) expect(p.startsWith(MEDIA.endsWith(sep) ? MEDIA : MEDIA + sep)).toBe(true)
    }
  })

  it.each([
    'saga-media://audio/..%2F..%2Fsaga.db',
    'saga-media://audio/%2e%2e',
    'saga-media://audio/a/b',
    'saga-media://audio/a.b',
    'saga-media://audio/',
    'saga-media://audio/%E0%A4%A',
    'saga-media://outro/abc',
    'file:///etc/passwd',
    'https://audio/abc',
    'não é url'
  ])('recusa %s', (url) => {
    expect(resolveMediaPath(MEDIA, url)).toBeNull()
  })
})
