import { describe, expect, it } from 'vitest'
import { buildSnippet, fold, matchRanges, parseQuery, stem, toFtsMatch } from '../../../src/core/search/query'

describe('parseQuery (perguntas naturais)', () => {
  it('tira perguntas e palavras vazias; guarda as com 3 letras ou mais, sem acento', () => {
    const p = parseQuery('Quem falou sobre precificação?')
    expect(p.terms).toEqual(['precificacao'])
    expect(p.prefixes).toEqual(['precifica'])
    expect(parseQuery('alguém me falou do preço da mentoria quando?').terms).toEqual(['preco', 'mentoria'])
    expect(parseQuery('qual o valor de 3000').terms).toEqual(['valor', '3000'])
  })

  it('só palavras vazias: nada para procurar', () => {
    const p = parseQuery('quem falou sobre isso?')
    expect(p.terms).toEqual([])
    expect(p.phrases).toEqual([])
  })

  it('aspas: frase exata (com as palavras curtas)', () => {
    const p = parseQuery('"plano de ação" reunião')
    expect(p.phrases).toEqual([['plano', 'de', 'acao']])
    expect(p.terms).toEqual(['reuniao'])
    expect(toFtsMatch(p, 'and')).toBe('"reuni"* AND "plano de acao"')
    expect(toFtsMatch(p, 'or')).toBe('"reuni"* OR "plano de acao"')
  })

  it('stem: corta terminações comuns, deixa pelo menos 4 letras', () => {
    expect(stem('precificacao')).toBe('precifica')
    expect(stem('vendas')).toBe('vend')
    expect(stem('clientes')).toBe('client')
    expect(stem('caso')).toBe('caso')
    expect(stem('preco')).toBe('preco')
  })

  it('aspas soltas e caracteres do FTS5 não quebram a expressão', () => {
    const p = parseQuery('preço" AND (NEAR* OR -x')
    expect(toFtsMatch(p, 'and')).not.toMatch(/[()]/)
  })
})

describe('destaque e trecho', () => {
  it('acha as palavras no texto original (com acento e prefixo)', () => {
    const text = 'Como PRECIFICAR o serviço? A precificação está difícil.'
    const r = matchRanges(text, parseQuery('precificação'))
    expect(r.map(([s, e]) => text.slice(s, e))).toEqual(['PRECIFICAR', 'precificação'])
    expect(fold('Ação')).toBe('acao')
  })

  it('frase entre aspas', () => {
    const text = 'Vamos montar o plano de ação juntos'
    const r = matchRanges(text, parseQuery('"plano de acao"'))
    expect(r.map(([s, e]) => text.slice(s, e))).toEqual(['plano de ação'])
  })

  it('trecho em volta da primeira palavra, com as posições dentro do trecho', () => {
    const long = `${'Bla '.repeat(80)}aqui fala de preço e de mais preços ${'fim '.repeat(80)}`
    const s = buildSnippet(long, parseQuery('preço'), 120)
    expect(s.cutStart).toBe(true)
    expect(s.cutEnd).toBe(true)
    expect(s.text.length).toBeLessThanOrEqual(120)
    expect(s.ranges.map(([a, b]) => s.text.slice(a, b))).toEqual(['preço', 'preços'])
    const short = buildSnippet('Qual o preço?', parseQuery('preco'))
    expect(short).toEqual({ text: 'Qual o preço?', ranges: [[7, 12]], cutStart: false, cutEnd: false })
  })
})
