import { beforeEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../../src/core/clock'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { JobQueue, type JobType } from '../../../src/core/queue/queue'
import { LIMITS, RateLimiter } from '../../../src/core/queue/limiter'
import type { NormalizedMessage } from '../../../src/core/types'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const T0 = 1_700_000_000_000

function makeLimiters(clock: FakeClock, repo?: Repo): Record<JobType, RateLimiter> {
  const p = (k: string) => (repo ? { repo, key: `limiter:${k}` } : undefined)
  return {
    download_audio: new RateLimiter(LIMITS.wa_media, clock, () => 0, p('wa_media')),
    transcribe: new RateLimiter(LIMITS.groq_audio, clock, () => 0, p('groq_audio')),
    fetch_profile: new RateLimiter(LIMITS.wa_profile, clock, () => 0, p('wa_profile'))
  }
}

describe('JobQueue', () => {
  let clock: FakeClock
  let repo: Repo
  let q: JobQueue
  let ran: string[]

  beforeEach(() => {
    clock = new FakeClock(T0)
    repo = new Repo(openDb(':memory:'), clock)
    q = new JobQueue(repo, clock, makeLimiters(clock, repo))
    ran = []
    q.register('download_audio', async (p) => {
      ran.push(String((p as any).id))
    })
  })

  it('500 downloads sem avançar o relógio: exatamente 1 roda, o resto espera', async () => {
    for (let i = 0; i < 500; i++) q.enqueue('download_audio', `k${i}`, { id: i })
    const results: string[] = []
    for (let i = 0; i < 50; i++) results.push(await q.tick())
    expect(results.filter((r) => r === 'ran')).toHaveLength(1)
    expect(results.filter((r) => r === 'waiting')).toHaveLength(49)
    expect(ran).toHaveLength(1)
    expect(q.stats().pending).toBe(499)
  })

  it('chave duplicada é ignorada', () => {
    q.enqueue('download_audio', 'k', { id: 1 })
    q.enqueue('download_audio', 'k', { id: 2 })
    expect(q.stats().pending).toBe(1)
  })

  it('idle quando não há nada', async () => {
    expect(await q.tick()).toBe('idle')
  })

  it('pause devolve paused e resume volta', async () => {
    q.enqueue('download_audio', 'a', { id: 1 })
    q.pause()
    expect(q.isPaused()).toBe(true)
    expect(await q.tick()).toBe('paused')
    expect(q.stats().paused).toBe(true)
    q.resume()
    expect(await q.tick()).toBe('ran')
  })

  it('prioridade: priority=10 enfileirado depois roda antes; empate pelo mais antigo', async () => {
    q.enqueue('download_audio', 'a', { id: 'a' })
    q.enqueue('download_audio', 'b', { id: 'b' })
    q.enqueue('download_audio', 'c', { id: 'c' }, 10)
    for (let i = 0; i < 3; i++) {
      expect(await q.tick()).toBe('ran')
      clock.advance(20_000)
    }
    expect(ran).toEqual(['c', 'a', 'b'])
  })

  it('tipos independentes: se o limitador de um bloqueia, tenta o próximo tipo', async () => {
    q.register('fetch_profile', async (p) => {
      ran.push('profile')
    })
    q.enqueue('download_audio', 'a', { id: 'a' })
    q.enqueue('download_audio', 'b', { id: 'b' })
    q.enqueue('fetch_profile', 'p', {})
    expect(await q.tick()).toBe('ran') // a
    expect(await q.tick()).toBe('ran') // b bloqueado -> profile
    expect(await q.tick()).toBe('waiting')
    expect(ran).toEqual(['a', 'profile'])
  })

  it('transcribe registra o custo de payload.durationSec (mín. 10 s)', async () => {
    const limiters = makeLimiters(clock, repo)
    q = new JobQueue(repo, clock, limiters)
    q.register('transcribe', async () => {})
    q.enqueue('transcribe', 't', { durationSec: 3 })
    expect(await q.tick()).toBe('ran')
    const stored = JSON.parse(repo.getSetting('limiter:groq_audio')!)
    expect(stored[0][2]).toBe(10)
  })

  it('falha 3 vezes: backoff 30 s / 2 min / 10 min e então failed; retryFailed volta a pending', async () => {
    q.register('fetch_profile', async () => {
      throw new Error('boom')
    })
    q.enqueue('fetch_profile', 'p', {})
    expect(await q.tick()).toBe('ran')
    expect(q.stats().pending).toBe(1)
    clock.advance(29_000)
    expect(await q.tick()).toBe('idle') // em backoff: nenhum job elegível
    clock.advance(1_000)
    expect(await q.tick()).toBe('ran')
    clock.advance(119_000)
    expect(await q.tick()).toBe('idle')
    clock.advance(1_000)
    expect(await q.tick()).toBe('ran')
    expect(q.stats()).toMatchObject({ pending: 0, failed: 1 })
    const failed = repo.listJobs('failed')[0]
    expect(failed.attempts).toBe(3)
    expect(failed.lastError).toContain('boom')
    q.retryFailed(failed.id)
    expect(q.stats()).toMatchObject({ pending: 1, failed: 0 })
  })

  it('recuperação após queda: running volta a pending e o handler idempotente não duplica', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'saga-q-'))
    const file = join(dir, 'saga.db')
    const db1 = openDb(file)
    const repo1 = new Repo(db1, clock)
    const m: NormalizedMessage = {
      id: 'm1', jid: 'x@s.whatsapp.net', fromMe: false, ts: 1, kind: 'audio',
      text: null, mediaKeyJson: null, durationSec: 30
    }
    repo1.upsertContact({ jid: m.jid })
    repo1.insertMessage(m)
    let setTranscriptCalls = 0
    const handlerFor = (r: Repo) => async () => {
      if (r.listMessages(m.jid).find((x) => x.id === 'm1')?.transcript != null) return // idempotente
      setTranscriptCalls++
      r.setTranscript('m1', 'olá', 'done')
    }
    const q1 = new JobQueue(repo1, clock, makeLimiters(clock, repo1))
    q1.register('transcribe', async () => {
      throw new Error('simulado')
    })
    // simula queda: job fica 'running' sem terminar
    q1.enqueue('transcribe', 'tr:m1', { messageId: 'm1', durationSec: 30 })
    repo1.markJobRunning(repo1.listJobs('pending')[0].id)
    expect(q1.stats().running).toBe(1)
    db1.close()

    const repo2 = new Repo(openDb(file), clock)
    const q2 = new JobQueue(repo2, clock, makeLimiters(clock, repo2))
    q2.register('transcribe', handlerFor(repo2))
    expect(q2.recoverAfterCrash()).toBe(1)
    expect(await q2.tick()).toBe('ran')
    expect(q2.stats()).toMatchObject({ done: 1, pending: 0, running: 0 })
    // reexecução do mesmo trabalho (ex.: segundo disparo) não duplica
    await handlerFor(repo2)()
    expect(setTranscriptCalls).toBe(1)
    expect(repo2.listMessages(m.jid).find((x) => x.id === 'm1')?.transcript).toBe('olá')
  })

  it('start/stop: o laço roda jobs sem girar em falso', async () => {
    const { systemClock } = await import('../../../src/core/clock')
    const rq = new JobQueue(repo, systemClock, {
      download_audio: new RateLimiter({ ...LIMITS.wa_media, minGapMs: 0, maxGapMs: 0 }, systemClock),
      transcribe: new RateLimiter(LIMITS.groq_audio, systemClock),
      fetch_profile: new RateLimiter(LIMITS.wa_profile, systemClock)
    })
    let n = 0
    rq.register('download_audio', async () => {
      n++
    })
    rq.start()
    rq.enqueue('download_audio', 'a', {})
    await new Promise((r) => setTimeout(r, 300))
    await rq.stop()
    expect(n).toBe(1)
  })
})
