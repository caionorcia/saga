import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock } from '../../src/core/clock'
import { openDb } from '../../src/core/db/db'
import { Repo } from '../../src/core/db/repo'
import { SettingsStore, type Cipher } from '../../src/core/settings'
import { SagaService, type WaClientLike } from '../../src/core/service'
import { demoPackageZip } from './kb/fixtures'

const cipher: Cipher = { isAvailable: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => Buffer.from(b).toString() }

const fakeWa = (): WaClientLike => ({
  on: () => undefined,
  start: async () => {},
  stop: async () => {}
} as unknown as WaClientLike)

describe('SagaService: base de conhecimento', () => {
  let tmp: string
  let repo: Repo
  let service: SagaService
  let diag: string[]

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'saga-svc-kb-'))
    const clock = new FakeClock(1_764_000_000_000)
    repo = new Repo(openDb(':memory:'), clock)
    diag = []
    service = new SagaService({
      repo,
      settings: new SettingsStore(repo, cipher),
      clock,
      rng: () => 0,
      paths: { authDir: join(tmp, 'auth'), backupDir: join(tmp, 'bk'), mediaDir: join(tmp, 'media') },
      hasFreeSpace: async () => true,
      waClientFactory: fakeWa,
      diag: (k: string, d: string) => diag.push(`${k} ${d}`)
    } as never)
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('importa, reimporta (substitui) e registra só contagens', async () => {
    const file = join(tmp, 'pacote.zip')
    writeFileSync(file, demoPackageZip())
    const r = await service.kbImportPackage(file, 'archive')
    expect(r).toMatchObject({ status: 'imported', packageName: 'Metodo Exemplo', files: 8, duplicates: 1, skipped: 2, replaced: false })
    expect((await service.kbImportPackage(file, 'archive')) as { replaced: boolean }).toMatchObject({ replaced: true })
    const list = await service.kbList()
    expect(list).toHaveLength(1)
    const events = repo.recentEvents(10).filter((e) => e.kind === 'kb_import')
    expect(events).toHaveLength(2)
    for (const e of events) {
      expect(e.detail).toMatch(/^\d+ arquivo\(s\), \d+ seção\(ões\), \d+ ignorado\(s\), \d+ repetido\(s\)/)
      expect(e.detail).not.toMatch(/Metodo|pacote|preço/i)
    }
  })

  it('erros de importação viram mensagem para a tela (sem detalhes no registro)', async () => {
    const file = join(tmp, 'falso.zip')
    writeFileSync(file, 'não é zip')
    expect(await service.kbImportPackage(file, 'archive')).toEqual({ status: 'error', message: 'O arquivo não é um .zip válido.' })
    expect(await service.kbImportPackage(join(tmp, 'nao-existe.zip'), 'archive')).toMatchObject({ status: 'error' })
    expect(await service.kbAddText('  ', 'x')).toEqual({ status: 'error', message: 'Dê um título ao texto.' })
    const errs = repo.recentEvents(10).filter((e) => e.kind === 'kb_import_error')
    expect(errs.map((e) => e.detail).sort()).toEqual(['Error', 'arquivo recusado', 'arquivo recusado'])
  })

  it('papel, "Usar", remover e ver um trecho', async () => {
    await service.kbAddText('Dúvidas', '# Reunião\n\nComo remarcar a reunião sem perder o ritmo.')
    const [pkg] = await service.kbList()
    const f = pkg.files[0]
    await service.kbUpdateFile(f.id, { role: 'interno', enabled: false })
    expect((await service.kbList())[0].files[0]).toMatchObject({ role: 'interno', enabled: false })
    await expect(service.kbUpdateFile(999, { enabled: true })).rejects.toThrow()
    await service.kbSetPackageEnabled(pkg.id, false)
    expect((await service.kbList())[0].enabled).toBe(false)
    const chunkId = (repo.kb as unknown as { db: { prepare: (s: string) => { get: () => { id: number } } } }).db.prepare('SELECT id FROM kb_chunks').get().id
    expect(await service.kbGetChunk(chunkId)).toMatchObject({ breadcrumb: 'Arquivos avulsos › Dúvidas › Reunião' })
    await service.kbRemovePackage(pkg.id)
    expect(await service.kbList()).toEqual([])
    expect(await service.kbGetChunk(chunkId)).toBeNull()
  })
})
