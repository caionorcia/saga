import { beforeEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../../src/core/clock'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { CostTracker } from '../../../src/core/ai/budget'
import { generateAnalysis, knowledgeQuery, type LlmProvider } from '../../../src/core/ai/llm'
import { buildPrompt } from '../../../src/core/ai/prompt'
import { importArchive, importPastedText } from '../../../src/core/kb/importer'
import { LIMITS, RateLimiter } from '../../../src/core/queue/limiter'
import { demoPackageZip } from '../kb/fixtures'

const T0 = 1_700_000_000_000
const JID = '5547999990002@s.whatsapp.net'
const GOOD = JSON.stringify({ resumo: 'Quer saber de pacotes', sugestoes: ['Oi!', 'Conta mais?'] })

let clock: FakeClock
let repo: Repo

function fakeLlm() {
  const calls: Array<{ system: string; user: string }> = []
  const llm: LlmProvider = {
    name: 'groq',
    async complete(p) {
      calls.push(p)
      return { text: GOOD, inputTokens: 10, outputTokens: 5 }
    }
  }
  return { llm, calls }
}

function deps(llm: LlmProvider, diag?: (k: string, d: string) => void) {
  return {
    repo,
    llm,
    limiter: new RateLimiter(LIMITS.llm, clock, () => 0),
    cost: new CostTracker(repo, clock),
    capUsd: 1,
    clock,
    sleep: async (ms: number) => clock.advance(ms),
    diag
  }
}

const msg = (jid: string, id: string, fromMe: boolean, text: string, sec: number) =>
  repo.insertMessage({ id, jid, fromMe, ts: T0 + sec * 1000, kind: 'text', text, mediaKeyJson: null, durationSec: null })

beforeEach(() => {
  clock = new FakeClock(T0)
  repo = new Repo(openDb(':memory:'), clock)
  repo.upsertContact({ jid: JID, pushName: 'Lia' })
  msg(JID, 'm1', true, 'Oi Lia, tudo certo?', 1)
  msg(JID, 'm2', false, 'Mentor, como eu apresento o preço dos pacotes pro cliente?', 2)
})

describe('buildPrompt com a base', () => {
  const base = { contactName: 'Lia', notes: null, newMessages: [], priorMessages: [], examples: [] }

  it('sem base: o pedido não muda', () => {
    expect(buildPrompt(base).system).toBe(buildPrompt({ ...base, knowledge: null }).system)
    expect(buildPrompt(base).system).not.toContain('Base de conhecimento')
  })

  it('regras no sistema (com as instruções de sigilo) e trechos no pedido; interno sem trilha', () => {
    const p = buildPrompt({
      ...base,
      knowledge: {
        rules: 'Postura:\n- Fale curto.',
        chunks: [
          { chunkId: 1, kind: 'conhecimento', breadcrumb: 'Pacote › Preços › Três pacotes', text: 'Monte três pacotes.' },
          { chunkId: 2, kind: 'interno', breadcrumb: 'Pacote › Bastidores › Turma', text: 'Anotação interna.' }
        ]
      }
    })
    expect(p.system).toContain('Regras do método:\nPostura:\n- Fale curto.')
    expect(p.system).toContain('Sem bastidor')
    expect(p.system).toContain('vou confirmar e te retorno')
    expect(p.system).toMatch(/imitando o tom/)
    expect(p.user).toContain('[Conhecimento: Pacote › Preços › Três pacotes]\nMonte três pacotes.')
    expect(p.user).toContain('[Orientação interna: não citar]\nAnotação interna.')
    expect(p.user).not.toContain('Bastidores')
  })

  it('grupo também recebe a base', () => {
    const p = buildPrompt({ ...base, isGroup: true, knowledge: { rules: 'R:\n- x', chunks: [] } })
    expect(p.system).toContain('participa de grupos')
    expect(p.system).toContain('Regras do método:\nR:\n- x')
  })
})

describe('generateAnalysis com a base', () => {
  it('sem base: sem fontes e sem o bloco da base', async () => {
    const { llm, calls } = fakeLlm()
    const a = await generateAnalysis(deps(llm), JID)
    expect(a.sources).toEqual([])
    expect(calls[0].system).not.toContain('Base de conhecimento')
  })

  it('usa os trechos das mensagens novas do contato, guarda só os de conhecimento e registra só contagens', async () => {
    repo.kb.replacePackage(importArchive(demoPackageZip(), 'p.zip'))
    repo.kb.upsertManualFiles(importPastedText('Bastidor de pacotes', '# Pacotes da turma\n\nO pacote da Joana Prado saiu por R$ 4.000; o preço do essencial ficou menor.'))
    const { llm, calls } = fakeLlm()
    const logs: string[] = []
    const a = await generateAnalysis(deps(llm, (k, d) => logs.push(`${k} ${d}`)), JID)
    expect(calls[0].system).toContain('Regras do método:')
    expect(calls[0].user).toContain('[Conhecimento: Metodo Exemplo › Pacotes de preco › Como apresentar o preço]')
    expect(calls[0].user).toContain('[Orientação interna: não citar]')
    expect(a.sources!.length).toBeGreaterThan(0)
    expect(a.sources!.every((s) => s.breadcrumb.startsWith('Metodo Exemplo › '))).toBe(true)
    expect(repo.getAnalysis(JID)!.sources).toEqual(a.sources)
    const kb = logs.find((l) => l.startsWith('kb_used'))!
    expect(kb).toMatch(/^kb_used regras=\d+ caracteres, trechos=\d+ \(conhecimento=\d+, interno=\d+\)$/)
    expect(logs.join('\n')).not.toMatch(/pacote|preço|Joana/i)
  })

  it('a consulta usa só as mensagens do contato (sem novas, as 3 últimas dele)', () => {
    const m = (fromMe: boolean, text: string) => ({ fromMe, kind: 'text', text, transcriptStatus: null, transcript: null }) as never
    expect(knowledgeQuery([m(false, 'a'), m(false, 'b')], [])).toBe('a\nb')
    expect(knowledgeQuery([], [m(false, 'x'), m(true, 'eu'), m(false, 'y')])).toBe('x\ny')
    expect(knowledgeQuery([], [])).toBe('')
  })

  it('base quebrada não derruba a sugestão', async () => {
    repo.kb.replacePackage(importArchive(demoPackageZip(), 'p.zip'))
    ;(repo.kb as unknown as { ruleChunks: () => never }).ruleChunks = () => {
      throw new Error('falhou')
    }
    const { llm, calls } = fakeLlm()
    const logs: string[] = []
    const a = await generateAnalysis(deps(llm, (k, d) => logs.push(`${k} ${d}`)), JID)
    expect(a.summary).toBe('Quer saber de pacotes')
    expect(calls[0].system).not.toContain('Base de conhecimento')
    expect(logs).toContain('kb_error Error')
  })
})
