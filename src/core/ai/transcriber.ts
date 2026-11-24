import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Repo } from '../db/repo'
import { DeferJobError, type JobQueue } from '../queue/queue'

export interface Transcriber {
  transcribe(file: string, durationSec: number): Promise<string>
}

/** 429: o provedor pediu para esperar; devolve o job à fila sem gastar tentativa. */
export class RateLimitedError extends DeferJobError {
  constructor(readonly retryAfterMs: number) {
    super(`limite de pedidos da transcrição atingido; nova tentativa em ${Math.ceil(retryAfterMs / 1000)} s`, retryAfterMs)
    this.name = 'RateLimitedError'
  }
}

/** 401: chave recusada pelo provedor. */
export class InvalidKeyError extends Error {
  constructor() {
    super('chave de API recusada pelo provedor de transcrição (401)')
    this.name = 'InvalidKeyError'
  }
}

const DEFAULT_RETRY_AFTER_MS = 60_000

const PROVIDERS = {
  groq: { url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3' },
  openai: { url: 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1' }
} as const

function parseRetryAfterMs(h: string | null): number {
  const s = h === null ? NaN : Number(h)
  return Number.isFinite(s) && s >= 0 ? Math.ceil(s * 1000) : DEFAULT_RETRY_AFTER_MS
}

export function createTranscriber(
  kind: 'groq' | 'openai',
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Transcriber {
  const { url, model } = PROVIDERS[kind]
  return {
    async transcribe(file: string): Promise<string> {
      const bytes = await readFile(file)
      const form = new FormData()
      form.append('file', new Blob([bytes], { type: 'audio/ogg' }), basename(file))
      form.append('model', model)
      form.append('language', 'pt')
      form.append('response_format', 'text')
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form
      })
      if (res.status === 401) throw new InvalidKeyError()
      if (res.status === 429) throw new RateLimitedError(parseRetryAfterMs(res.headers.get('retry-after')))
      if (!res.ok) throw new Error(`transcrição falhou: HTTP ${res.status} (${kind})`)
      return (await res.text()).trim()
    }
  }
}

export interface TranscribeDeps {
  queue: JobQueue
  repo: Repo
  /** null quando não há chave configurada */
  getTranscriber: () => Transcriber | null
}

export function registerTranscribeHandler({ queue, repo, getTranscriber }: TranscribeDeps): void {
  queue.register('transcribe', async (payload: { id: string; durationSec: number }) => {
    const row = repo.getMessage(payload.id)
    if (!row || row.transcriptStatus === 'done') return
    if (!row.audioPath || !existsSync(row.audioPath)) {
      repo.setTranscript(payload.id, null, 'unavailable')
      return
    }
    const transcriber = getTranscriber()
    if (!transcriber) {
      queue.pauseType('transcribe')
      repo.logEvent('ai_key_missing', 'nenhuma chave de transcrição configurada; transcrições pausadas')
      throw new DeferJobError('chave de transcrição ausente')
    }
    try {
      const text = await transcriber.transcribe(row.audioPath, payload.durationSec)
      repo.setTranscript(payload.id, text, 'done')
    } catch (e) {
      if (e instanceof InvalidKeyError) {
        queue.pauseType('transcribe')
        repo.logEvent('ai_key_invalid', 'a chave de transcrição foi recusada (401); transcrições pausadas')
        throw new DeferJobError(e.message)
      }
      throw e
    }
  })
}
