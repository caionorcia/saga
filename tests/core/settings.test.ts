import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../../src/core/db/db'
import { Repo } from '../../src/core/db/repo'
import { DEFAULT_GROQ_MODEL, SETTING_CLAUDE_MODEL, SETTING_GROQ_MODEL } from '../../src/core/ai/llm'
import { EncryptionUnavailableError, SettingsStore, testKey, type Cipher } from '../../src/core/settings'

const SECRET = 'gsk_SEGREDO_1234567890'

/** Cifra reversível de teste: o texto guardado nunca contém a chave em claro. */
function fakeCipher(available = true): Cipher & { encrypt: ReturnType<typeof vi.fn> } {
  return {
    isAvailable: () => available,
    encrypt: vi.fn((s: string) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a))),
    decrypt: (b: Buffer) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8')
  }
}

function allSettingsText(repo: Repo, keys: string[]): string {
  return keys.map((k) => repo.getSetting(k) ?? '').join('\n')
}

describe('SettingsStore', () => {
  let repo: Repo

  beforeEach(() => {
    repo = new Repo(openDb(':memory:'))
  })

  it('padrões', () => {
    const s = new SettingsStore(repo, fakeCipher()).get()
    expect(s).toEqual({
      provider: 'groq',
      transcriber: 'groq',
      dailyCapUsd: 1,
      startWithWindows: false,
      claudeModel: 'claude-opus-5-5',
      groqModel: DEFAULT_GROQ_MODEL,
      theme: 'system',
      keys: { groq: false, claude: false, openai: false }
    })
  })

  it('tema: Automático por padrão; salva Claro/Escuro; recusa valor desconhecido sem gravar nada', () => {
    const st = new SettingsStore(repo, fakeCipher())
    expect(st.theme()).toBe('system')
    st.save({ theme: 'dark' })
    expect(st.get().theme).toBe('dark')
    expect(repo.getSetting('settings.theme')).toBe('dark')
    expect(() => st.save({ theme: 'roxo' as never, dailyCapUsd: 5 })).toThrow(/theme/)
    expect(st.get()).toMatchObject({ theme: 'dark', dailyCapUsd: 1 })
    repo.setSetting('settings.theme', 'lixo')
    expect(st.theme()).toBe('system')
  })

  it('chaves: guardadas cifradas em base64; get() só devolve booleanos; getKey devolve o texto', () => {
    const st = new SettingsStore(repo, fakeCipher())
    st.save({ groqKey: `  ${SECRET} `, claudeKey: 'sk-ant-OUTRA' })
    const view = st.get()
    expect(view.keys).toEqual({ groq: true, claude: true, openai: false })
    expect(JSON.stringify(view)).not.toContain(SECRET)
    expect(JSON.stringify(view)).not.toContain('sk-ant-OUTRA')
    const raw = allSettingsText(repo, ['key.groq', 'key.claude'])
    expect(raw).not.toContain(SECRET)
    expect(repo.getSetting('key.groq')).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(st.getKey('groq')).toBe(SECRET)
    expect(st.getKey('claude')).toBe('sk-ant-OUTRA')
    expect(st.getKey('openai')).toBeNull()
  })

  it('chave vazia apaga a chave', () => {
    const st = new SettingsStore(repo, fakeCipher())
    st.save({ groqKey: SECRET })
    st.save({ groqKey: '' })
    expect(st.get().keys.groq).toBe(false)
    expect(st.getKey('groq')).toBeNull()
  })

  it('criptografia indisponível: erro e nada é gravado (nem as outras configurações do mesmo pedido)', () => {
    const c = fakeCipher(false)
    const st = new SettingsStore(repo, c)
    expect(() => st.save({ groqKey: SECRET, provider: 'claude' })).toThrow(EncryptionUnavailableError)
    expect(c.encrypt).not.toHaveBeenCalled()
    expect(st.get().keys.groq).toBe(false)
    expect(st.get().provider).toBe('groq')
    // sem chave no pedido, salvar as outras configurações funciona
    st.save({ provider: 'claude' })
    expect(st.get().provider).toBe('claude')
  })

  it('configurações simples persistem; modelos usam as chaves lidas pelo llm.ts', () => {
    const st = new SettingsStore(repo, fakeCipher())
    st.save({ provider: 'claude', transcriber: 'openai', dailyCapUsd: 2.5, startWithWindows: true, claudeModel: 'claude-sonnet-5-5', groqModel: 'outro' })
    expect(new SettingsStore(repo, fakeCipher()).get()).toMatchObject({
      provider: 'claude',
      transcriber: 'openai',
      dailyCapUsd: 2.5,
      startWithWindows: true,
      claudeModel: 'claude-sonnet-5-5',
      groqModel: 'outro'
    })
    expect(repo.getSetting(SETTING_CLAUDE_MODEL)).toBe('claude-sonnet-5-5')
    expect(repo.getSetting(SETTING_GROQ_MODEL)).toBe('outro')
  })

  it('valores inválidos são recusados sem gravar nada', () => {
    const st = new SettingsStore(repo, fakeCipher())
    expect(() => st.save({ provider: 'gpt' as any })).toThrow()
    expect(() => st.save({ dailyCapUsd: -1 })).toThrow()
    expect(() => st.save({ dailyCapUsd: Number.NaN, provider: 'claude' })).toThrow()
    expect(st.get().provider).toBe('groq')
    expect(st.get().dailyCapUsd).toBe(1)
  })

  it('chave que não decifra (outro usuário do Windows) conta como ausente', () => {
    const st = new SettingsStore(repo, fakeCipher())
    st.save({ groqKey: SECRET })
    const broken = new SettingsStore(repo, {
      isAvailable: () => true,
      encrypt: () => Buffer.alloc(0),
      decrypt: () => {
        throw new Error('não decifra')
      }
    })
    expect(broken.getKey('groq')).toBeNull()
    expect(broken.get().keys.groq).toBe(false)
  })
})

