import { describe, expect, it } from 'vitest'
import type { MessageRow } from '../../../src/core/db/repo'
import { InvalidOutputError, buildPrompt, parseSuggestions } from '../../../src/core/ai/prompt'

function m(id: string, fromMe: boolean, over: Partial<MessageRow> = {}): MessageRow {
  return {
    id, jid: 'j', fromMe, ts: 1, kind: 'text', text: `texto ${id}`, mediaKeyJson: null, durationSec: null,
    audioPath: null, transcript: null, transcriptStatus: null, ...over
  }
}

describe('buildPrompt', () => {
  it('não quebra sem exemplos nem notas; user contém as mensagens novas', () => {
    const p = buildPrompt({
      contactName: '+55 47 99999-0001', notes: null,
      newMessages: [m('n1', false, { text: 'Preciso de ajuda com preço' })], priorMessages: [], examples: []
    })
    expect(p.user).toContain('Preciso de ajuda com preço')
    expect(p.user).not.toContain('Notas')
    expect(p.system).toContain('pt-BR')
    expect(p.system).toContain('"resumo"')
    expect(p.system).toContain('"sugestoes"')
  })
  it('inclui nome, notas, exemplos e áudios', () => {
    const p = buildPrompt({
      contactName: 'Michael', notes: 'Vende cursos online',
      newMessages: [
        m('a', false, { kind: 'audio', text: null, transcript: 'oi mentor', transcriptStatus: 'done' }),
        m('b', false, { kind: 'audio', text: null, transcriptStatus: 'failed' })
      ],
      priorMessages: [m('p', true)],
      examples: [{ context: 'Qual o preço?', reply: 'Depende do plano.', source: 'similar' }]
    })
    expect(p.user).toContain('Michael')
    expect(p.user).toContain('Vende cursos online')
    expect(p.user).toContain('[áudio transcrito] oi mentor')
    expect(p.user).toContain('[áudio indisponível]')
    expect(p.user).toContain('Mensagem do mentorado: Qual o preço?')
    expect(p.user).toContain('Resposta do mentor: Depende do plano.')
  })
})

describe('buildPrompt áudio pendente', () => {
  it('áudio ainda sem transcrição aparece como "[áudio ainda sendo transcrito]", diferente de indisponível', () => {
    const p = buildPrompt({
      contactName: 'Ana', notes: null,
      newMessages: [
        m('a', false, { kind: 'audio', text: null, transcriptStatus: null }),
        m('b', false, { kind: 'audio', text: null, transcriptStatus: 'unavailable' })
      ],
      priorMessages: [], examples: []
    })
    expect(p.user).toContain('Mentorado: [áudio ainda sendo transcrito]')
    expect(p.user).toContain('Mentorado: [áudio indisponível]')
    expect(p.system).toContain('[áudio ainda sendo transcrito]')
  })
})

describe('buildPrompt truncamento', () => {
  it('corta contexto (500) e resposta (800) dos exemplos com reticências', () => {
    const p = buildPrompt({
      contactName: 'x', notes: null, newMessages: [m('n', false)], priorMessages: [],
      examples: [{ context: 'c'.repeat(2000), reply: 'r'.repeat(2000), source: 'recent' }]
    })
    expect(p.user).toContain('c'.repeat(500) + '…')
    expect(p.user).not.toContain('c'.repeat(501))
    expect(p.user).toContain('r'.repeat(800) + '…')
    expect(p.user).not.toContain('r'.repeat(801))
  })
})

describe('parseSuggestions', () => {
  it('aceita JSON em bloco ```json', () => {
    const r = parseSuggestions('```json\n{"resumo":"Quer ajuda","sugestoes":["a","b"]}\n```')
    expect(r).toEqual({ summary: 'Quer ajuda', suggestions: ['a', 'b'] })
  })
  it('aceita JSON puro e corta para 3', () => {
    const r = parseSuggestions(JSON.stringify({ resumo: 'x', sugestoes: ['1', '2', '3', '4', '5'] }))
    expect(r.suggestions).toEqual(['1', '2', '3'])
  })
  it('1 sugestão ou lixo lançam InvalidOutputError', () => {
    expect(() => parseSuggestions('{"resumo":"x","sugestoes":["só uma"]}')).toThrow(InvalidOutputError)
    expect(() => parseSuggestions('blá blá')).toThrow(InvalidOutputError)
    expect(() => parseSuggestions('{"resumo":1,"sugestoes":"x"}')).toThrow(InvalidOutputError)
  })
})
