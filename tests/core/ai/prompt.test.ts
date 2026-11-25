import { describe, expect, it } from 'vitest'
import type { MessageRow } from '../../../src/core/db/repo'
import { InvalidOutputError, buildPrompt, parseSuggestions } from '../../../src/core/ai/prompt'

function m(id: string, fromMe: boolean, over: Partial<MessageRow> = {}): MessageRow {
  return {
    id, jid: 'j', fromMe, ts: 1, kind: 'text', text: `texto ${id}`, mediaKeyJson: null, durationSec: null,
    audioPath: null, transcript: null, transcriptStatus: null,
    senderJid: null, senderName: null, senderLabel: null, mentionsMe: false, ...over
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

describe('buildPrompt em grupo', () => {
  it('cada mensagem com o nome de quem mandou; menção marcada; sistema focado no que pedem ao mentor', () => {
    const p = buildPrompt({
      contactName: 'Mentoria Turma 3',
      notes: null,
      isGroup: true,
      newMessages: [
        m('g1', false, { senderLabel: 'Bruno', text: 'Alguém tem o link da aula?' }),
        m('g2', false, { senderLabel: 'Carla', text: '@5547900000000 pode revisar meu pitch?', mentionsMe: true }),
        m('g3', false, { senderLabel: 'Carla', kind: 'audio', text: null, transcript: 'é rapidinho', transcriptStatus: 'done' }),
        m('g4', false, { senderLabel: null, text: 'sem nome' })
      ],
      priorMessages: [m('p1', true, { text: 'Bom dia, turma!' })],
      examples: []
    })
    expect(p.user).toContain('Grupo: Mentoria Turma 3')
    expect(p.user).toContain('Bruno: Alguém tem o link da aula?')
    expect(p.user).toContain('Carla (menciona você): @5547900000000 pode revisar meu pitch?')
    expect(p.user).toContain('Carla: [áudio transcrito] é rapidinho')
    expect(p.user).toContain('Participante: sem nome')
    expect(p.user).toContain('Mentor: Bom dia, turma!')
    expect(p.user).not.toContain('Mentorado:')
    expect(p.system).toContain('pt-BR')
    expect(p.system).toContain('grupo')
    expect(p.system).toMatch(/pedidos|perguntas/)
    expect(p.system).toContain('"resumo"')
    expect(p.system).toContain('[áudio ainda sendo transcrito]')
  })

  it('individual continua igual (sem nome de remetente)', () => {
    const p = buildPrompt({ contactName: 'Ana', notes: null, newMessages: [m('a', false, { senderLabel: 'X' })], priorMessages: [], examples: [] })
    expect(p.user).toContain('Mentorado: Ana')
    expect(p.user).toContain('Mentorado: texto a')
    expect(p.system).not.toContain('grupo')
  })
})
