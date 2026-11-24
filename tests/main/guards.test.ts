import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { InvalidIpcArgsError, isAppUrl, isExternalHttpUrl, validateIpcArgs } from '../../src/main/guards'

const INDEX = resolve('/app/resources/app.asar/out/renderer/index.html')
const DEV = 'http://localhost:5173'
const fileIndex = pathToFileURL(INDEX).toString()

describe('isAppUrl', () => {
  it.each([
    [fileIndex, { indexFile: INDEX }],
    [`${fileIndex}#/contato/1`, { indexFile: INDEX }],
    ['http://localhost:5173/', { indexFile: INDEX, devUrl: DEV }],
    ['http://localhost:5173/src/main.tsx?t=1', { indexFile: INDEX, devUrl: DEV }]
  ])('aceita %s', (url, origin) => {
    expect(isAppUrl(url, origin)).toBe(true)
  })

  it.each([
    'https://evil.example/',
    'http://localhost:5174/',
    'http://localhost:5173/',
    'file:///etc/passwd',
    pathToFileURL(resolve('/app/resources/app.asar/out/renderer/outro.html')).toString(),
    'file://servidor/app/resources/app.asar/out/renderer/index.html',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'about:blank',
    ''
  ])('recusa %s (sem dev server)', (url) => {
    expect(isAppUrl(url, { indexFile: INDEX })).toBe(false)
  })

  it('com dev server: outras origens continuam recusadas', () => {
    for (const u of ['https://evil.example/', 'http://localhost:5174/', 'https://localhost:5173/', 'javascript:alert(1)', 'file:///etc/passwd']) {
      expect(isAppUrl(u, { indexFile: INDEX, devUrl: DEV })).toBe(false)
    }
  })
})

describe('isExternalHttpUrl', () => {
  it('só http(s)', () => {
    expect(isExternalHttpUrl('https://exemplo.com.br/x')).toBe(true)
    expect(isExternalHttpUrl('http://exemplo.com')).toBe(true)
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://x/y', 'ms-settings:', 'nada']) expect(isExternalHttpUrl(u)).toBe(false)
  })
})

describe('validateIpcArgs', () => {
  const ok = (m: any, ...a: unknown[]) => expect(() => validateIpcArgs(m, a)).not.toThrow()
  const bad = (m: any, ...a: unknown[]) => expect(() => validateIpcArgs(m, a)).toThrow(InvalidIpcArgsError)

  it('recentEvents: inteiro entre 1 e 200', () => {
    ok('recentEvents', 20)
    bad('recentEvents', 0)
    bad('recentEvents', -1)
    bad('recentEvents', 1.5)
    bad('recentEvents', 201)
    bad('recentEvents', '20')
    bad('recentEvents')
  })

  it('testKey: tipo de chave conhecido e chave em texto', () => {
    ok('testKey', 'groq', 'k')
    ok('testKey', 'claude', 'k')
    ok('testKey', 'openai', 'k')
    bad('testKey', 'gemini', 'k')
    bad('testKey', 'groq', 123)
    bad('testKey', '__proto__', 'k')
  })

  it('saveReply: jid e finalText não vazios; sugestão texto ou null', () => {
    ok('saveReply', { jid: 'a@s.whatsapp.net', originalSuggestion: null, finalText: 'oi' })
    ok('saveReply', { jid: 'a@s.whatsapp.net', originalSuggestion: 'x', finalText: 'oi' })
    bad('saveReply', { jid: '', originalSuggestion: null, finalText: 'oi' })
    bad('saveReply', { jid: 'a', originalSuggestion: null, finalText: '  ' })
    bad('saveReply', { jid: 'a', originalSuggestion: 5, finalText: 'oi' })
    bad('saveReply', 'texto')
    bad('saveReply')
  })

  it('contatos: tipos certos', () => {
    ok('renameContact', 'a', 'Ana')
    ok('renameContact', 'a', '')
    bad('renameContact', 'a', null)
    ok('setHidden', 'a', true)
    bad('setHidden', 'a', 'true')
    ok('setNotes', 'a', 'notas')
    bad('setNotes', '', 'notas')
    ok('listContacts', false)
    bad('listContacts', 'sim')
  })

  it('saveSettings: só campos conhecidos com tipos válidos', () => {
    ok('saveSettings', { provider: 'claude', dailyCapUsd: 2, groqKey: 'k' })
    bad('saveSettings', { provider: 'gpt' })
    bad('saveSettings', { dailyCapUsd: '2' })
    bad('saveSettings', { outro: 1 })
    bad('saveSettings', null)
  })
})

