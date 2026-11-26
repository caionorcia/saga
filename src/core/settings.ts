import Anthropic from '@anthropic-ai/sdk'
import type { Repo } from './db/repo'
import type { SendOptions } from '../shared/send'
import { DEFAULT_CLAUDE_MODEL, DEFAULT_GROQ_MODEL, SETTING_CLAUDE_MODEL, SETTING_GROQ_MODEL } from './ai/llm'

export type Provider = 'groq' | 'claude'
export type TranscriberKind = 'groq' | 'openai'
export type KeyKind = 'groq' | 'claude' | 'openai'
/** Tema: `system` = Automático (segue o Windows), `light` = Claro, `dark` = Escuro. */
export type ThemePref = 'system' | 'light' | 'dark'
export const THEME_PREFS: ReadonlyArray<ThemePref> = ['system', 'light', 'dark']

/** O que a interface vê: as chaves só como "configurada ou não", nunca o texto. */
export interface Settings {
  provider: Provider
  transcriber: TranscriberKind
  dailyCapUsd: number
  startWithWindows: boolean
  claudeModel: string
  groqModel: string
  theme: ThemePref
  keys: Record<KeyKind, boolean>
  /** v0.4.0: "Envio direto" (padrão: ligado). Desligado, o botão Enviar some */
  directSend: boolean
  /** v0.4.0: mostrar "digitando…" antes de enviar (padrão: sim) */
  sendTyping: boolean
  /** v0.4.0: marcar como lidas as mensagens da conversa respondida (padrão: sim) */
  sendMarkRead: boolean
  /** v0.4.0: nos grupos, citar a mensagem respondida (padrão: sim) */
  sendQuoteInGroups: boolean
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
  theme?: ThemePref
  directSend?: boolean
  sendTyping?: boolean
  sendMarkRead?: boolean
  sendQuoteInGroups?: boolean
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
  groqModel: SETTING_GROQ_MODEL,
  theme: 'settings.theme',
  directSend: 'settings.directSend',
  sendTyping: 'settings.sendTyping',
  sendMarkRead: 'settings.sendMarkRead',
  sendQuoteInGroups: 'settings.sendQuoteInGroups'
} as const

/** Opções do envio direto: ligadas até o mentor desligar. */
const SEND_FLAGS = ['directSend', 'sendTyping', 'sendMarkRead', 'sendQuoteInGroups'] as const

/** Configurações que vão na cópia de segurança (nada de chaves nem do que só vale neste computador). */
const BACKUP_FIELDS = ['provider', 'transcriber', 'dailyCapUsd', 'claudeModel', 'groqModel', 'theme'] as const

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
      theme: this.theme(),
      keys: { groq: this.hasKey('groq'), claude: this.hasKey('claude'), openai: this.hasKey('openai') },
      ...this.sendFlags()
    }
  }

  private sendFlags(): Record<(typeof SEND_FLAGS)[number], boolean> {
    const out = {} as Record<(typeof SEND_FLAGS)[number], boolean>
    for (const f of SEND_FLAGS) out[f] = this.repo.getSetting(K[f]) !== '0'
    return out
  }

  /** As opções do envio direto, lidas na hora de cada envio. */
  sendOptions(): SendOptions {
    const f = this.sendFlags()
    return { enabled: f.directSend, typing: f.sendTyping, markRead: f.sendMarkRead, quoteInGroups: f.sendQuoteInGroups }
  }

  /** O tema escolhido (padrão: Automático). Barato: o processo principal lê antes de abrir a janela. */
  theme(): ThemePref {
    const t = this.repo.getSetting(K.theme)
    return (THEME_PREFS as readonly (string | null)[]).includes(t) ? (t as ThemePref) : 'system'
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

  /** Para a cópia de segurança: só as configurações sem segredo que o mentor escolheu (chave da cópia → valor). */
  exportable(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const f of BACKUP_FIELDS) {
      const v = this.repo.getSetting(K[f])
      if (v !== null) out[f] = v
    }
    return out
  }

  /**
   * Restaura as configurações da cópia (validadas como num `save`; o que for inválido é ignorado). `onlyMissing`:
   * só as que ainda não foram escolhidas neste computador. Devolve quantas mudaram.
   */
  restore(values: Record<string, string>, opts: { onlyMissing: boolean }): number {
    let n = 0
    for (const f of BACKUP_FIELDS) {
      const raw = values[f]
      if (typeof raw !== 'string') continue
      if (opts.onlyMissing && this.repo.getSetting(K[f]) !== null) continue
      const patch: SettingsPatch = f === 'dailyCapUsd' ? { dailyCapUsd: Number(raw) } : ({ [f]: raw } as SettingsPatch)
      try {
        this.save(patch)
        n++
      } catch {
        // valor inválido na cópia: fica o atual
      }
    }
    return n
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
    if (patch.theme !== undefined) {
      if (!THEME_PREFS.includes(patch.theme)) throw new InvalidSettingError('theme')
      writes.push([K.theme, patch.theme])
    }
    if (patch.startWithWindows !== undefined) writes.push([K.startWithWindows, patch.startWithWindows ? '1' : '0'])
    for (const f of SEND_FLAGS) {
      const v = patch[f]
      if (v === undefined) continue
      if (typeof v !== 'boolean') throw new InvalidSettingError(f)
      writes.push([K[f], v ? '1' : '0'])
    }
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
