import { describe, expect, it } from 'vitest'
import { CHUNK_MAX, breadcrumb, chunkFile, fileTitle, splitLong, stripFrontmatter } from '../../../src/core/kb/chunk'

const para = (n: number, word = 'lorem') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ')

describe('chunkFile', () => {
  it('divide por títulos (# a ####) e guarda o texto antes do primeiro título com o nome do arquivo', () => {
    const md = `Introdução do arquivo com texto suficiente.\n\n# Pacotes\n\nTexto dos pacotes, com detalhes.\n\n## Como apresentar\n\nPrimeiro a conversa, depois o preço.\n\n### Exemplo curto\n\nUm exemplo de apresentação, com calma.\n\n##### Não é título\n\nContinua no mesmo trecho.`
    const c = chunkFile(md, 'Pacotes de preco')
    expect(c.chunks.map((x) => x.heading)).toEqual(['Pacotes de preco', 'Pacotes', 'Como apresentar', 'Como apresentar › Exemplo curto'])
    expect(c.chunks[3].text).toContain('Não é título')
    expect(c.sections).toBe(4)
  })

  it('ignora # dentro de bloco de código e seções vazias', () => {
    const md = '# A\n\n## B\n\nTexto da seção B com conteúdo.\n\n```\n# comentario de codigo\n```\n'
    const c = chunkFile(md, 'X')
    expect(c.chunks.map((x) => x.heading)).toEqual(['B'])
    expect(c.chunks[0].text).toContain('# comentario de codigo')
  })

  it('seção longa vira pedaços de até ~1.200 caracteres, com sobreposição', () => {
    const body = Array.from({ length: 6 }, (_, i) => para(60, `p${i}w`)).join('\n\n')
    const c = chunkFile(`# Longa\n\n${body}`, 'X')
    expect(c.chunks.length).toBeGreaterThan(2)
    expect(c.chunks[0].heading).toBe('Longa (parte 1)')
    for (const ch of c.chunks) expect(ch.text.length).toBeLessThanOrEqual(CHUNK_MAX + 200)
    // o segundo pedaço começa com o fim do primeiro
    const first = c.chunks[0].text
    const lastWords = first.slice(-60).split(' ').slice(-3).join(' ')
    expect(c.chunks[1].text.startsWith('…')).toBe(true)
    expect(c.chunks[1].text.split('\n')[0]).toContain(lastWords)
  })

  it('parágrafo gigante sem quebras também é dividido', () => {
    const parts = splitLong(para(800))
    expect(parts.length).toBeGreaterThan(3)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(CHUNK_MAX + 200)
  })

  it('lê a descrição do cabeçalho YAML (SKILL.md) como seção "Descrição"', () => {
    const md = '---\nname: metodo\ndescription: >\n  Atende mentorados\n  com calma.\n---\n\n# Método\n\nCorpo do arquivo com texto.'
    expect(stripFrontmatter(md).description).toBe('Atende mentorados com calma.')
    const c = chunkFile(md, 'Metodo (SKILL)')
    expect(c.chunks[0]).toMatchObject({ heading: 'Descrição', text: 'Atende mentorados com calma.' })
    expect(c.chunks[1].heading).toBe('Método')
  })
})

describe('fileTitle e breadcrumb', () => {
  it('tira pasta, número e extensão', () => {
    expect(fileTitle('conhecimento/01-aulas-gerais.md')).toBe('Aulas gerais')
    expect(fileTitle('12_regras_e_tom.txt')).toBe('Regras e tom')
    expect(fileTitle('skills/metodo-exemplo/SKILL.md')).toBe('Metodo exemplo (SKILL)')
    expect(fileTitle('2026.md')).toBe('2026')
  })
  it('"Pacote › Arquivo › Seção"', () => {
    expect(breadcrumb('Pacote', 'Arquivo', 'Seção')).toBe('Pacote › Arquivo › Seção')
    expect(breadcrumb('Pacote', 'Arquivo', 'Arquivo')).toBe('Pacote › Arquivo')
  })
})
