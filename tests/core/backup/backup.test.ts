import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../../src/core/clock'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { DEFAULT_SEND_SCHEDULE, cloneSchedule } from '../../../src/shared/sendHours'
import { SettingsStore, type Cipher } from '../../../src/core/settings'
import { BackupManager, autoBackupDue, backupFileName, rotateBackups } from '../../../src/core/backup/manager'
import { BACKUP_VERSION, encodeBackup, openBackup, writeZip } from '../../../src/core/backup/format'
import { readZip } from '../../../src/core/kb/zip'
import { runSearch } from '../../../src/core/search/search'
import type { BackupOpenResult } from '../../../src/shared/backup'

const NOW = 1_764_000_000_000
const DAY = 86_400_000
const ANA = '5547911110000@s.whatsapp.net'
const GRP = '120363000000000002@g.us'
const FAKE_KEYS = { groqKey: 'gsk_FAKE_GROQ_SEGREDO_123456', claudeKey: 'sk-ant-FAKE-CLAUDE-SEGREDO-987', openaiKey: 'sk-FAKE-OPENAI-SEGREDO-555' }
const AUTO_PW = 'senha-auto-FAKE-778899'

/** cifra de mentira (reversível) — o "segredo cifrado" também não pode aparecer no arquivo */
const cipher: Cipher = { isAvailable: () => true, encrypt: (s) => Buffer.from(`enc:${s}`), decrypt: (b) => Buffer.from(b).toString().slice(4) }

function seed(repo: Repo, settings: SettingsStore): void {
  settings.save({ ...FAKE_KEYS, theme: 'dark', provider: 'claude', dailyCapUsd: 2.5, transcriber: 'openai', startWithWindows: true })
  repo.upsertContact({ jid: ANA, pushName: 'Ana Teste' })
  repo.upsertContact({ jid: GRP, pushName: 'Turma Exemplo', isGroup: true })
  repo.renameContact(ANA, 'Ana (aluna exemplo)')
  repo.setNotes(GRP, 'Turma de teste, encontro às quintas')
  repo.insertMessage({ id: 'm1', jid: ANA, fromMe: false, ts: NOW - DAY, kind: 'text', text: 'Como faço a precificação do pacote?', mediaKeyJson: '{"mediaKey":"FAKE_MEDIA_KEY"}', durationSec: null })
  repo.insertMessage({ id: 'm2', jid: ANA, fromMe: false, ts: NOW - DAY + 1, kind: 'audio', text: null, mediaKeyJson: '{"mediaKey":"FAKE_MEDIA_KEY"}', durationSec: 12 })
  repo.setTranscript('m2', 'tenho medo de perder cliente', 'done')
  repo.setAudioPath('m2', '/caminho/secreto/m2.ogg')
  const id = repo.insertApproved({ jid: ANA, contextText: 'Como faço a precificação?', originalSuggestion: 'Sugestão A', finalText: 'Vamos montar juntas na sessão.', provider: 'groq', rejected: ['Sugestão B'] })
  repo.setApprovedSentText(id, 'Vamos montar juntas na sessão!')
  repo.saveFeedback({ alertId: null, jid: ANA, kind: 'urgente', msgId: 'm1', verdict: 'missed', reasonCode: null, reasonText: 'faltou', correctKind: null, contextText: 'ctx', detail: '', model: null })
  repo.saveReplyFeedback({ jid: ANA, msgId: 'm1', alertId: null, verdict: 'reply_not_needed', appNeeds: null, appReason: null, appSource: null, reasonCode: 'encerrada', reasonText: null, contextText: 'ctx', model: 'm' })
  repo.kb.upsertManualFiles({
    name: 'Arquivos avulsos',
    kind: 'manual',
    skipped: 0,
    duplicates: 0,
    files: [
      {
        path: 'precos.md',
        title: 'Preços',
        text: '# Preços\nPacote de 4 encontros',
        size: 30,
        hash: 'h1',
        role: 'conhecimento',
        roleReason: 'teste',
        sections: 1,
        chunks: [{ ord: 0, heading: 'Preços', text: 'Pacote de 4 encontros custa um valor fechado.', sensitive: true }]
      }
    ]
  })
}

