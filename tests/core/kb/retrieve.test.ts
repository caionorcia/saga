import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import type { KbRuleChunk } from '../../../src/core/db/kbRepo'
import { importArchive, importPastedText } from '../../../src/core/kb/importer'
import { KB_RULES_MAX, buildRulesBlock, buildRulesReport, ftsExpression, knowledgeFor, pickChunks, queryTerms, sourcesOf, stem } from '../../../src/core/kb/retrieve'
import { demoPackageZip } from './fixtures'

let repo: Repo
beforeEach(() => {
  repo = new Repo(openDb(':memory:'))
})

describe('consulta', () => {
  it('tira palavras vazias e acentos, usa radicais e sinônimos comuns', () => {
    expect(queryTerms('Oi mentor, tudo bem? Quanto eu cobro pelos pacotes? Obrigada!')).toEqual(['cobr', 'preco', 'valor', 'pacot'])
    expect(queryTerms('Vou mandar no zap')).toEqual(['mandar', 'zap', 'whatsapp'].map(stem))
    expect(queryTerms('ok, obrigado 🙏')).toEqual([])
    expect(stem('apresentacoes')).toBe('apresent')
    expect(stem('preco')).toBe('preco')
    expect(stem('fecho')).toBe('fech')
    expect(ftsExpression(['pacot', 'preco'])).toBe('"pacot"* OR "preco"*')
    expect(ftsExpression([])).toBeNull()
  })
})

