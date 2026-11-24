import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Repo } from '../db/repo'
import { DeferJobError, type JobQueue } from '../queue/queue'
import type { Clock } from '../clock'
import { OPENAI_TRANSCRIBE_USD_PER_MIN, type CostTracker } from './budget'
import { GroqModels, InvalidKeyError, ModelNotFoundError, isModelGone } from './groqModels'

export { InvalidKeyError }

export interface Transcriber {
  /** provedor (para o custo); ausente = gratuito */
  kind?: 'groq' | 'openai'
  /** `signal`: cancela o pedido (o job da fila estourou o prazo) */
  transcribe(file: string, durationSec: number, signal?: AbortSignal): Promise<string>
}

/** Sem internet: a transcrição espera este tempo (sem gastar tentativa). */
export const NETWORK_RETRY_MS = 2 * 60_000
/** Prazo de um pedido de transcrição antes de desistir (conta como erro de rede). */
const REQUEST_TIMEOUT_MS = 2 * 60_000

const NET_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT'
])

/** Queda de rede, tempo esgotado ou pedido abortado (não é erro do provedor). Olha também `cause`. */
export function isNetworkError(e: unknown): boolean {
  let x = e as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown } | null | undefined
  for (let i = 0; x && typeof x === 'object' && i < 5; i++, x = x.cause as typeof x) {
    if (x.name === 'AbortError' || x.name === 'TimeoutError') return true
    if (typeof x.code === 'string' && NET_CODES.has(x.code)) return true
    if (x instanceof TypeError && typeof x.message === 'string' && /fetch failed|network/i.test(x.message)) return true
  }
  return false
}

/** 429: o provedor pediu para esperar; devolve o job à fila sem gastar tentativa. */
export class RateLimitedError extends DeferJobError {
  constructor(readonly retryAfterMs: number) {
    super(`limite de pedidos da transcrição atingido; nova tentativa em ${Math.ceil(retryAfterMs / 1000)} s`, retryAfterMs)
    this.name = 'RateLimitedError'
  }
}

const DEFAULT_RETRY_AFTER_MS = 60_000

const PROVIDERS = {
  groq: { url: 'https://api.groq.com/openai/v1/audio/transcriptions' },
  openai: { url: 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1' }
} as const

function parseRetryAfterMs(h: string | null): number {
  const s = h === null ? NaN : Number(h)
  return Number.isFinite(s) && s >= 0 ? Math.ceil(s * 1000) : DEFAULT_RETRY_AFTER_MS
}

export interface CreateTranscriberOpts {
  /** cache da lista de modelos da Groq (24 h) */
  repo?: Repo
  clock?: Clock
  diag?: (kind: string, detail: string) => void
}

/**
 * Groq: o modelo é escolhido pela lista da própria Groq (`whisper-large-v3-turbo`, depois `whisper-large-v3`);
 * um 404 (modelo aposentado) troca de modelo e tenta mais uma vez.
 */
export function createTranscriber(
  kind: 'groq' | 'openai',
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  opts: CreateTranscriberOpts = {}
): Transcriber {
  const { url } = PROVIDERS[kind]
  const models = kind === 'groq' ? new GroqModels({ apiKey, fetchImpl, ...opts }) : null
  const post = async (bytes: Awaited<ReturnType<typeof readFile>>, file: string, model: string, signal?: AbortSignal): Promise<string> => {
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: 'audio/ogg' }), basename(file))
    form.append('model', model)
    form.append('language', 'pt')
    form.append('response_format', 'text')
    const t = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: signal ? AbortSignal.any([t, signal]) : t
    })
    if (res.status === 401) throw new InvalidKeyError()
    if (res.status === 429) throw new RateLimitedError(parseRetryAfterMs(res.headers.get('retry-after')))
    if (models && (await isModelGone(res))) throw new ModelNotFoundError(model)
    if (!res.ok) throw new Error(`transcrição falhou: HTTP ${res.status} (${kind})`)
    return (await res.text()).trim()
  }
  return {
    kind,
    async transcribe(file: string, _durationSec: number, signal?: AbortSignal): Promise<string> {
      const bytes = await readFile(file)
      if (!models) return post(bytes, file, PROVIDERS.openai.model, signal)
      return models.withModel('transcribe', null, (model) => post(bytes, file, model, signal), signal)
    }
  }
}

