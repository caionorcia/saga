import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../../src/core/clock'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { DEFAULT_JOB_TIMEOUTS_MS, DeferJobError, JobQueue, type JobType } from '../../../src/core/queue/queue'
import { LIMITS, RateLimiter } from '../../../src/core/queue/limiter'
import type { NormalizedMessage } from '../../../src/core/types'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const T0 = 1_700_000_000_000

function makeLimiters(clock: FakeClock, repo?: Repo): Partial<Record<JobType, RateLimiter>> {
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
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'saga-q-'))
    clock = new FakeClock(T0)
    repo = new Repo(openDb(':memory:'), clock)
    q = new JobQueue(repo, clock, makeLimiters(clock, repo))
    ran = []
    q.register('download_audio', async (p) => {
      ran.push(String((p as any).id))
    })
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
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

  it('falha 3 vezes: backoff 30 s e 2 min, falha definitiva na 3ª; retryFailed volta a pending', async () => {
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

  it('recuperação após queda: o trabalho feito antes da queda não é duplicado', async () => {
    const file = join(tmp, 'saga.db')
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
    // 1ª execução: faz o trabalho e "morre" antes de o job ser marcado como done
    const q1 = new JobQueue(repo1, clock, makeLimiters(clock, repo1))
    q1.register('transcribe', async () => {
      await handlerFor(repo1)()
      return new Promise<void>(() => {}) // nunca termina: a queda acontece aqui
    })
    q1.enqueue('transcribe', 'tr:m1', { messageId: 'm1', durationSec: 30 })
    void q1.tick()
    await new Promise((r) => setTimeout(r, 20))
    expect(q1.stats().running).toBe(1)
    expect(setTranscriptCalls).toBe(1)
    db1.close() // abandona a fila 1

    const db2 = openDb(file)
    const repo2 = new Repo(db2, clock)
    const q2 = new JobQueue(repo2, clock, makeLimiters(clock, repo2))
    q2.register('transcribe', handlerFor(repo2))
    expect(q2.recoverAfterCrash()).toBe(1)
    expect(await q2.tick()).toBe('idle') // a queda conta como falha: espera o backoff
    clock.advance(30_000)
    expect(await q2.tick()).toBe('ran')
    expect(q2.stats()).toMatchObject({ done: 1, pending: 0, running: 0 })
    expect(setTranscriptCalls).toBe(1)
    expect(repo2.listMessages(m.jid).find((x) => x.id === 'm1')?.transcript).toBe('olá')
    db2.close() // no Windows o arquivo aberto não pode ser apagado no afterEach
  })

  describe('send_message: nunca tenta de novo sozinho', () => {
    const withSend = () => {
      const lim = { ...makeLimiters(clock), send_message: new RateLimiter(LIMITS.wa_send, clock, () => 0) }
      return new JobQueue(repo, clock, lim)
    }

    it('um erro é definitivo na primeira vez (sem espera e nova tentativa)', async () => {
      const sq = withSend()
      let calls = 0
      const failed: string[] = []
      sq.onJobFailed((j) => failed.push(j.key))
      sq.register('send_message', async () => {
        calls++
        throw new Error('caiu')
      })
      sq.enqueue('send_message', 'send:1:1', { sendId: 1 })
      expect(await sq.tick()).toBe('ran')
      expect(failed).toEqual(['send:1:1'])
      clock.advance(24 * 3_600_000)
      expect(await sq.tick()).toBe('idle')
      expect(calls).toBe(1)
      expect(repo.jobCounts('send_message')).toMatchObject({ failed: 1, pending: 0 })
    })

    it('o app fechou com o envio rodando: falha definitiva, não volta para a fila', async () => {
      const sq = withSend()
      let calls = 0
      sq.register('send_message', async () => {
        calls++
      })
      sq.enqueue('send_message', 'send:2:1', { sendId: 2 })
      repo.markJobRunning(repo.nextPendingJob('send_message', clock.now())!.id)
      expect(sq.recoverAfterCrash()).toBe(1)
      clock.advance(24 * 3_600_000)
      expect(await sq.tick()).toBe('idle')
      expect(calls).toBe(0)
    })

    it('ready falso (envio anterior ainda no ar): não roda, não gasta vaga do limitador nem tentativa', async () => {
      const lim = new RateLimiter(LIMITS.wa_send, clock, () => 0)
      const sq = new JobQueue(repo, clock, { ...makeLimiters(clock), send_message: lim })
      let busy = true
      let calls = 0
      sq.register('send_message', async () => void calls++, { ready: () => !busy })
      sq.enqueue('send_message', 'send:9:1', { sendId: 9 })
      expect(await sq.tick()).toBe('idle')
      expect(sq.stats().nextRunAt).toBeNull()
      expect(lim.nextAllowedAt()).toBe(clock.now())
      busy = false
      sq.poke()
      expect(await sq.tick()).toBe('ran')
      expect(calls).toBe(1)
      expect(repo.jobCounts('send_message')).toMatchObject({ done: 1 })
    })

    it('tipo pausado (WhatsApp fora do ar) ou "Pausar tudo": nada roda; envios esperam 30–90 s entre si', async () => {
      const sq = withSend()
      const ran: number[] = []
      sq.register('send_message', async (p) => {
        ran.push((p as { sendId: number }).sendId)
      })
      sq.enqueue('send_message', 'send:1:1', { sendId: 1 })
      sq.enqueue('send_message', 'send:2:1', { sendId: 2 })
      sq.pause()
      expect(await sq.tick()).toBe('paused')
      sq.resume()
      sq.pauseType('send_message')
      expect(await sq.tick()).toBe('idle')
      sq.resumeType('send_message')
      expect(await sq.tick()).toBe('ran')
      expect(await sq.tick()).toBe('waiting')
      clock.advance(29_999)
      expect(await sq.tick()).toBe('waiting')
      clock.advance(1)
      expect(await sq.tick()).toBe('ran')
      expect(ran).toEqual([1, 2])
    })
  })

  it('job que derruba o app em laço vira failed na 3ª queda', () => {
    q.enqueue('download_audio', 'k', {})
    for (let i = 0; i < 3; i++) {
      clock.advance(10 * 60_000)
      const id = repo.nextPendingJob('download_audio', clock.now())!.id
      repo.markJobRunning(id)
      expect(q.recoverAfterCrash()).toBe(1)
    }
    expect(q.stats()).toMatchObject({ failed: 1, pending: 0, running: 0 })
  })

  it('durationSec inválido (NaN, Infinity, negativo) cai no mínimo de 10 s', async () => {
    q.register('transcribe', async () => {})
    for (const [i, d] of [NaN, Infinity, -5].entries()) {
      q.enqueue('transcribe', `t${i}`, { durationSec: d }, 0)
      clock.advance(10_000)
      expect(await q.tick()).toBe('ran')
    }
    const stored = JSON.parse(repo.getSetting('limiter:groq_audio')!)
    expect(stored.map((e: number[]) => e[2])).toEqual([10, 10, 10])
  })

  it('o intervalo recomeça quando o job termina', async () => {
    q.register('fetch_profile', async () => {})
    q = new JobQueue(repo, clock, makeLimiters(clock, repo))
    q.register('download_audio', async () => {
      clock.advance(10_000) // download demorado
    })
    q.enqueue('download_audio', 'a', {})
    q.enqueue('download_audio', 'b', {})
    expect(await q.tick()).toBe('ran')
    // 10 s se passaram durante o job; sem markFinished já estaria liberado (gap de 4 s)
    expect(await q.tick()).toBe('waiting')
    clock.advance(4000)
    expect(await q.tick()).toBe('ran')
  })

  it('não gira em falso quando há jobs pendentes de um tipo sem handler', async () => {
    vi.useFakeTimers()
    try {
      const spy = vi.spyOn(q, 'tick')
      q.enqueue('fetch_profile', 'p', {}) // sem handler registrado
      q.start()
      await vi.advanceTimersByTimeAsync(30_000)
      await q.stop()
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pauseType: o tipo pausado não roda, os outros sim; resumeType volta', async () => {
    const other: string[] = []
    q.register('fetch_profile', async (p) => {
      other.push(String((p as any).jid))
    })
    q.enqueue('download_audio', 'a', { id: 'a' }, 10)
    q.enqueue('fetch_profile', 'p', { jid: 'x' })
    q.pauseType('download_audio')
    expect(q.isTypePaused('download_audio')).toBe(true)
    expect(q.isPaused()).toBe(false)
    expect(await q.tick()).toBe('ran')
    expect(other).toEqual(['x'])
    expect(ran).toEqual([])
    clock.advance(60_000)
    expect(await q.tick()).toBe('idle')
    expect(q.stats().nextRunAt).toBeNull()
    q.resumeType('download_audio')
    expect(q.isTypePaused('download_audio')).toBe(false)
    expect(await q.tick()).toBe('ran')
    expect(ran).toEqual(['a'])
  })

  it('pauseType não gira em falso', async () => {
    vi.useFakeTimers()
    try {
      const spy = vi.spyOn(q, 'tick')
      q.enqueue('download_audio', 'a', { id: 'a' })
      q.pauseType('download_audio')
      q.start()
      await vi.advanceTimersByTimeAsync(30_000)
      await q.stop()
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2)
      expect(ran).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('mesma prioridade: roda primeiro a mensagem mais nova (payload.ts DESC); sem ts fica por último', async () => {
    q.enqueue('download_audio', 'velho', { id: 'velho', ts: 1_000 })
    q.enqueue('download_audio', 'semts', { id: 'semts' })
    q.enqueue('download_audio', 'novo', { id: 'novo', ts: 3_000 })
    q.enqueue('download_audio', 'meio', { id: 'meio', ts: 2_000 })
    q.enqueue('download_audio', 'urgente', { id: 'urgente', ts: 500 }, 10)
    for (let i = 0; i < 5; i++) {
      expect(await q.tick()).toBe('ran')
      clock.advance(20_000)
    }
    expect(ran).toEqual(['urgente', 'novo', 'meio', 'velho', 'semts'])
  })

  it('pauseTypeFor: pausa o tipo por um tempo e volta sozinho; resumeType/pauseType cancelam o timer', async () => {
    vi.useFakeTimers()
    try {
      q.pauseTypeFor('download_audio', 120_000)
      expect(q.isTypePaused('download_audio')).toBe(true)
      await vi.advanceTimersByTimeAsync(119_000)
      expect(q.isTypePaused('download_audio')).toBe(true)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(q.isTypePaused('download_audio')).toBe(false)
      // uma pausa sem prazo depois não é desfeita pelo timer antigo
      q.pauseTypeFor('download_audio', 1_000)
      q.pauseType('download_audio')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(q.isTypePaused('download_audio')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('DeferJobError devolve o job a pending sem gastar tentativa', async () => {
    q.register('download_audio', async () => {
      throw new DeferJobError('sem espaço', 5_000)
    })
    q.enqueue('download_audio', 'a', { id: 'a' })
    expect(await q.tick()).toBe('ran')
    const [j] = repo.listJobs('pending')
    expect(j.attempts).toBe(0)
    expect(j.nextRunAt).toBe(clock.now() + 5_000)
    expect(j.lastError).toBe('sem espaço')
  })

  it('onJobFailed: avisa só na falha definitiva (3ª tentativa), com o job e o payload', async () => {
    const failed: Array<{ type: string; payload: unknown; attempts: number }> = []
    const off = q.onJobFailed((j) => failed.push({ type: j.type, payload: j.payload, attempts: j.attempts }))
    q.register('fetch_profile', async () => {
      throw new Error('boom')
    })
    q.enqueue('fetch_profile', 'p', { jid: 'x' })
    await q.tick()
    clock.advance(30_000)
    await q.tick()
    expect(failed).toEqual([])
    clock.advance(120_000)
    await q.tick()
    expect(failed).toEqual([{ type: 'fetch_profile', payload: { jid: 'x' }, attempts: 3 }])
    off()
    q.retryFailed(repo.listJobs('failed')[0].id)
    await q.tick()
    clock.advance(30_000)
    await q.tick()
    clock.advance(120_000)
    await q.tick()
    expect(failed).toHaveLength(1)
  })

  it('onJobFailed: também na falha definitiva por queda (recoverAfterCrash); erro no ouvinte não quebra a fila', () => {
    const seen: number[] = []
    q.onJobFailed(() => {
      throw new Error('ouvinte com defeito')
    })
    q.onJobFailed((j) => seen.push(j.attempts))
    q.enqueue('download_audio', 'c', { id: 'c' })
    for (let i = 0; i < 3; i++) {
      const [j] = repo.listJobs('pending')
      repo.markJobRunning(j.id)
      expect(() => q.recoverAfterCrash()).not.toThrow()
    }
    expect(seen).toEqual([3])
  })

  it('onJobDone: avisa quando um job termina com sucesso', async () => {
    const done: unknown[] = []
    q.onJobDone((j) => done.push(j.payload))
    q.enqueue('download_audio', 'd', { id: 'd' })
    await q.tick()
    expect(done).toEqual([{ id: 'd' }])
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
  describe('prazo por tipo de job', () => {
    it('um handler que nunca resolve: depois do prazo conta como falha (com backoff) e o próximo job roda', async () => {
      const diag: string[] = []
      const tq = new JobQueue(repo, clock, makeLimiters(clock), {
        timeoutsMs: { download_audio: 30 },
        diag: (k, d) => diag.push(`${k} ${d}`)
      })
      let release: (() => void) | null = null
      let signal: AbortSignal | undefined
      const seen: string[] = []
      tq.register('download_audio', (p: { id: string }, s?: AbortSignal) => {
        seen.push(p.id)
        if (p.id === 'a') {
          signal = s
          return new Promise<void>((r) => (release = r))
        }
        return Promise.resolve()
      })
      const done: number[] = []
      tq.onJobDone((j) => done.push(j.id))
      tq.enqueue('download_audio', 'a', { id: 'a', ts: 2 })
      tq.enqueue('download_audio', 'b', { id: 'b', ts: 1 })
      expect(await tq.tick()).toBe('ran')
      expect(signal?.aborted).toBe(true)
      const [a] = repo.listJobs('pending').filter((j) => j.key === 'a')
      expect(a.attempts).toBe(1)
      expect(a.lastError).toMatch(/tempo esgotado/)
      expect(a.nextRunAt).toBe(clock.now() + 30_000)
      expect(diag.some((l) => l.startsWith('job_timeout download_audio'))).toBe(true)
      clock.advance(10_000)
      expect(await tq.tick()).toBe('ran')
      expect(seen).toEqual(['a', 'b'])
      expect(repo.listJobs('done').map((j) => j.key)).toEqual(['b'])
      // a resposta atrasada do job que estourou o prazo é ignorada
      release!()
      await new Promise((r) => setTimeout(r, 5))
      const after = repo.listJobs('pending').find((j) => j.key === 'a')!
      expect(after).toMatchObject({ status: 'pending', attempts: 1 })
      expect(done).toHaveLength(1)
    })

    it('estourar o prazo 3 vezes vira falha definitiva; rejeição atrasada não escapa', async () => {
      const tq = new JobQueue(repo, clock, makeLimiters(clock), { timeoutsMs: { fetch_profile: 10 } })
      const rejects: Array<(e: Error) => void> = []
      tq.register('fetch_profile', () => new Promise<void>((_, rej) => rejects.push(rej)))
      tq.enqueue('fetch_profile', 'p', {})
      for (const wait of [0, 30_000, 2 * 60_000]) {
        clock.advance(wait)
        expect(await tq.tick()).toBe('ran')
      }
      expect(repo.listJobs('failed')).toHaveLength(1)
      expect(repo.listJobs('failed')[0].attempts).toBe(3)
      for (const r of rejects) r(new Error('tarde'))
      await new Promise((r) => setTimeout(r, 5))
      expect(repo.listJobs('failed')[0].lastError).toMatch(/tempo esgotado/)
    })

    it('job que retoma depois de estourar o prazo: a resposta atrasada da 1ª tentativa não conclui a 2ª', async () => {
      const tq = new JobQueue(repo, clock, makeLimiters(clock), { timeoutsMs: { fetch_profile: 200 } })
      const releases: Array<() => void> = []
      tq.register('fetch_profile', () => new Promise<void>((r) => releases.push(r)))
      tq.enqueue('fetch_profile', 'p', {})
      expect(await tq.tick()).toBe('ran')
      clock.advance(30_000)
      // 2ª tentativa em andamento quando a 1ª responde
      const second = tq.tick()
      await new Promise((r) => setTimeout(r, 2))
      releases[0]()
      await new Promise((r) => setTimeout(r, 2))
      expect(repo.listJobs('running')).toHaveLength(1)
      releases[1]()
      expect(await second).toBe('ran')
      expect(repo.listJobs('done')).toHaveLength(1)
    })

    it('tipo sem limitador nunca roda (e não quebra o resumo)', async () => {
      const diag: string[] = []
      const tq = new JobQueue(repo, clock, makeLimiters(clock), { diag: (k, d) => diag.push(`${k} ${d}`) })
      let ran = 0
      tq.register('classify', async () => {
        ran++
      })
      tq.enqueue('classify', 'c', { jid: 'x' })
      expect(await tq.tick()).toBe('idle')
      expect(ran).toBe(0)
      expect(tq.stats().nextRunAt).toBeNull()
      tq.logSummary()
      expect(diag[0]).toMatch(/^queue_summary /)
    })

    it('prazos padrão: download 120 s, transcrição 180 s, perfil 60 s, alertas 90 s, envio 180 s, histórico 60 s', () => {
      expect(DEFAULT_JOB_TIMEOUTS_MS).toEqual({ download_audio: 120_000, transcribe: 180_000, fetch_profile: 60_000, classify: 90_000, send_message: 180_000, fetch_history: 60_000 })
    })
  })

  describe('diagnóstico', () => {
    it('registra início, sucesso (ms), falha, adiamento; nunca o payload', async () => {
      const diag: string[] = []
      const dq = new JobQueue(repo, clock, makeLimiters(clock), { diag: (k, d) => diag.push(`${k} ${d}`) })
      dq.register('download_audio', async () => {})
      dq.register('transcribe', async () => {
        throw new DeferJobError('sem chave', 1000)
      })
      dq.register('fetch_profile', async () => {
        throw new Error('falhou em https://mmg.whatsapp.net/v/t62/abc?token=SEGREDO')
      })
      dq.enqueue('download_audio', 'a', { id: 'SEGREDO-ID', text: 'conteúdo secreto' })
      dq.enqueue('transcribe', 't', { id: 'x', durationSec: 3 })
      dq.enqueue('fetch_profile', 'p', { jid: '5511999999999@s.whatsapp.net' })
      for (let i = 0; i < 3; i++) await dq.tick()
      const text = diag.join('\n')
      expect(text).toMatch(/job_start download_audio #\d+ tentativa 1/)
      expect(text).toMatch(/job_done download_audio #\d+ \d+ ms/)
      expect(text).toMatch(/job_deferred transcribe #\d+/)
      expect(text).toMatch(/job_failed fetch_profile #\d+ .*mmg\.whatsapp\.net/)
      expect(text).not.toMatch(/SEGREDO|conteúdo secreto|5511999999999/)
    })

    it('resumo da fila: contagens por tipo, pausas e próximo horário do limitador', () => {
      const diag: string[] = []
      const dq = new JobQueue(repo, clock, makeLimiters(clock), { diag: (k, d) => diag.push(`${k} ${d}`) })
      dq.register('download_audio', async () => {})
      dq.enqueue('download_audio', 'a', {})
      dq.enqueue('download_audio', 'b', {})
      dq.pauseType('download_audio')
      dq.logSummary()
      expect(diag).toHaveLength(1)
      expect(diag[0]).toMatch(/^queue_summary /)
      expect(diag[0]).toContain('download_audio: pending=2 running=0 done=0 failed=0')
      expect(diag[0]).toContain('paused_types=download_audio')
      expect(diag[0]).toContain('global_pause=no')
      expect(diag[0]).toMatch(/download_audio: .*next_allowed=(now|\+\d+s)/)
    })
  })
})

describe('relógio que anda a cada leitura (Windows: Date.now muda em 1 ms entre chamadas)', () => {
  it('o job roda: o limitador usa o mesmo "agora" da fila', async () => {
    // cada leitura do relógio avança 1 ms, como acontece no app de verdade
    let wall = 1_764_000_000_000
    const ticking = { now: () => ++wall, monotonic: () => wall - 1_764_000_000_000 }
    const repo = new Repo(openDb(':memory:'), ticking)
    const lim = (cfg: (typeof LIMITS)[keyof typeof LIMITS]) => new RateLimiter(cfg, ticking, () => 0)
    const q = new JobQueue(repo, ticking, {
      download_audio: lim(LIMITS.wa_media),
      transcribe: lim(LIMITS.groq_audio),
      fetch_profile: lim(LIMITS.wa_profile)
    })
    const ran: string[] = []
    q.register('download_audio', async (p) => {
      ran.push(String((p as { id: string }).id))
    })
    q.enqueue('download_audio', 'a', { id: 'a' })
    q.enqueue('download_audio', 'b', { id: 'b' })
    expect(await q.tick()).toBe('ran')
    // depois do intervalo mínimo (4 s) o próximo tem que rodar, não ficar "esperando" para sempre
    wall += 4_001
    expect(await q.tick()).toBe('ran')
    expect(ran).toEqual(['a', 'b'])
  })

  it('nextAllowedAt(now) sem ações anteriores é exatamente now', () => {
    let wall = 1_000_000
    const ticking = { now: () => ++wall, monotonic: () => wall }
    const l = new RateLimiter(LIMITS.wa_media, ticking, () => 0)
    const now = ticking.now()
    expect(l.nextAllowedAt(now)).toBe(now)
  })
})
