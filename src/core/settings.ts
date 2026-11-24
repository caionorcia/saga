import Anthropic from '@anthropic-ai/sdk'
import type { Repo } from './db/repo'
import { DEFAULT_CLAUDE_MODEL, DEFAULT_GROQ_MODEL, SETTING_CLAUDE_MODEL, SETTING_GROQ_MODEL } from './ai/llm'

export type Provider = 'groq' | 'claude'
export type TranscriberKind = 'groq' | 'openai'
export type KeyKind = 'groq' | 'claude' | 'openai'

/** O que a interface vê: as chaves só como "configurada ou não", nunca o texto. */
export interface Settings {
  provider: Provider
  transcriber: TranscriberKind
  dailyCapUsd: number
  startWithWindows: boolean
  claudeModel: string
  groqModel: string
  keys: Record<KeyKind, boolean>
}

/** Campos ausentes ficam como estão; chave `''` apaga a chave. */
export interface SettingsPatch {
  groqKey?: string
  claudeKey?: string
  openaiKey?: string
  provider?: Provider
  transcriber?: TranscriberKind
  dailyCapUsd?: number
  startWithWindows?: boolean
  claudeModel?: string
  groqModel?: string
}

/** Cifra do sistema (no app, o `safeStorage` do Electron). Injetada para o core não depender do Electron. */
export interface Cipher {
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

export class EncryptionUnavailableError extends Error {
  constructor() {
    super('a criptografia do sistema não está disponível; a chave não foi salva')
    this.name = 'EncryptionUnavailableError'
  }
}

export class InvalidSettingError extends Error {
  constructor(field: string) {
    super(`configuração inválida: ${field}`)
    this.name = 'InvalidSettingError'
  }
}

const K = {
  provider: 'settings.provider',
  transcriber: 'settings.transcriber',
  dailyCapUsd: 'settings.dailyCapUsd',
  startWithWindows: 'settings.startWithWindows',
  claudeModel: SETTING_CLAUDE_MODEL,
  groqModel: SETTING_GROQ_MODEL
} as const

const KEY_FIELDS: Record<KeyKind, 'groqKey' | 'claudeKey' | 'openaiKey'> = {
  groq: 'groqKey',
  claude: 'claudeKey',
  openai: 'openaiKey'
}

const keySetting = (kind: KeyKind) => `key.${kind}`

export class SettingsStore {
  constructor(
    private readonly repo: Repo,
    private readonly cipher: Cipher
  ) {}

  get(): Settings {
    const provider = this.repo.getSetting(K.provider)
    const transcriber = this.repo.getSetting(K.transcriber)
    const cap = Number(this.repo.getSetting(K.dailyCapUsd) ?? NaN)
    return {
      provider: provider === 'claude' ? 'claude' : 'groq',
      transcriber: transcriber === 'openai' ? 'openai' : 'groq',
      dailyCapUsd: Number.isFinite(cap) && cap >= 0 ? cap : 1,
      startWithWindows: this.repo.getSetting(K.startWithWindows) === '1',
      claudeModel: this.repo.getSetting(K.claudeModel) || DEFAULT_CLAUDE_MODEL,
      groqModel: this.repo.getSetting(K.groqModel) || DEFAULT_GROQ_MODEL,
      keys: { groq: this.hasKey('groq'), claude: this.hasKey('claude'), openai: this.hasKey('openai') }
    }
  }

  hasKey(kind: KeyKind): boolean {
    return this.getKey(kind) !== null
  }

  /** Texto da chave, só para uso interno (criar o cliente da IA). Nunca registrar nem enviar à interface. */
  getKey(kind: KeyKind): string | null {
    const raw = this.repo.getSetting(keySetting(kind))
    if (!raw) return null
    try {
      const key = this.cipher.decrypt(Buffer.from(raw, 'base64'))
      return key || null
    } catch {
      return null
    }
  }

  /** Valida tudo antes de gravar: ou o pedido inteiro é salvo, ou nada. */
  save(patch: SettingsPatch): void {
    const writes: Array<[string, string | null]> = []
    if (patch.provider !== undefined) {
      if (patch.provider !== 'groq' && patch.provider !== 'claude') throw new InvalidSettingError('provider')
      writes.push([K.provider, patch.provider])
    }
    if (patch.transcriber !== undefined) {
      if (patch.transcriber !== 'groq' && patch.transcriber !== 'openai') throw new InvalidSettingError('transcriber')
      writes.push([K.transcriber, patch.transcriber])
    }
    if (patch.dailyCapUsd !== undefined) {
      if (typeof patch.dailyCapUsd !== 'number' || !Number.isFinite(patch.dailyCapUsd) || patch.dailyCapUsd < 0) {
        throw new InvalidSettingError('dailyCapUsd')
      }
      writes.push([K.dailyCapUsd, String(patch.dailyCapUsd)])
    }
    if (patch.startWithWindows !== undefined) writes.push([K.startWithWindows, patch.startWithWindows ? '1' : '0'])
    for (const f of ['claudeModel', 'groqModel'] as const) {
      const v = patch[f]
      if (v === undefined) continue
      if (typeof v !== 'string') throw new InvalidSettingError(f)
      writes.push([K[f], v.trim() || null])
    }
    const keyWrites: Array<[KeyKind, string]> = []
    for (const kind of Object.keys(KEY_FIELDS) as KeyKind[]) {
      const v = patch[KEY_FIELDS[kind]]
      if (v === undefined) continue
      if (typeof v !== 'string') throw new InvalidSettingError(KEY_FIELDS[kind])
      const key = v.trim()
      if (key) keyWrites.push([kind, key])
      else writes.push([keySetting(kind), null])
    }
    if (keyWrites.length && !this.cipher.isAvailable()) throw new EncryptionUnavailableError()
    for (const [kind, key] of keyWrites) {
      writes.push([keySetting(kind), this.cipher.encrypt(key).toString('base64')])
    }
    for (const [k, v] of writes) {
      if (v === null) this.repo.deleteSetting(k)
      else this.repo.setSetting(k, v)
    }
  }
}

const TEST_TIMEOUT_MS = 15_000

/**
 * Validação barata da chave no assistente (lista de modelos). `true` só com resposta 2xx.
 * Nunca lança e nunca registra a chave.
 */
export async function testKey(
  kind: KeyKind,
  key: string,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<boolean> {
  const k = key.trim()
  if (!k) return false
  const fetchImpl = opts.fetchImpl ?? fetch
  try {
    if (kind === 'claude') {
      const client = new Anthropic({ apiKey: k, maxRetries: 0, timeout: TEST_TIMEOUT_MS, fetch: opts.fetchImpl })
      await client.models.list({ limit: 1 })
      return true
    }
    const url = kind === 'groq' ? 'https://api.groq.com/openai/v1/models' : 'https://api.openai.com/v1/models'
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${k}` },
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS)
    })
    return res.ok
  } catch {
    return false
  }
}