describe('testKey', () => {
  const ok = (body: unknown = { data: [] }) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

  it('groq: GET /openai/v1/models com Bearer', async () => {
    const f = vi.fn(async (..._a: any[]) => ok())
    expect(await testKey('groq', SECRET, { fetchImpl: f as any })).toBe(true)
    const [url, init] = f.mock.calls[0]
    expect(String(url)).toBe('https://api.groq.com/openai/v1/models')
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`)
  })

  it('openai: GET /v1/models', async () => {
    const f = vi.fn(async (..._a: any[]) => ok())
    expect(await testKey('openai', 'sk-x', { fetchImpl: f as any })).toBe(true)
    expect(String(f.mock.calls[0][0])).toBe('https://api.openai.com/v1/models')
  })

  it('401 ou erro de rede → false (sem lançar)', async () => {
    expect(await testKey('groq', 'x', { fetchImpl: (async () => new Response('', { status: 401 })) as any })).toBe(false)
    expect(
      await testKey('openai', 'x', {
        fetchImpl: (async () => {
          throw new Error('offline')
        }) as any
      })
    ).toBe(false)
    expect(await testKey('groq', '   ', { fetchImpl: (async () => ok()) as any })).toBe(false)
  })

  it('claude: models.list({limit:1}) sem novas tentativas', async () => {
    const f = vi.fn(async (..._a: any[]) => ok({ data: [], has_more: false, first_id: null, last_id: null }))
    expect(await testKey('claude', 'sk-ant-x', { fetchImpl: f as any })).toBe(true)
    expect(f).toHaveBeenCalledTimes(1)
    expect(String(f.mock.calls[0][0])).toContain('/v1/models?limit=1')

    const bad = vi.fn(async (..._a: any[]) =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'x' } }), { status: 401 })
    )
    expect(await testKey('claude', 'sk-ant-x', { fetchImpl: bad as any })).toBe(false)
    expect(bad).toHaveBeenCalledTimes(1)
  })
})