describe('cópia de segurança', () => {
  let dir: string
  let clock: FakeClock
  let repo: Repo
  let settings: SettingsStore
  let mgr: BackupManager
  let diag: string[]

  const fresh = () => {
    const r = new Repo(openDb(':memory:'), clock)
    const s = new SettingsStore(r, cipher)
    return { repo: r, settings: s, mgr: new BackupManager({ repo: r, settings: s, cipher, clock, appVersion: '0.3.1', diag: (k, d) => diag.push(`${k} ${d}`) }) }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'saga-backup-'))
    clock = new FakeClock(NOW)
    diag = []
    ;({ repo, settings, mgr } = fresh())
    seed(repo, settings)
    mgr.setAuto({ password: AUTO_PW })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const restoreInto = (target: ReturnType<typeof fresh>, bytes: Buffer, password?: string, mode: 'merge' | 'replace' = 'merge') => {
    let o: BackupOpenResult = target.mgr.open(bytes)
    if (o.status === 'needs_password') o = target.mgr.unlock(o.token, password ?? '')
    if (o.status !== 'preview') throw new Error(`não abriu: ${JSON.stringify(o)}`)
    return { preview: o.preview, result: target.mgr.restore(o.token, mode) }
  }

  it('ida e volta sem senha: respostas, nomes e notas, avaliações, base e configurações; índices refeitos', () => {
    const { bytes, counts } = mgr.exportBytes({ includeMessages: false, uiPrefs: { 'saga.focus': '1', 'saga.contactKind': 'group' } })
    expect(counts).toMatchObject({ approvedReplies: 1, contacts: 2, alertFeedback: 1, replyFeedback: 1, kbPackages: 1, kbFiles: 1, messages: 0 })
    const t = fresh()
    const { preview, result } = restoreInto(t, bytes)
    expect(preview).toMatchObject({ createdAt: NOW, appVersion: '0.3.1', encrypted: false, counts: { approvedReplies: 1, kbFiles: 1 } })
    expect(result).toMatchObject({ status: 'restored', mode: 'merge', uiPrefs: { 'saga.focus': '1', 'saga.contactKind': 'group' } })
    const a = t.repo.listApproved({ limit: 10 })
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ finalText: 'Vamos montar juntas na sessão.', sentText: 'Vamos montar juntas na sessão!', provider: 'groq', rejected: ['Sugestão B'] })
    // índice das respostas (memória) funciona
    expect(t.repo.searchApproved('"montar"*', 5)).toHaveLength(1)
    const contacts = t.repo.listContacts({ includeHidden: true })
    expect(contacts.find((c) => c.jid === ANA)?.displayName).toBe('Ana (aluna exemplo)')
    expect(contacts.find((c) => c.jid === GRP)?.notes).toBe('Turma de teste, encontro às quintas')
    expect(t.repo.listFeedback()).toHaveLength(1)
    expect(t.repo.listReplyFeedback()).toHaveLength(1)
    expect(t.repo.kb.search('"pacote"*', 5)).toHaveLength(1)
    const s = t.settings.get()
    expect(s).toMatchObject({ theme: 'dark', provider: 'claude', dailyCapUsd: 2.5, transcriber: 'openai', startWithWindows: false })
    // chaves nunca vão: é preciso digitar de novo
    expect(s.keys).toEqual({ groq: false, claude: false, openai: false })
    expect(t.repo.listMessages(ANA)).toHaveLength(0)
    // o registro só leva contagens
    expect(diag.join('\n')).not.toMatch(/Ana|precifica|Vamos|Preços/)
  })

  it('horário de envio vai na cópia e volta igual (v0.4.1)', () => {
    const custom = cloneSchedule(DEFAULT_SEND_SCHEDULE)
    custom.days[6] = { on: true, start: '10:00', end: '13:00' }
    custom.days[5] = { on: true, start: '09:00', end: '17:00' }
    settings.save({ sendSchedule: custom })
    const { bytes } = mgr.exportBytes({ includeMessages: false })
    const t = fresh()
    expect(t.settings.get().sendSchedule).toEqual(DEFAULT_SEND_SCHEDULE)
    restoreInto(t, bytes, undefined, 'replace')
    expect(t.settings.get().sendSchedule).toEqual(custom)
    // juntar não troca um horário já escolhido neste computador
    const u = fresh()
    const mine = cloneSchedule(DEFAULT_SEND_SCHEDULE)
    mine.enabled = false
    u.settings.save({ sendSchedule: mine })
    restoreInto(u, bytes, undefined, 'merge')
    expect(u.settings.get().sendSchedule).toEqual(mine)
  })

  it('com senha (AES-256-GCM + scrypt): senha errada dá erro claro; a certa restaura', () => {
    const { bytes } = mgr.exportBytes({ includeMessages: true, password: 'minha senha boa' })
    const t = fresh()
    const o = t.mgr.open(bytes)
    expect(o.status).toBe('needs_password')
    if (o.status !== 'needs_password') return
    expect(t.mgr.unlock(o.token, 'senha errada')).toEqual({ status: 'error', code: 'wrong_password', message: 'Senha incorreta. Confira e tente de novo.' })
    const ok = t.mgr.unlock(o.token, 'minha senha boa')
    expect(ok).toMatchObject({ status: 'preview', preview: { encrypted: true, counts: { messages: 2 } } })
    if (ok.status !== 'preview') return
    expect(t.mgr.restore(ok.token, 'merge')).toMatchObject({ status: 'restored', counts: { messages: 2 } })
    // mensagens e transcrições voltam (sem a mídia) e entram na busca geral
    const msgs = t.repo.listMessages(ANA)
    expect(msgs.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(msgs[1]).toMatchObject({ transcript: 'tenho medo de perder cliente', audioPath: null, mediaKeyJson: null })
    expect(runSearch(t.repo, 'perder cliente', {}, NOW).result.total).toBe(1)
    // o manifesto não entrega nada sem a senha
    const manifest = readZip(bytes, () => true, { fileBytes: 1e8, totalBytes: 1e8, maxFiles: 5 }).entries.find((e) => e.path === 'manifest.json')!
    expect(JSON.parse(manifest.data.toString())).toMatchObject({ format: 'saga-backup', version: BACKUP_VERSION, encrypted: true })
    expect(manifest.data.toString()).not.toMatch(/counts/)
  })

  it('juntar não repete; substituir troca (e pede o que a cópia tem)', () => {
    const { bytes } = mgr.exportBytes({ includeMessages: false })
    // juntar no mesmo banco: nada repetido
    const again = restoreInto({ repo, settings, mgr }, bytes)
    expect(again.result).toMatchObject({ status: 'restored', counts: { approvedReplies: 0, alertFeedback: 0, replyFeedback: 0, kbFiles: 0, contacts: 0 } })
    expect(repo.listApproved({ limit: 10 })).toHaveLength(1)
    expect(repo.kb.counts().chunks).toBe(1)

    // outro computador com coisas próprias
    const t = fresh()
    t.repo.upsertContact({ jid: ANA, pushName: 'Ana' })
    t.repo.renameContact(ANA, 'Nome daqui')
    t.repo.insertApproved({ jid: ANA, contextText: 'x', originalSuggestion: null, finalText: 'Resposta só daqui', provider: 'groq' })
    t.settings.save({ theme: 'light' })
    const merged = restoreInto(t, bytes, undefined, 'merge')
    expect(merged.result.status).toBe('restored')
    expect(t.repo.listApproved({ limit: 10 }).map((a) => a.finalText).sort()).toEqual(['Resposta só daqui', 'Vamos montar juntas na sessão.'])
    // juntar mantém o que já existe aqui (nome e tema), completa o que falta
    expect(t.repo.listContacts({ includeHidden: true }).find((c) => c.jid === ANA)?.displayName).toBe('Nome daqui')
    expect(t.settings.get()).toMatchObject({ theme: 'light', provider: 'claude' })

    const replaced = restoreInto(t, bytes, undefined, 'replace')
    expect(replaced.result.status).toBe('restored')
    expect(t.repo.listApproved({ limit: 10 }).map((a) => a.finalText)).toEqual(['Vamos montar juntas na sessão.'])
    expect(t.repo.listContacts({ includeHidden: true }).find((c) => c.jid === ANA)?.displayName).toBe('Ana (aluna exemplo)')
    expect(t.settings.get().theme).toBe('dark')
    expect(t.repo.searchApproved('"daqui"*', 5)).toHaveLength(0)
  })

  it('arquivo danificado, que não é cópia, de versão mais nova, ou expirado: erros claros, nada muda', () => {
    const { bytes } = mgr.exportBytes({ includeMessages: false })
    const t = fresh()
    const bad = Buffer.from(bytes)
    // estraga os dados (no meio do arquivo)
    for (let i = 200; i < 260; i++) bad[i] ^= 0xff
    expect(t.mgr.open(bad)).toMatchObject({ status: 'error', code: 'corrupted' })
    expect(t.mgr.open(bytes.subarray(0, bytes.length - 30))).toMatchObject({ status: 'error', code: 'corrupted' })
    expect(t.mgr.open(Buffer.from('não sou um zip'))).toMatchObject({ status: 'error', code: 'invalid', message: 'Este arquivo não é uma cópia de segurança do SagaZap.' })
    expect(t.mgr.open(writeZip([{ path: 'outro.txt', data: Buffer.from('x') }]))).toMatchObject({ status: 'error', code: 'invalid' })
    const future = writeZip([
      { path: 'manifest.json', data: Buffer.from(JSON.stringify({ format: 'saga-backup', version: BACKUP_VERSION + 1, createdAt: NOW, appVersion: '9.0.0', encrypted: false })) },
      { path: 'data.json', data: Buffer.from('{}') }
    ])
    expect(t.mgr.open(future)).toMatchObject({ status: 'error', code: 'version' })
    expect(t.mgr.restore('token-que-nao-existe', 'merge')).toMatchObject({ status: 'error', code: 'expired' })
    // senha certa, mas bytes cifrados alterados: não restaura
    const enc = mgr.exportBytes({ includeMessages: false, password: 'segredo1' }).bytes
    const encBad = Buffer.from(enc)
    // um byte dos dados cifrados (logo depois do nome da entrada no cabeçalho local)
    encBad[encBad.indexOf('data.enc') + 'data.enc'.length + 5] ^= 0x01
    const o = t.mgr.open(encBad)
    if (o.status === 'needs_password') expect(t.mgr.unlock(o.token, 'segredo1').status).toBe('error')
    else expect(o.status).toBe('error')
    expect(t.repo.listApproved({ limit: 10 })).toHaveLength(0)
  })

  it('nenhum segredo no arquivo: chaves, senha da cópia automática, chave da mídia e caminhos', () => {
    for (const opts of [{ includeMessages: true }, { includeMessages: false }, { includeMessages: true, password: 'outra senha' }]) {
      const { bytes } = mgr.exportBytes(opts)
      // bytes crus e o conteúdo descompactado de cada entrada
      const texts = [bytes.toString('latin1'), bytes.toString('utf8')]
      for (const e of readZip(bytes, () => true, { fileBytes: 1e8, totalBytes: 1e8, maxFiles: 5 }).entries) texts.push(e.data.toString('utf8'))
      if (!opts.password) {
        const o = openBackup(bytes)
        texts.push(o.payload.toString('utf8'))
      }
      const all = texts.join('\n')
      for (const k of [...Object.values(FAKE_KEYS), AUTO_PW, 'FAKE_MEDIA_KEY', '/caminho/secreto', 'enc:', 'backup.auto', 'key.groq', Buffer.from(`enc:${FAKE_KEYS.groqKey}`).toString('base64')]) {
        expect(all).not.toContain(k)
      }
    }
  })

  it('cópia automática: semanal, na pasta escolhida, mantém as 5 mais novas; só contagens no registro', () => {
    expect(mgr.runAutoIfDue()).toBe('off')
    mgr.setAuto({ enabled: true })
    expect(mgr.runAutoIfDue()).toBe('off')
    const folder = join(dir, 'Google Drive', 'SagaZap')
    mgr.setAutoFolder(folder)
    // cópias antigas já na pasta (e um arquivo qualquer, que não é apagado)
    mkdirSync(folder, { recursive: true })
    for (let i = 1; i <= 6; i++) writeFileSync(join(folder, backupFileName(NOW - (20 + i) * DAY)), 'velha')
    writeFileSync(join(folder, 'notas.txt'), 'x')
    expect(mgr.runAutoIfDue()).toBe('done')
    const files = readdirSync(folder).sort()
    expect(files.filter((f) => f.endsWith('.sagabackup'))).toHaveLength(5)
    expect(files).toContain(backupFileName(NOW))
    expect(files).toContain('notas.txt')
    expect(mgr.status()).toMatchObject({ lastAt: NOW, auto: { enabled: true, folder, hasPassword: true, lastAt: NOW, lastError: null } })
    // a automática usa a senha guardada
    const t = fresh()
    const o = t.mgr.open(readFileSync(join(folder, backupFileName(NOW))))
    expect(o.status).toBe('needs_password')
    if (o.status === 'needs_password') expect(t.mgr.unlock(o.token, AUTO_PW).status).toBe('preview')
    // de novo no mesmo dia: não
    clock.advance(DAY)
    expect(mgr.runAutoIfDue()).toBe('not_due')
    expect(diag.filter((d) => d.startsWith('auto_backup') || d.startsWith('backup_export')).join('\n')).not.toMatch(/Google|SagaZap-copia|Ana/)
  })

  it('pasta que não dá para gravar: registra o erro e mostra na tela', () => {
    mgr.setAuto({ enabled: true })
    const file = join(dir, 'arquivo')
    writeFileSync(file, 'x')
    mgr.setAutoFolder(join(file, 'sub'))
    expect(mgr.runAutoIfDue()).toBe('error')
    expect(mgr.status().auto.lastError).toBeTruthy()
  })

  it('regras: semana, nome do arquivo e rotação', () => {
    expect(autoBackupDue(null, NOW)).toBe(true)
    expect(autoBackupDue(NOW - 6 * DAY, NOW)).toBe(false)
    expect(autoBackupDue(NOW - 7 * DAY, NOW)).toBe(true)
    expect(autoBackupDue(NOW + DAY, NOW)).toBe(true)
    expect(backupFileName(new Date(2026, 10, 3, 10).getTime())).toBe('SagaZap-copia-2026-11-03.sagabackup')
    expect(rotateBackups(dir)).toBe(0)
  })

  it('rotação: as cópias antigas (Saga-copia-…) e as novas (SagaZap-copia-…) entram juntas, pela data', () => {
    const names = [
      'Saga-copia-2026-10-01.sagabackup',
      'Saga-copia-2026-10-08.sagabackup',
      'Saga-copia-2026-10-15.sagabackup',
      'SagaZap-copia-2026-10-22.sagabackup',
      'SagaZap-copia-2026-10-29.sagabackup',
      'SagaZap-copia-2026-11-05.sagabackup',
      'SagaZap-copia-2026-11-05-2.sagabackup'
    ]
    for (const n of names) writeFileSync(join(dir, n), 'x')
    writeFileSync(join(dir, 'outro-arquivo.sagabackup'), 'x')
    expect(rotateBackups(dir, 5)).toBe(2)
    expect(readdirSync(dir).sort()).toEqual([...names.slice(2), 'outro-arquivo.sagabackup'].sort())
  })

  it('a cópia é um .zip de verdade (Windows abre) com o manifesto', () => {
    const bytes = encodeBackup('{"approvedReplies":[]}', { createdAt: NOW, appVersion: 'x', counts: { approvedReplies: 0, contacts: 0, alertFeedback: 0, replyFeedback: 0, kbPackages: 0, kbFiles: 0, settings: 0, messages: 0 } })
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50)
    const comp = bytes.subarray(30 + 'manifest.json'.length, 30 + 'manifest.json'.length + bytes.readUInt32LE(18))
    expect(JSON.parse(inflateRawSync(comp).toString())).toMatchObject({ format: 'saga-backup', encrypted: false })
  })
})
