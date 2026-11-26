import { describe, expect, it } from 'vitest'
import { DEFAULT_SEND_SCHEDULE } from '../../src/shared/sendHours'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { InvalidIpcArgsError, isAppUrl, isExternalHttpUrl, validateIpcArgs } from '../../src/main/guards'
import { INVOKE_METHODS } from '../../src/shared/api'

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
    ok('saveReply', { jid: 'a@s.whatsapp.net', originalSuggestion: 'x', finalText: 'oi', chosenIndex: 1 })
    bad('saveReply', { jid: 'a@s.whatsapp.net', originalSuggestion: 'x', finalText: 'oi', chosenIndex: -1 })
    bad('saveReply', { jid: 'a@s.whatsapp.net', originalSuggestion: 'x', finalText: 'oi', chosenIndex: '1' })
    bad('saveReply', 'texto')
    bad('saveReply')
  })

  it('contatos: tipos certos', () => {
    ok('renameContact', 'a', 'Ana')
    ok('renameContact', 'a', '')
    bad('renameContact', 'a', null)
    ok('setNotes', 'a', 'notas')
    bad('setNotes', '', 'notas')
    ok('listContacts', false)
    bad('listContacts', 'sim')
    ok('listContacts', true, 'all')
    ok('listContacts', false, 'group')
    ok('listContacts', false, 'individual')
    bad('listContacts', false, 'grupos')
    bad('listContacts', false, 1)
  })

  it('saveSettings: só campos conhecidos com tipos válidos', () => {
    ok('saveSettings', { provider: 'claude', dailyCapUsd: 2, groqKey: 'k' })
    bad('saveSettings', { provider: 'gpt' })
    ok('saveSettings', { theme: 'system' })
    ok('saveSettings', { theme: 'dark' })
    bad('saveSettings', { theme: 'auto' })
    bad('saveSettings', { theme: 1 })
    bad('saveSettings', { dailyCapUsd: '2' })
    bad('saveSettings', { outro: 1 })
    bad('saveSettings', null)
    // v0.4.0: envio direto e as três opções, só sim/não
    ok('saveSettings', { directSend: false, sendTyping: true, sendMarkRead: false, sendQuoteInGroups: true })
    bad('saveSettings', { directSend: 'off' })
    bad('saveSettings', { sendTyping: 1 })
    // v0.4.1: horário de envio (7 dias, HH:MM de 15 em 15 min, fim depois do início)
    ok('saveSettings', { sendSchedule: DEFAULT_SEND_SCHEDULE })
    ok('saveSettings', { sendSchedule: { ...DEFAULT_SEND_SCHEDULE, enabled: false } })
    const sched = (day: unknown) => ({ ...DEFAULT_SEND_SCHEDULE, days: [day, ...DEFAULT_SEND_SCHEDULE.days.slice(1)] })
    bad('saveSettings', { sendSchedule: sched({ on: true, start: '18:00', end: '09:00' }) })
    bad('saveSettings', { sendSchedule: sched({ on: true, start: '09:10', end: '18:00' }) })
    bad('saveSettings', { sendSchedule: sched({ on: 'sim', start: '09:00', end: '18:00' }) })
    bad('saveSettings', { sendSchedule: { ...DEFAULT_SEND_SCHEDULE, days: DEFAULT_SEND_SCHEDULE.days.slice(0, 5) } })
    bad('saveSettings', { sendSchedule: 'Seg–Sex' })
  })

  describe('envio direto', () => {
    const TOKEN = '0f8e4f9a-3c1b-4d2e-9a7b-1c2d3e4f5a6b'
    const JID = '5547999998888@s.whatsapp.net'

    it('prepareSend: só jid, texto (não vazio, até 4096 caracteres) e "Forçar envio" (sim/não)', () => {
      ok('prepareSend', { jid: JID, text: 'Oi!' })
      ok('prepareSend', { jid: JID, text: 'Oi!', forced: true })
      ok('prepareSend', { jid: JID, text: 'Oi!', forced: false })
      bad('prepareSend', { jid: JID, text: 'Oi!', forced: 'sim' })
      bad('prepareSend', { jid: JID, text: 'Oi!', forced: 1 })
      bad('prepareSend', { jid: JID, text: '' })
      bad('prepareSend', { jid: '', text: 'Oi' })
      bad('prepareSend', { jid: JID, text: 'x'.repeat(4097) })
      bad('prepareSend', { jid: JID, text: 'Oi', token: TOKEN })
      bad('prepareSend', JID, 'Oi')
    })

    it('sendReply: exige o token no formato, o jid e o texto; campos extras recusados', () => {
      ok('sendReply', { token: TOKEN, jid: JID, text: 'Oi!' })
      ok('sendReply', { token: TOKEN, jid: JID, text: 'Oi!', replyId: 3, originalSuggestion: 'Oi', analysisLastMsgId: 'm1', chosenIndex: 1 })
      ok('sendReply', { token: TOKEN, jid: JID, text: 'Oi!', replyId: null, originalSuggestion: null, analysisLastMsgId: null })
      bad('sendReply', { jid: JID, text: 'Oi!' })
      bad('sendReply', { token: 'qualquer', jid: JID, text: 'Oi!' })
      bad('sendReply', { token: TOKEN, jid: JID, text: '  ' })
      bad('sendReply', { token: TOKEN, jid: JID, text: 'Oi!', replyId: 0 })
      bad('sendReply', { token: TOKEN, jid: JID, text: 'Oi!', chosenIndex: -1 })
      bad('sendReply', { token: TOKEN, jid: JID, text: 'Oi!', quoted: { id: 'x' } })
      bad('sendReply', { token: TOKEN, jid: JID, text: 'Oi!', to: '5511@s.whatsapp.net' })
      // "Forçar envio" fica preso ao token do prepareSend: o sendReply não aceita o campo
      bad('sendReply', { token: TOKEN, jid: JID, text: 'Oi!', forced: true })
    })

    it('cancelSend/checkSend: id inteiro positivo; listSends: um jid', () => {
      ok('cancelSend', 1)
      bad('cancelSend', '1')
      bad('cancelSend', 0)
      ok('checkSend', 2)
      bad('checkSend', 1.5)
      ok('listSends', JID)
      bad('listSends', '')
      bad('listSends', JID, 2)
    })
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

describe('checkForUpdates', () => {
  it('"Verificar agora": sem argumentos (qualquer argumento é recusado)', () => {
    expect(() => validateIpcArgs('checkForUpdates', [])).not.toThrow()
    expect(() => validateIpcArgs('checkForUpdates', [true])).toThrow(InvalidIpcArgsError)
    expect(() => validateIpcArgs('checkForUpdates', [{ force: 1 }])).toThrow(InvalidIpcArgsError)
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

describe('diagnóstico', () => {
  it.each(['copyDiagnostics', 'openLogsFolder'] as const)('%s: sem argumentos (qualquer argumento é recusado)', (m) => {
    expect(() => validateIpcArgs(m, [])).not.toThrow()
    expect(() => validateIpcArgs(m, ['C:\\Windows'])).toThrow(InvalidIpcArgsError)
    expect(() => validateIpcArgs(m, [200])).toThrow(InvalidIpcArgsError)
  })
})

describe('alertas', () => {
  const ok = (m: Parameters<typeof validateIpcArgs>[0], ...a: unknown[]) => expect(() => validateIpcArgs(m, a)).not.toThrow()
  const bad = (m: Parameters<typeof validateIpcArgs>[0], ...a: unknown[]) => expect(() => validateIpcArgs(m, a)).toThrow(InvalidIpcArgsError)

  it('listAlerts: sem argumento ou um jid não vazio', () => {
    ok('listAlerts')
    ok('listAlerts', undefined)
    ok('listAlerts', '5547999998888@s.whatsapp.net')
    bad('listAlerts', '')
    bad('listAlerts', 42)
    bad('listAlerts', 'a', 'b')
  })

  it('dismissAlert: jid não vazio e tipo de alerta conhecido', () => {
    for (const k of ['urgente', 'desanimo', 'reuniao', 'travado', 'esperando']) ok('dismissAlert', 'j@s.whatsapp.net', k)
    bad('dismissAlert', 'j@s.whatsapp.net', 'spam')
    bad('dismissAlert', '', 'urgente')
    bad('dismissAlert', 'j@s.whatsapp.net')
    bad('dismissAlert', 'j@s.whatsapp.net', 'urgente', 'extra')
    bad('dismissAlert', { jid: 'x' }, 'urgente')
  })

  it('rateAlert: id inteiro positivo; 👍 sem motivo; 👎 com motivo conhecido (tipo certo só com "tipo_errado")', () => {
    ok('rateAlert', 3, 'up')
    ok('rateAlert', 3, 'down', { code: 'brincadeira' })
    ok('rateAlert', 3, 'down', { code: 'outro', text: 'explicação' })
    ok('rateAlert', 3, 'down', { code: 'tipo_errado', correctKind: 'travado' })
    ok('rateAlert', 3, 'down', { code: 'tipo_errado', correctKind: null })
    bad('rateAlert', 0, 'up')
    bad('rateAlert', 1.5, 'up')
    bad('rateAlert', '3', 'up')
    bad('rateAlert', 3, 'missed')
    bad('rateAlert', 3, 'up', { code: 'outro' })
    bad('rateAlert', 3, 'down')
    bad('rateAlert', 3, 'down', { code: 'spam' })
    bad('rateAlert', 3, 'down', { code: 'brincadeira', correctKind: 'travado' })
    bad('rateAlert', 3, 'down', { code: 'tipo_errado', correctKind: 'esperando' })
    bad('rateAlert', 3, 'down', { code: 'outro', text: 'x'.repeat(1001) })
    bad('rateAlert', 3, 'down', { code: 'outro', extra: 1 })
  })

  it('reportMissedAlert: jid, tipo da IA, mensagem e texto opcionais', () => {
    ok('reportMissedAlert', 'j@s.whatsapp.net', 'urgente')
    ok('reportMissedAlert', 'j@s.whatsapp.net', 'reuniao', 'M1', 'pediu ligação')
    ok('reportMissedAlert', 'j@s.whatsapp.net', 'travado', null, null)
    bad('reportMissedAlert', 'j@s.whatsapp.net', 'esperando')
    bad('reportMissedAlert', '', 'urgente')
    bad('reportMissedAlert', 'j@s.whatsapp.net', 'urgente', '')
    bad('reportMissedAlert', 'j@s.whatsapp.net', 'urgente', 'M1', 42)
    bad('reportMissedAlert', 'j@s.whatsapp.net', 'urgente', 'M1', 'x', 'extra')
  })

  it('setNeedsReply: jid; "Precisa sim" sem motivo; "Não precisa" com motivo conhecido e texto curto', () => {
    ok('setNeedsReply', 'j@s.whatsapp.net', true)
    ok('setNeedsReply', 'j@s.whatsapp.net', false, { code: 'agradecimento' })
    ok('setNeedsReply', 'j@s.whatsapp.net', false, { code: 'outro', text: 'liguei' })
    ok('setNeedsReply', '1203@g.us', false, { code: 'grupo_nao_comigo' })
    ok('setNeedsReply', 'j@s.whatsapp.net', false, { code: 'respondi_grupo' })
    ok('setNeedsReply', 'j@s.whatsapp.net', false, { code: 'ligacao' })
    // o motivo antigo (v0.2.2) virou "respondi_grupo" + "ligacao"
    bad('setNeedsReply', 'j@s.whatsapp.net', false, { code: 'outro_meio' })
    bad('setNeedsReply', 'j@s.whatsapp.net', false)
    bad('setNeedsReply', 'j@s.whatsapp.net', true, { code: 'outro' })
    bad('setNeedsReply', 'j@s.whatsapp.net', 'false', { code: 'outro' })
    bad('setNeedsReply', 'j@s.whatsapp.net', false, { code: 'brincadeira' })
    bad('setNeedsReply', 'j@s.whatsapp.net', false, { code: 'outro', text: 'x'.repeat(1001) })
    bad('setNeedsReply', 'j@s.whatsapp.net', false, { code: 'outro', extra: 1 })
    bad('setNeedsReply', '', true)
    bad('setNeedsReply', 'j@s.whatsapp.net', false, { code: 'outro' }, 'extra')
  })

  it('confirmNoReply: só o jid', () => {
    ok('confirmNoReply', 'j@s.whatsapp.net')
    bad('confirmNoReply')
    bad('confirmNoReply', '')
    bad('confirmNoReply', 'j@s.whatsapp.net', true)
  })

  it('alertQuality sem argumentos; exportAlertFeedback só com { anonymize: boolean }', () => {
    ok('alertQuality')
    bad('alertQuality', 1)
    ok('exportAlertFeedback', { anonymize: true })
    ok('exportAlertFeedback', { anonymize: false })
    bad('exportAlertFeedback')
    bad('exportAlertFeedback', { anonymize: 'sim' })
    bad('exportAlertFeedback', { anonymize: true, path: 'C:\\x.csv' })
  })
})

describe('base de conhecimento', () => {
  const ok = (m: any, ...a: unknown[]) => expect(() => validateIpcArgs(m, a)).not.toThrow()
  const bad = (m: any, ...a: unknown[]) => expect(() => validateIpcArgs(m, a)).toThrow(InvalidIpcArgsError)

  it('v0.3.0: "setHidden" não existe mais na interface', () => {
    expect((INVOKE_METHODS as readonly string[]).includes('setHidden')).toBe(false)
  })

  it('importar e adicionar: o caminho nunca vem da interface (só o tipo do diálogo)', () => {
    ok('kbList')
    bad('kbList', 1)
    ok('kbImport', 'archive')
    ok('kbImport', 'folder')
    bad('kbImport', '/home/x/pacote.zip')
    bad('kbImport')
    bad('kbImport', 'archive', '/tmp/a.zip')
    ok('kbAddFile')
    bad('kbAddFile', 'C:\\x.md')
  })

  it('colar texto: título e texto não vazios, dentro dos limites', () => {
    ok('kbAddText', 'Dúvidas', 'texto')
    bad('kbAddText', '', 'texto')
    bad('kbAddText', 'Dúvidas', '   ')
    bad('kbAddText', 'x'.repeat(121), 'texto')
    bad('kbAddText', 'Dúvidas', 'x'.repeat(200_001))
    bad('kbAddText', 'Dúvidas')
  })

  it('arquivo e pacote: id inteiro positivo; papel conhecido e/ou "Usar" booleano', () => {
    ok('kbUpdateFile', 3, { role: 'interno' })
    ok('kbUpdateFile', 3, { enabled: false })
    ok('kbUpdateFile', 3, { role: 'desligado', enabled: true })
    bad('kbUpdateFile', 3, {})
    bad('kbUpdateFile', 3, { role: 'secreto' })
    bad('kbUpdateFile', 3, { enabled: 'sim' })
    bad('kbUpdateFile', 3, { role: 'regras', path: '/etc' })
    bad('kbUpdateFile', 0, { role: 'regras' })
    ok('kbSetPackageEnabled', 1, true)
    bad('kbSetPackageEnabled', 1, 'true')
    ok('kbRemovePackage', 2)
    bad('kbRemovePackage', '2')
    ok('kbGetChunk', 9)
    bad('kbGetChunk', 1.5)
    bad('kbGetChunk')
  })

  it('busca geral: texto até 200 caracteres e filtros conhecidos', () => {
    for (const m of ['searchMessages', 'summarizeSearch']) {
      ok(m, 'quem falou sobre precificação?')
      ok(m, 'preço', { kind: 'group', period: '7d', audioOnly: true, jid: 'j@s.whatsapp.net' })
      ok(m, 'preço', { kind: 'all', period: 'all', audioOnly: false, jid: null })
      ok(m, '')
      bad(m)
      bad(m, 42)
      bad(m, 'x'.repeat(201))
      bad(m, 'preço', { kind: 'todos' })
      bad(m, 'preço', { period: '1y' })
      bad(m, 'preço', { audioOnly: 'sim' })
      bad(m, 'preço', { jid: '' })
      bad(m, 'preço', { sql: 'DROP TABLE' })
      bad(m, 'preço', [])
      bad(m, 'preço', {}, 'extra')
    }
  })

  it('cópia de segurança: senha de 6 a 200, token no formato, modo conhecido, sem caminhos da interface', () => {
    const T = '0b6f2d4e-8a1c-4c3e-9f00-1234567890ab'
    ok('backupStatus')
    bad('backupStatus', 1)
    ok('exportBackup', { includeMessages: false })
    ok('exportBackup', { includeMessages: true, password: 'segredo', uiPrefs: { 'saga.focus': '1' } })
    ok('exportBackup', { includeMessages: false, password: '' })
    bad('exportBackup', { includeMessages: false, password: '123' })
    bad('exportBackup', { includeMessages: false, password: 'x'.repeat(201) })
    bad('exportBackup', { includeMessages: 'sim' })
    bad('exportBackup', { includeMessages: false, path: 'C:\\x.sagabackup' })
    bad('exportBackup', { includeMessages: false, uiPrefs: { outro: '1' } })
    bad('exportBackup')
    ok('restoreOpen')
    bad('restoreOpen', 'C:\\copia.sagabackup')
    ok('restoreUnlock', T, 'qualquer')
    bad('restoreUnlock', 'abc', 'qualquer')
    bad('restoreUnlock', T, '')
    ok('restoreApply', T, 'merge')
    ok('restoreApply', T, 'replace')
    bad('restoreApply', T, 'apagar')
    bad('restoreApply', '../x', 'merge')
    ok('chooseBackupFolder')
    bad('chooseBackupFolder', 'C:\\pasta')
    ok('setAutoBackup', { enabled: true })
    ok('setAutoBackup', { password: '' })
    ok('setAutoBackup', { password: 'senha-boa', enabled: false })
    bad('setAutoBackup', {})
    bad('setAutoBackup', { folder: 'C:\\pasta' })
    bad('setAutoBackup', { password: '123' })
  })
})