export type TranscribePauseReason = 'key' | 'budget' | 'network'

export interface TranscribeDeps {
  queue: JobQueue
  repo: Repo
  /** null quando não há chave configurada */
  getTranscriber: () => Transcriber | null
  /** gasto do dia (a OpenAI é paga; a Groq não soma nada) */
  cost?: CostTracker
  /** teto diário de gasto (USD) */
  getCapUsd?: () => number
  /** avisa por que as transcrições foram pausadas (para a interface) */
  onPause?: (reason: TranscribePauseReason) => void
}

export function registerTranscribeHandler({ queue, repo, getTranscriber, cost, getCapUsd, onPause }: TranscribeDeps): void {
  const pause = (reason: TranscribePauseReason, ms?: number) => {
    if (ms === undefined) queue.pauseType('transcribe')
    else queue.pauseTypeFor('transcribe', ms)
    onPause?.(reason)
  }
  queue.register('transcribe', async (payload: { id: string; durationSec: number }, signal?: AbortSignal) => {
    const row = repo.getMessage(payload.id)
    if (!row || row.transcriptStatus === 'done') return
    // contato escondido: não transcreve (volta para a fila se ele for mostrado de novo)
    if (repo.isHidden(row.jid)) return
    if (!row.audioPath || !existsSync(row.audioPath)) {
      repo.setTranscript(payload.id, null, 'unavailable')
      return
    }
    const transcriber = getTranscriber()
    if (!transcriber) {
      pause('key')
      repo.logEvent('ai_key_missing', 'nenhuma chave de transcrição configurada; transcrições pausadas')
      throw new DeferJobError('chave de transcrição ausente')
    }
    const paid = transcriber.kind === 'openai' && cost !== undefined
    if (paid && getCapUsd && cost.overCap(getCapUsd())) {
      pause('budget', cost.msUntilTomorrow())
      repo.logEvent('transcribe_budget', 'teto diário de gasto atingido; transcrições pela OpenAI pausadas até amanhã')
      throw new DeferJobError('teto diário de gasto atingido')
    }
    try {
      const text = await transcriber.transcribe(row.audioPath, payload.durationSec, signal)
      // o job estourou o prazo: a resposta atrasada não vale (outra tentativa cuida disso)
      signal?.throwIfAborted()
      repo.setTranscript(payload.id, text, 'done')
    } catch (e) {
      // cancelado pela fila (prazo do job): ela já contou a tentativa; sem efeitos colaterais aqui
      if (signal?.aborted) throw e
      if (e instanceof InvalidKeyError) {
        pause('key')
        repo.logEvent('ai_key_invalid', 'a chave de transcrição foi recusada (401); transcrições pausadas')
        throw new DeferJobError(e.message)
      }
      if (isNetworkError(e)) {
        // sem internet: não gasta tentativa e não tenta os próximos áudios em rajada
        pause('network', NETWORK_RETRY_MS)
        repo.logEvent('transcribe_offline', 'sem conexão com o serviço de transcrição; nova tentativa em 2 min')
        throw new DeferJobError('sem conexão com o serviço de transcrição', NETWORK_RETRY_MS)
      }
      throw e
    }
    if (paid) {
      const sec = Number(payload.durationSec ?? row.durationSec)
      cost.addUsd(((Number.isFinite(sec) && sec > 0 ? sec : 0) / 60) * OPENAI_TRANSCRIBE_USD_PER_MIN)
    }
  })
}