describe('pickChunks', () => {
  beforeEach(() => {
    repo.kb.replacePackage(importArchive(demoPackageZip(), 'p.zip'))
  })

  it('acha o trecho certo, com a trilha, e nunca usa desligado nem regras', () => {
    const picks = pickChunks(repo.kb, 'Mentor, como eu apresento o preço dos pacotes pro cliente?')
    expect(picks[0]).toMatchObject({ kind: 'conhecimento', breadcrumb: 'Metodo Exemplo › Pacotes de preco › Como apresentar o preço' })
    const all = pickChunks(repo.kb, 'ganchos de anúncio, postura nas mensagens, vocabulário, pacotes')
    expect(all.some((p) => /Ganchos|Postura|Vocabul/.test(p.breadcrumb))).toBe(false)
  })

  it('precisa de 2 termos da consulta no trecho (com consulta de 2+ termos) e respeita top-k e o limite de caracteres', () => {
    expect(pickChunks(repo.kb, 'Você recomenda um contador para abrir empresa?')).toEqual([])
    const picks = pickChunks(repo.kb, 'pacotes preço reunião cliente valor conversa objetivo resultado', { topK: 2 })
    expect(picks.length).toBeLessThanOrEqual(2)
    const capped = pickChunks(repo.kb, 'pacotes preço reunião cliente valor conversa objetivo resultado', { maxChars: 450 })
    expect(capped.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(450)
  })

  it('"conhecimento" vem antes de "interno"; trecho com dinheiro ou nomes vai como interno', () => {
    repo.kb.upsertManualFiles(
      importPastedText('Bastidor de pacotes', '# Pacotes da turma\n\nO pacote completo da Joana Prado saiu por R$ 4.000 e o preço do essencial ficou menor.')
    )
    const picks = pickChunks(repo.kb, 'Qual o preço dos pacotes completo e essencial?')
    const kinds = picks.map((p) => p.kind)
    expect(kinds).toContain('interno')
    expect(kinds.indexOf('conhecimento')).toBeLessThan(kinds.indexOf('interno'))
    expect(sourcesOf({ rules: '', chunks: picks }).every((s) => !/Bastidor/.test(s.breadcrumb))).toBe(true)
  })

  it('no máximo um trecho interno, e seção que se diz interna vai como interno', () => {
    repo.kb.upsertManualFiles(importPastedText('Notas A', '# Ficha do mentorado (interna)\n\nPacotes e preço combinados na ficha, com observações gerais da turma.'))
    repo.kb.upsertManualFiles(importPastedText('Notas B', '# Pacotes\n\nPreço dos pacotes da Joana Prado, do Breno Matos e da Lia Torres.'))
    const picks = pickChunks(repo.kb, 'preço dos pacotes da turma')
    expect(picks.filter((p) => p.kind === 'interno')).toHaveLength(1)
    expect(picks.some((p) => p.kind === 'conhecimento' && /Notas/.test(p.breadcrumb))).toBe(false)
  })
})

describe('regras', () => {
  const rule = (o: Partial<KbRuleChunk>): KbRuleChunk => ({ fileId: 1, path: 'regras.md', title: 'Regras', ord: 0, heading: 'Postura', text: '- Fale curto.', sensitive: false, ...o })

  it('arquivos de regras primeiro (postura antes de vocabulário), depois a descrição do SKILL.md; sem checklist, casos, dinheiro', () => {
    const block = buildRulesBlock([
      rule({ ord: 0, heading: 'Vocabulário', text: '- "cliente ideal"' }),
      rule({ ord: 1, heading: 'Postura nas mensagens', text: '- Fale curto.\n- **Termine** com pergunta.' }),
      rule({ ord: 2, heading: 'Checklist final', text: '- [ ] Revisou?' }),
      rule({ ord: 3, heading: 'Casos que podem ser citados', text: 'Fulano.' }),
      rule({ ord: 4, heading: 'Contas', text: 'Caixa de R$ 5 mil.', sensitive: true }),
      rule({ ord: 5, heading: 'O que a IA faz quando não sabe', text: 'Manda perguntar para outra pessoa.' }),
      rule({ fileId: 2, path: 'skills/metodo/SKILL.md', title: 'Metodo (SKILL)', heading: 'Descrição', text: 'Atende mentorados.' }),
      rule({ fileId: 2, path: 'skills/metodo/SKILL.md', title: 'Metodo (SKILL)', ord: 1, heading: 'Passos', text: 'Leia tudo.' }),
      rule({ fileId: 3, path: 'INSTRUCOES.md', title: 'INSTRUCOES', heading: 'Tom de voz', text: 'Próximo e direto.' }),
      rule({ fileId: 3, path: 'INSTRUCOES.md', title: 'INSTRUCOES', ord: 1, heading: 'Fluxo da entrega', text: 'Primeiro extraia.' })
    ])
    expect(block).toBe('Postura nas mensagens:\n- Fale curto.\n- Termine com pergunta.\n\nVocabulário:\n- "cliente ideal"\n\nO que a IA faz quando não sabe:\nManda perguntar para outra pessoa.\n\nMetodo:\nAtende mentorados.\n\nTom de voz:\nPróximo e direto.')
  })

  it('usa seções inteiras: o que não cabe é pulado (tenta a próxima, menor) e nada é cortado no meio', () => {
    const big = Array.from({ length: 60 }, (_, i) => `- regra grande número ${i}, lorem ipsum dolor sit amet`).join('\n')
    const block = buildRulesBlock(
      [rule({ ord: 0, heading: 'Regras de postura', text: '- Fale curto.' }), rule({ ord: 1, heading: 'Regras enormes', text: big }), rule({ ord: 2, heading: 'Vocabulário', text: '- "cliente ideal"' })],
      600
    )
    expect(block).toBe('Regras de postura:\n- Fale curto.\n\nVocabulário:\n- "cliente ideal"')
    const all = buildRulesBlock([rule({ ord: 0, heading: 'Regras enormes', text: big })], 6_000)
    expect(all.length).toBeLessThanOrEqual(KB_RULES_MAX)
    expect(all.endsWith('amet')).toBe(true)
    expect(KB_RULES_MAX).toBe(6_000)
  })

  it('junta as partes de uma seção longa e tira a sobreposição', () => {
    const parts = ['- regra A\n- regra B', '…regra B\n\n- regra C']
    const block = buildRulesBlock(parts.map((text, i) => rule({ ord: i, heading: `Regras de postura (parte ${i + 1})`, text })))
    expect(block).toBe('Regras de postura:\n- regra A\n- regra B\n- regra C')
  })

  it('prioridade: regras/postura/vocabulário/palavras/bastidor/"quando não sabe" antes das outras seções do arquivo', () => {
    const block = buildRulesBlock([
      rule({ ord: 0, heading: 'Contexto geral', text: 'Fundamentos do método.' }),
      rule({ ord: 1, heading: 'Palavras que usamos', text: '- cliente ideal' }),
      rule({ ord: 2, heading: 'Sem bastidor', text: '- Não conte bastidor.' }),
      rule({ ord: 3, heading: 'Quando não souber', text: '- Diga que vai confirmar.' })
    ])
    expect(block.split('\n\n').map((p) => p.split(':')[0])).toEqual(['Sem bastidor', 'Palavras que usamos', 'Quando não souber', 'Contexto geral'])
  })

  it('nunca inclui exemplos com dados reais: título de exemplo/caso/depoimento, dinheiro ou vários nomes', () => {
    const rep = buildRulesReport([
      rule({ ord: 0, heading: 'Contas de exemplo', text: '- Faturou bastante.' }),
      rule({ ord: 1, heading: 'Casos de sucesso', text: '- Foi ótimo.' }),
      rule({ ord: 2, heading: 'Depoimentos', text: '- Recomendo.' }),
      rule({ ord: 3, heading: 'Regras de preço', text: '- Cobre R$ 1.500 por mês.' }),
      rule({ ord: 4, heading: 'Regras de turma', text: 'Falar com Maria Silva, João Souza e Pedro Alves.' }),
      rule({ ord: 5, heading: 'Regras de tom', text: '- Fale curto.' })
    ])
    expect(rep.block).toBe('Regras de tom:\n- Fale curto.')
    expect(rep.included).toEqual(['regras.md › Regras de tom'])
    expect(rep.skipped.map((x) => x.section)).toHaveLength(5)
  })

  it('seções repetidas entre arquivos (INSTRUCOES e SKILL) entram uma vez só', () => {
    const text = '- Fale curto.\n- Termine com uma pergunta.\n- Não use jargão de marketing.'
    const block = buildRulesBlock([
      rule({ fileId: 1, path: 'regras.md', heading: 'Regras de postura', text }),
      rule({ fileId: 3, path: 'INSTRUCOES.md', title: 'INSTRUCOES', heading: 'Regras de tom', text: `${text}\n- Use o nome da pessoa.` }),
      rule({ fileId: 3, path: 'INSTRUCOES.md', title: 'INSTRUCOES', ord: 1, heading: 'Regras de escrita', text: '- Parágrafos de uma frase.' })
    ])
    expect(block.match(/Fale curto/g)).toHaveLength(1)
    expect(block).toContain('Regras de escrita:')
  })

  it('knowledgeFor: null sem base em uso; com base, regras + trechos', () => {
    expect(knowledgeFor(repo.kb, 'preço dos pacotes')).toBeNull()
    repo.kb.replacePackage(importArchive(demoPackageZip(), 'p.zip'))
    const k = knowledgeFor(repo.kb, 'Como eu apresento o preço dos pacotes?')!
    expect(k.rules).toContain('Postura nas mensagens:')
    expect(k.rules).not.toContain('Checklist')
    expect(k.rules).toContain('Metodo:\nAtende mentorados no método exemplo')
    expect(k.chunks.length).toBeGreaterThan(0)
  })
})
