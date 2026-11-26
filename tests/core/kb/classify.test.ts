import { describe, expect, it } from 'vitest'
import { classifyFiles, contentSignals, sensitiveChunk, warnedFiles } from '../../../src/core/kb/classify'
import { INTERNAL_MD, PRICES_MD, README_MD, RULES_MD } from './fixtures'

const roles = (files: Array<{ path: string; text: string }>) => classifyFiles(files).map((r) => r.role)

describe('classifyFiles', () => {
  it('papel inicial pelo nome, pelos avisos do LEIA-ME e pelo conteúdo', () => {
    const files = [
      { path: 'LEIA-ME.md', text: README_MD },
      { path: 'conhecimento/01-regras-e-tom.md', text: RULES_MD },
      { path: 'conhecimento/02-pacotes-de-preco.md', text: PRICES_MD },
      { path: 'conhecimento/05-bastidores.md', text: '# Bastidores\n\nTexto.' },
      { path: 'anuncios/01-modelos.md', text: '# Modelos\n\nTexto.' },
      { path: 'conhecimento/03-ganchos-de-video.md', text: '# Ganchos\n\nTexto.' },
      { path: 'conhecimento/04-trafego-e-anuncios.md', text: '# Tráfego\n\nQuando começar a anunciar.' },
      { path: 'skills/x/references/exemplos/caso-um.md', text: '# Caso\n\nTexto.' },
      { path: 'skills/x/exemplo-proposta.md', text: '# Proposta\n\nTexto.' },
      { path: 'skills/x/SKILL.md', text: '---\ndescription: d\n---\n# X' },
      { path: 'INSTRUCOES-DO-GPT.txt', text: 'Você é um assistente.' },
      { path: 'atendimentos.md', text: INTERNAL_MD }
    ]
    expect(roles(files)).toEqual([
      'desligado',
      'regras',
      'conhecimento',
      'interno',
      'desligado',
      'desligado',
      'conhecimento',
      'desligado',
      'interno',
      'regras',
      'regras',
      'interno'
    ])
    for (const r of classifyFiles(files)) expect(r.reason.length).toBeGreaterThan(5)
  })

  it('os avisos citam arquivos (só nas linhas que falam de material interno)', () => {
    const readme = '# Leia-me\n\n- `a/um.md` é o mapa.\n- `b/dois.md` e `tres.md` têm nomes reais de alunos: referência interna.\n- `quatro.md` (interno; traz preços de um cliente).'
    expect([...warnedFiles([{ path: 'LEIA-ME.md', text: readme }])].sort()).toEqual(['dois.md', 'quatro.md', 'tres.md'])
  })
})

describe('sinais de conteúdo', () => {
  it('conta nomes (fora de começo de frase, negrito e conceitos dos títulos) e valores', () => {
    const s = contentSignals('# Proposta Única\n\nA **Cliente Ideal** e a Proposta Única. Falei com a Joana Prado e o Breno Matos. Valor: R$ 1.500.')
    expect(s.nameList.sort()).toEqual(['Breno Matos', 'Joana Prado', 'Proposta Única'].sort())
    expect(contentSignals('# Proposta Única\n\nA Proposta Única.', new Set(['proposta unica'])).names).toBe(0)
    expect(s.currency).toBe(1)
  })
  it('trecho com dinheiro ou 3+ nomes é sensível', () => {
    expect(sensitiveChunk('O pacote custa R$ 900.')).toBe(true)
    expect(sensitiveChunk('Fale com a Joana Prado, o Breno Matos e a Lia Torres.')).toBe(true)
    expect(sensitiveChunk('Monte três pacotes, do mais completo ao essencial.')).toBe(false)
  })
})
