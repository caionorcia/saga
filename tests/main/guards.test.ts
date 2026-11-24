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
