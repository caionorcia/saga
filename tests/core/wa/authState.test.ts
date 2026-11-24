import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useAtomicAuthState } from '../../../src/core/wa/authState'

describe('useAtomicAuthState', () => {
  let tmp: string
  let dir: string
  let backupDir: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'saga-auth-'))
    dir = join(tmp, 'auth')
    backupDir = join(tmp, 'auth-backup')
  })

  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('gravar a chave cria o arquivo final e nenhum .tmp sobra', async () => {
    const a = await useAtomicAuthState(dir, backupDir)
    await a.state.keys.set({ 'pre-key': { '1': { public: Buffer.from([1, 2]), private: Buffer.from([3, 4]) } } } as any)
    await a.saveCreds()
    const files = readdirSync(dir)
    expect(files).toContain('pre-key-1.json')
    expect(files).toContain('creds.json')
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([])

    const got = await a.state.keys.get('pre-key', ['1'])
    expect(Buffer.from(got['1']!.public).equals(Buffer.from([1, 2]))).toBe(true)
  })

  it('valor null remove a chave', async () => {
    const a = await useAtomicAuthState(dir, backupDir)
    await a.state.keys.set({ session: { 'x:1': Buffer.from([9]) } } as any)
    expect(readdirSync(dir)).toContain('session-x-1.json')
    await a.state.keys.set({ session: { 'x:1': null } } as any)
    expect(readdirSync(dir)).not.toContain('session-x-1.json')
  })

  it('backup() + arquivo corrompido + restoreBackup() devolve o conteúdo original', async () => {
    const a = await useAtomicAuthState(dir, backupDir)
    await a.saveCreds()
    const original = readFileSync(join(dir, 'creds.json'), 'utf8')
    await a.backup()
    expect(existsSync(join(backupDir, 'creds.json'))).toBe(true)

    writeFileSync(join(dir, 'creds.json'), '{corrompido')
    expect(a.restoreBackup()).toBe(true)
    expect(readFileSync(join(dir, 'creds.json'), 'utf8')).toBe(original)

    // recarregar lê as mesmas credenciais
    const b = await useAtomicAuthState(dir, backupDir)
    expect(b.state.creds.registrationId).toBe(a.state.creds.registrationId)
  })

  it('restoreBackup() sem backup devolve false e não mexe na pasta', async () => {
    const a = await useAtomicAuthState(dir, backupDir)
    await a.saveCreds()
    expect(a.restoreBackup()).toBe(false)
    expect(existsSync(join(dir, 'creds.json'))).toBe(true)
  })

  it('creds.json corrompido no carregamento é recuperado do backup', async () => {
    const a = await useAtomicAuthState(dir, backupDir)
    await a.saveCreds()
    await a.backup()
    writeFileSync(join(dir, 'creds.json'), '{corrompido')
    const b = await useAtomicAuthState(dir, backupDir)
    expect(b.state.creds.registrationId).toBe(a.state.creds.registrationId)
  })

  it('wipe() apaga a sessão e o backup', async () => {
    const a = await useAtomicAuthState(dir, backupDir)
    await a.saveCreds()
    await a.backup()
    a.wipe()
    expect(existsSync(join(dir, 'creds.json'))).toBe(false)
    expect(existsSync(join(backupDir, 'creds.json'))).toBe(false)
  })
})
