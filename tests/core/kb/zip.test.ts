import { describe, expect, it } from 'vitest'
import { KbImportError, readZip, safeEntryPath } from '../../../src/core/kb/zip'
import { makeZip } from './fixtures'

const LIMITS = { fileBytes: 1000, totalBytes: 2500, maxFiles: 10 }
const all = () => true

describe('safeEntryPath (zip-slip)', () => {
  it('recusa .., caminho absoluto, letra de unidade, NUL, ocultos e __MACOSX', () => {
    for (const p of ['../fora.md', 'a/../../fora.md', '/etc/passwd', 'C:/Windows/x.md', 'c:\\x.md', 'a\0b.md', '.git/config', 'a/.oculto.md', '__MACOSX/a.md', '']) {
      expect(safeEntryPath(p)).toBeNull()
    }
  })
  it('normaliza barras e "."', () => {
    expect(safeEntryPath('pasta\\sub\\a.md')).toBe('pasta/sub/a.md')
    expect(safeEntryPath('./pasta//a.md')).toBe('pasta/a.md')
  })
})

describe('readZip', () => {
  it('lê arquivos compactados e sem compressão, com nomes acentuados', () => {
    const zip = makeZip([
      { name: 'pacote/Introdução.md', data: '# Olá\n\ntexto' },
      { name: 'pacote/b.txt', data: 'sem compressão', method: 0 },
      { name: 'pacote/pasta/', data: '' }
    ])
    const r = readZip(zip, all, LIMITS)
    expect(r.entries.map((e) => [e.path, e.data.toString('utf8')])).toEqual([
      ['pacote/Introdução.md', '# Olá\n\ntexto'],
      ['pacote/b.txt', 'sem compressão']
    ])
    expect(r.skipped).toBe(0)
  })

  it('ignora caminhos perigosos, links, não aceitos e grandes demais (por arquivo e no total)', () => {
    const zip = makeZip([
      { name: '../fora.md', data: 'x' },
      { name: 'link.md', data: '/etc/passwd', symlink: true },
      { name: 'foto.png', data: 'x' },
      { name: 'grande.md', data: 'a'.repeat(1200) },
      { name: 'um.md', data: 'b'.repeat(900) },
      { name: 'dois.md', data: 'c'.repeat(900) },
      { name: 'tres.md', data: 'd'.repeat(900) }
    ])
    const r = readZip(zip, (p) => p.endsWith('.md'), LIMITS)
    expect(r.entries.map((e) => e.path)).toEqual(['um.md', 'dois.md'])
    expect(r.skipped).toBe(5)
  })

  it('não confia no tamanho declarado: corta a descompactação no limite ("zip bomb")', () => {
    const zip = makeZip([{ name: 'bomba.md', data: 'z'.repeat(50_000), fakeSize: 10 }])
    const r = readZip(zip, all, LIMITS)
    expect(r.entries).toEqual([])
    expect(r.skipped).toBe(1)
  })

  it('respeita o número máximo de arquivos', () => {
    const zip = makeZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.md`, data: `arquivo ${i}` })))
    const r = readZip(zip, all, { ...LIMITS, maxFiles: 3 })
    expect(r.entries).toHaveLength(3)
    expect(r.skipped).toBe(2)
  })

  it('lança KbImportError para o que não é .zip ou está cortado', () => {
    expect(() => readZip(Buffer.from('não sou um zip'), all, LIMITS)).toThrow(KbImportError)
    const zip = makeZip([{ name: 'a.md', data: 'texto' }])
    const cut = Buffer.concat([zip.subarray(0, 10), zip.subarray(zip.length - 22)])
    expect(() => readZip(cut, all, LIMITS)).toThrow(KbImportError)
  })
})