describe('isAppUrl no Windows (win32)', () => {
  const WIN_INDEX = 'c:\\Users\\João Silva\\AppData\\Local\\Programs\\Saga\\resources\\app.asar\\out\\renderer\\index.html'
  const URL_UP = 'file:///C:/Users/Jo%C3%A3o%20Silva/AppData/Local/Programs/Saga/resources/app.asar/out/renderer/index.html'
  const o = { indexFile: WIN_INDEX }

  it.each([
    URL_UP,
    URL_UP.replace('file:///C:', 'file:///c:'),
    `${URL_UP}#/contato/5547`,
    `${URL_UP}?x=1`,
    URL_UP.replace('file:///', 'file://localhost/'),
    URL_UP.replace('/Users/', '/USERS/')
  ])('aceita %s (sem diferenciar maiúsculas)', (url) => {
    expect(isAppUrl(url, o, 'win32')).toBe(true)
  })

  it('índice com letra de unidade maiúscula também aceita a URL minúscula', () => {
    expect(isAppUrl(URL_UP.replace('file:///C:', 'file:///c:'), { indexFile: WIN_INDEX.replace('c:', 'C:') }, 'win32')).toBe(true)
  })

  it.each([
    'file:///C:/Windows/System32/drivers/etc/hosts',
    URL_UP.replace('index.html', 'outro.html'),
    URL_UP.replace('file:///C:', 'file:///D:'),
    URL_UP.replace('file:///', 'file://servidor/'),
    'file:///C:/Users/Jo%C3%A3o%20Silva/AppData/Local/Programs/Saga/resources/app.asar/out/renderer/../renderer/x/../../../../../../../../Windows/win.ini',
    'javascript:alert(1)',
    'https://evil.example/'
  ])('recusa %s', (url) => {
    expect(isAppUrl(url, o, 'win32')).toBe(false)
  })

  // os caminhos de teste são POSIX; num host Windows o modo 'linux' não se aplica
  it.skipIf(process.platform === 'win32')('fora do Windows a comparação continua exata (maiúsculas importam)', () => {
    expect(isAppUrl(fileIndex.replace('/app/', '/APP/'), { indexFile: INDEX }, 'linux')).toBe(false)
    expect(isAppUrl(fileIndex, { indexFile: INDEX }, 'linux')).toBe(true)
  })
})

describe('downloadUpdate', () => {
  it('downloadUpdate: sem argumentos', () => {
    expect(() => validateIpcArgs('downloadUpdate', [])).not.toThrow()
  })
})

describe('installUpdate', () => {
  it('sem argumentos (qualquer argumento é recusado)', () => {
    expect(() => validateIpcArgs('installUpdate', [])).not.toThrow()
    expect(() => validateIpcArgs('installUpdate', [true])).toThrow(InvalidIpcArgsError)
  })
})

describe('saveReply: id da análise', () => {
  it('analysisLastMsgId opcional: texto, null ou ausente', () => {
    const base = { jid: 'a@s.whatsapp.net', originalSuggestion: null, finalText: 'oi' }
    expect(() => validateIpcArgs('saveReply', [{ ...base, analysisLastMsgId: 'M1' }])).not.toThrow()
    expect(() => validateIpcArgs('saveReply', [{ ...base, analysisLastMsgId: null }])).not.toThrow()
    expect(() => validateIpcArgs('saveReply', [{ ...base, analysisLastMsgId: 5 }])).toThrow(InvalidIpcArgsError)
  })
})
