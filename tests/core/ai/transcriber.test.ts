import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock } from '../../../src/core/clock'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { DeferJobError, JobQueue, type JobType } from '../../../src/core/queue/queue'
import { LIMITS, RateLimiter } from '../../../src/core/queue/limiter'
import {
  RateLimitedError,
  createTranscriber,
  registerTranscribeHandler,
  type Transcriber
} from '../../../src/core/ai/transcriber'

const T0 = 1_700_000_000_000

interface Captured {
  url: string
  init: RequestInit
}

function fakeFetch(res: { status: number; body?: string; headers?: Record<string, string> }) {
  const calls: Captured[] = []
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    return new Response(res.body ?? '', { status: res.status, headers: res.headers })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('createTranscriber', () => {
  let tmp: string
  let file: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'saga-tr-'))
    file = join(tmp, 'm1.ogg')
    writeFileSync(file, Buffer.from([1, 2, 3]))
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('Groq: URL, modelo, idioma, formato e Authorization', async () => {
    const f = fakeFetch({ status: 200, body: ' olá mundo\n' })
    const text = await createTranscriber('groq', 'gsk_secret', f.impl).transcribe(file, 12)
    expect(text).toBe('olá mundo')
    expect(f.calls).toHaveLength(1)
    const { url, init } = f.calls[0]
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gsk_secret')
    const form = init.body as FormData
    expect(form.get('model')).toBe('whisper-large-v3')
    expect(form.get('language')).toBe('pt')
    expect(form.get('response_format')).toBe('text')
    const part = form.get('file') as File
    expect(part.name).toBe('m1.ogg')
    expect(part.type).toBe('audio/ogg')
    expect(part.size).toBe(3)
  })

  it('OpenAI: URL e modelo whisper-1', async () => {
    const f = fakeFetch({ status: 200, body: 'oi' })
    await createTranscriber('openai', 'sk-x', f.impl).transcribe(file, 5)
    expect(f.calls[0].url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect((f.calls[0].init.body as FormData).get('model')).toBe('whisper-1')
  })

  it('429 com retry-after: 30 -> RateLimitedError(30000), que é um DeferJobError', async () => {
    const f = fakeFetch({ status: 429, headers: { 'retry-after': '30' } })
    const err = await createTranscriber('groq', 'k', f.impl).transcribe(file, 5).catch((e) => e)
    expect(err).toBeInstanceOf(RateLimitedError)
    expect(err).toBeInstanceOf(DeferJobError)
    expect(err.retryAfterMs).toBe(30_000)
    expect(err.delayMs).toBe(30_000)
  })

  it('429 sem retry-after -> 60000', async () => {
    const f = fakeFetch({ status: 429 })
    const err = await createTranscriber('groq', 'k', f.impl).transcribe(file, 5).catch((e) => e)
    expect(err.retryAfterMs).toBe(60_000)
  })

  it('5xx -> Error comum sem vazar a chave', async () => {
    const f = fakeFetch({ status: 503, body: 'indisponível' })
    const err = await createTranscriber('groq', 'gsk_secret', f.impl).transcribe(file, 5).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(DeferJobError)
    expect(err.message).toContain('503')
    expect(err.message).not.toContain('gsk_secret')
  })

  it('401 -> erro identificável (InvalidKeyError)', async () => {
    const f = fakeFetch({ status: 401 })
    const err = await createTranscriber('groq', 'k', f.impl).transcribe(file, 5).catch((e) => e)
    expect(err.name).toBe('InvalidKeyError')
  })
})

