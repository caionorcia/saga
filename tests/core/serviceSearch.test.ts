import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock } from '../../src/core/clock'
import { openDb } from '../../src/core/db/db'
import { Repo } from '../../src/core/db/repo'
import { SettingsStore, type Cipher } from '../../src/core/settings'
import { SagaService, type WaClientLike } from '../../src/core/service'
import type { LlmProvider } from '../../src/core/ai/llm'

const NOW = 1_764_000_000_000
const ANA = '5547911110000@s.whatsapp.net'
const BIA = '5547922220000@s.whatsapp.net'
const KEY = 'gsk_FAKE_SEGREDO_busca'
const cipher: Cipher = { isAvailable: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => Buffer.from(b).toString() }
const fakeWa = (): WaClientLike => ({ on: () => undefined, start: async () => {}, stop: async () => {} }) as unknown as WaClientLike
const GOOD = JSON.stringify({ resumo: 'Quer saber o preço', sugestoes: ['Oi! Custa R$ 100.', 'Claro, te explico.'] })

describe('SagaService: busca geral e sugestões só quando precisa', () => {
  let tmp: string
  let repo: Repo
  let service: SagaService
  let diag: string[]
  let llm: LlmProvider & { calls: Array<{ system: string; user: string; schema?: unknown }> }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'saga-svc-search-'))
    const clock = new FakeClock(NOW)
    repo = new Repo(openDb(':memory:'), clock)
    diag = []
    const calls: Array<{ system: string; user: string; schema?: unknown }> = []
    llm = {
      name: 'groq',
      calls,
      complete: vi.fn(async (p) => {
        calls.push(p)
        return p.schema
          ? { text: JSON.stringify({ resposta: 'Ana Teste perguntou sobre precificação.', conversas: ['Ana Teste'] }), inputTokens: 5, outputTokens: 5 }
          : { text: GOOD, inputTokens: 5, outputTokens: 5 }
      })
    }
    const settings = new SettingsStore(repo, cipher)
    settings.save({ groqKey: KEY })
    service = new SagaService({
      repo,
      settings,
      clock,
      rng: () => 0,
      paths: { authDir: join(tmp, 'auth'), backupDir: join(tmp, 'bk'), mediaDir: join(tmp, 'media') },
      hasFreeSpace: async () => true,
      waClientFactory: fakeWa,
      llmFactory: () => llm,
      diag: (k: string, d: string) => diag.push(`${k} ${d}`)
    } as never)
    repo.upsertContact({ jid: ANA, pushName: 'Ana Teste' })
    repo.upsertContact({ jid: BIA, pushName: 'Bia Exemplo' })
    const base = { kind: 'text' as const, mediaKeyJson: null, durationSec: null }
    repo.insertMessage({ ...base, id: 'a1', jid: ANA, fromMe: false, ts: NOW - 60_000, text: 'Como faço a precificação do pacote?' })
    repo.insertMessage({ ...base, id: 'b1', jid: BIA, fromMe: false, ts: NOW - 120_000, text: 'Precificação me tira o sono' })
    repo.insertMessage({ ...base, id: 'b2', jid: BIA, fromMe: true, ts: NOW - 100_000, text: 'Vamos ver isso na sessão.' })
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('searchMessages: agrupa e registra só contagens (nunca o texto procurado)', async () => {
    const r = await service.searchMessages('quem falou sobre precificação?', {})
    expect(r.total).toBe(2)
    expect(r.groups.map((g) => g.name).sort()).toEqual(['Ana Teste', 'Bia Exemplo'])
    const log = diag.join('\n')
    expect(log).toMatch(/^search palavras=1 modo=and conversas=2 mensagens=2 ms=\d+/m)
    expect(log).not.toMatch(/precifica/i)
  })

  it('summarizeSearch: manda os trechos à IA das sugestões e devolve as referências; sem chave, não chama', async () => {
    const r = await service.summarizeSearch('quem falou sobre precificação?', {})
    expect(r).toMatchObject({ ok: true, answer: 'Ana Teste perguntou sobre precificação.', refs: [{ jid: ANA, name: 'Ana Teste' }], used: 2 })
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0].user).toContain('Precificação me tira o sono')
    expect(diag.join('\n')).not.toMatch(/tira o sono|Ana Teste/)
    expect(await service.summarizeSearch('xilofone', {})).toMatchObject({ ok: false, code: 'no_results' })
    new SettingsStore(repo, cipher).save({ groqKey: '' })
    expect(await service.summarizeSearch('precificação', {})).toMatchObject({ ok: false, code: 'missing_key' })
    expect(llm.calls).toHaveLength(1)
  })

  it('getAnalysis({ onlyIfNeeded }): conversa que não precisa de resposta não chama a IA; sem a opção, gera', async () => {
    // Bia: o mentor falou por último
    expect(await service.getAnalysis(BIA, { onlyIfNeeded: true })).toMatchObject({ ok: false, code: 'not_needed' })
    expect(llm.calls).toHaveLength(0)
    const forced = await service.getAnalysis(BIA)
    expect(forced.ok).toBe(true)
    expect(llm.calls).toHaveLength(1)
    // com a análise válida guardada: mostra sem chamar de novo
    expect((await service.getAnalysis(BIA, { onlyIfNeeded: true })).ok).toBe(true)
    expect(llm.calls).toHaveLength(1)
    // Ana espera resposta: gera normalmente
    expect((await service.getAnalysis(ANA, { onlyIfNeeded: true })).ok).toBe(true)
    expect(llm.calls).toHaveLength(2)
    // "Não precisa responder" do mentor: a análise que já existe continua à mostra, sem chamar de novo
    await service.setNeedsReply(ANA, false, { code: 'encerrada' })
    expect((await service.getAnalysis(ANA, { onlyIfNeeded: true })).ok).toBe(true)
    expect(llm.calls).toHaveLength(2)
    repo.insertMessage({ kind: 'text', mediaKeyJson: null, durationSec: null, id: 'b3', jid: BIA, fromMe: false, ts: NOW - 50_000, text: 'Obrigada!' })
    // mensagem nova da Bia: volta a precisar e gera sozinho
    expect((await service.getAnalysis(BIA, { onlyIfNeeded: true })).ok).toBe(true)
    expect(llm.calls).toHaveLength(3)
  })
})
