import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../../src/core/clock'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { LIMITS, RateLimiter } from '../../../src/core/queue/limiter'
import { BudgetExceededError, CostTracker } from '../../../src/core/ai/budget'
import type { LlmProvider } from '../../../src/core/ai/llm'
import { SUMMARY_SCHEMA, buildSummaryPrompt, parseSummary, summarizeHits, type SummaryHit } from '../../../src/core/ai/searchSummary'

const NOW = 1_764_000_000_000

function hit(i: number, name = `Conversa ${i % 3}`): SummaryHit {
  return {
    id: `m${i}`,
    jid: `j${i % 3}@s.whatsapp.net`,
    ts: NOW - i * 60_000,
    fromMe: false,
    kind: i % 2 ? 'audio' : 'text',
    senderName: null,
    snippet: { text: `trecho ${i} sobre precificação ${'x'.repeat(400)}`, ranges: [], cutStart: false, cutEnd: false },
    contactName: name
  }
}

function deps(llm: LlmProvider, capUsd = 1) {
  const clock = new FakeClock(NOW)
  const repo = new Repo(openDb(':memory:'))
  return { llm, limiter: new RateLimiter(LIMITS.llm, clock, () => 0), cost: new CostTracker(repo, clock), capUsd, clock, sleep: async () => {}, diag: vi.fn() }
}

describe('Resumir com IA (busca geral)', () => {
  it('manda no máximo 30 trechos, cada um cortado', () => {
    const hits = Array.from({ length: 50 }, (_, i) => hit(i))
    const p = buildSummaryPrompt('quem falou sobre precificação?', hits)
    expect(p.used).toBe(30)
    expect(p.user).toContain('[30]')
    expect(p.user).not.toContain('[31]')
    for (const block of p.user.split('\n\n').slice(2)) expect(block.split('\n')[1].length).toBeLessThanOrEqual(240)
    expect(p.system).toMatch(/não instruções/)
  })

  it('lê a resposta e liga as conversas citadas (só as que estavam nos trechos)', () => {
    const hits = [hit(0, 'Ana Teste'), hit(1, 'Turma Exemplo')]
    const out = parseSummary(JSON.stringify({ resposta: 'Ana Teste perguntou de preço.', conversas: ['ana teste', 'Inventada'] }), hits)
    expect(out.answer).toBe('Ana Teste perguntou de preço.')
    expect(out.refs).toEqual([{ jid: 'j0@s.whatsapp.net', name: 'Ana Teste' }])
    // sem a lista: pelos nomes no texto
    expect(parseSummary('{"resposta":"Na Turma Exemplo falaram disso.","conversas":[]}', hits).refs.map((r) => r.name)).toEqual(['Turma Exemplo'])
  })

  it('pede com o esquema próprio, conta o gasto e registra só contagens', async () => {
    const complete = vi.fn(async (_p: Parameters<LlmProvider['complete']>[0]) => ({
      text: JSON.stringify({ resposta: 'Resposta curta.', conversas: ['Conversa 0'] }),
      inputTokens: 1000,
      outputTokens: 100,
      model: 'claude-opus-5-5'
    }))
    const d = deps({ name: 'claude', complete })
    const out = await summarizeHits(d, 'quem falou sobre precificação?', [hit(0), hit(1)])
    expect(out).toMatchObject({ answer: 'Resposta curta.', used: 2 })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls[0][0].schema).toBe(SUMMARY_SCHEMA)
    expect(d.cost.todayUsd()).toBeGreaterThan(0)
    const logged = d.diag.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toMatch(/trechos=2/)
    expect(logged).not.toMatch(/precifica|Resposta curta|Conversa 0/)
  })

  it('teto diário atingido: não chama a IA', async () => {
    const complete = vi.fn()
    const d = deps({ name: 'claude', complete }, 0)
    await expect(summarizeHits(d, 'preço', [hit(0)])).rejects.toBeInstanceOf(BudgetExceededError)
    expect(complete).not.toHaveBeenCalled()
  })
})