describe('registerTranscribeHandler', () => {
  let clock: FakeClock
  let repo: Repo
  let q: JobQueue
  let tmp: string
  let file: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'saga-trh-'))
    clock = new FakeClock(T0)
    repo = new Repo(openDb(':memory:'), clock)
    const limiters: Record<JobType, RateLimiter> = {
      download_audio: new RateLimiter(LIMITS.wa_media, clock, () => 0),
      transcribe: new RateLimiter(LIMITS.groq_audio, clock, () => 0),
      fetch_profile: new RateLimiter(LIMITS.wa_profile, clock, () => 0)
    }
    q = new JobQueue(repo, clock, limiters)
    repo.upsertContact({ jid: 'x@s.whatsapp.net' })
    repo.insertMessage({
      id: 'm1', jid: 'x@s.whatsapp.net', fromMe: false, ts: 1, kind: 'audio',
      text: null, mediaKeyJson: null, durationSec: 30
    })
    file = join(tmp, 'm1.ogg')
    writeFileSync(file, Buffer.from([1]))
    repo.setAudioPath('m1', file)
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  const fakeTranscriber = (impl: () => Promise<string>): Transcriber & { calls: number } => {
    const t = { calls: 0, transcribe: async () => { t.calls++; return impl() } }
    return t
  }
  const run = async () => {
    q.enqueue('transcribe', 'transcribe:m1', { id: 'm1', durationSec: 30 })
    return q.tick()
  }
  const msg = () => repo.getMessage('m1')!

  it('sucesso: grava transcrição e status done', async () => {
    const t = fakeTranscriber(async () => 'olá')
    registerTranscribeHandler({ queue: q, repo, getTranscriber: () => t })
    await run()
    expect(msg().transcript).toBe('olá')
    expect(msg().transcriptStatus).toBe('done')
    expect(repo.jobCounts().done).toBe(1)
  })

  it('idempotente: já done não chama a API', async () => {
    repo.setTranscript('m1', 'antigo', 'done')
    const t = fakeTranscriber(async () => 'novo')
    registerTranscribeHandler({ queue: q, repo, getTranscriber: () => t })
    await run()
    expect(t.calls).toBe(0)
    expect(msg().transcript).toBe('antigo')
  })

  it('arquivo ausente: unavailable, sem chamar a API', async () => {
    rmSync(file)
    const t = fakeTranscriber(async () => 'x')
    registerTranscribeHandler({ queue: q, repo, getTranscriber: () => t })
    await run()
    expect(t.calls).toBe(0)
    expect(msg().transcriptStatus).toBe('unavailable')
    expect(msg().transcript).toBeNull()
  })

  it('sem chave: pausa o tipo, registra evento, job fica pending sem gastar tentativa', async () => {
    registerTranscribeHandler({ queue: q, repo, getTranscriber: () => null })
    await run()
    expect(q.isTypePaused('transcribe')).toBe(true)
    expect(q.isPaused()).toBe(false)
    const job = repo.listJobs('pending')[0]
    expect(job.attempts).toBe(0)
    expect(msg().transcriptStatus).not.toBe('done')
  })

  it('401: pausa só o tipo transcribe, ai_key_invalid, job pending sem tentativa', async () => {
    const f = fakeFetch({ status: 401 })
    const t = createTranscriber('groq', 'gsk_secret', f.impl)
    const spy = vi.spyOn(repo, 'logEvent')
    registerTranscribeHandler({ queue: q, repo, getTranscriber: () => t })
    await run()
    expect(q.isTypePaused('transcribe')).toBe(true)
    expect(q.isPaused()).toBe(false)
    expect(spy).toHaveBeenCalledWith('ai_key_invalid', expect.not.stringContaining('gsk_secret'))
    const job = repo.listJobs('pending')[0]
    expect(job.attempts).toBe(0)
  })

  it('429: job volta pending em now+retry-after sem gastar tentativa', async () => {
    const f = fakeFetch({ status: 429, headers: { 'retry-after': '30' } })
    registerTranscribeHandler({ queue: q, repo, getTranscriber: () => createTranscriber('groq', 'k', f.impl) })
    await run()
    const job = repo.listJobs('pending')[0]
    expect(job.attempts).toBe(0)
    expect(job.nextRunAt).toBe(T0 + 30_000)
  })

  it('erro 5xx: consome tentativa (backoff normal)', async () => {
    const f = fakeFetch({ status: 500 })
    registerTranscribeHandler({ queue: q, repo, getTranscriber: () => createTranscriber('groq', 'k', f.impl) })
    await run()
    const job = repo.listJobs('pending')[0]
    expect(job.attempts).toBe(1)
  })
})
