import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../../src/core/clock'
import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { KbImportError, importArchive, importFolder, importPastedText, importSingleFile } from '../../../src/core/kb/importer'
import { docxToText } from '../../../src/core/kb/text'
import { KB_MANUAL_PACKAGE } from '../../../src/shared/kb'
import { MEETING_MD, PRICES_MD, RULES_MD, demoPackageZip, makeZip } from './fixtures'

let dir: string
let repo: Repo
let clock: FakeClock

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'saga-kb-'))
  clock = new FakeClock(1_700_000_000_000)
  repo = new Repo(openDb(':memory:'), clock)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('importArchive', () => {
  it('nome pela pasta raiz, sem repetidos, sem .zip dentro nem imagens, e com o papel de cada arquivo', () => {
    const d = importArchive(demoPackageZip(), 'qualquer.zip')
    expect(d.name).toBe('Metodo Exemplo')
    expect(d.duplicates).toBe(1) // a cópia em skills/…/references
    expect(d.skipped).toBe(2) // copia.zip e capa.png
    const byPath = Object.fromEntries(d.files.map((f) => [f.path, f.role]))
    expect(byPath).toEqual({
      'anuncios/ganchos.md': 'desligado',
      'atendimentos.md': 'interno',
      'conhecimento/01-regras-e-tom.md': 'regras',
      'conhecimento/02-pacotes-de-preco.md': 'conhecimento',
      'conhecimento/03-conversa-ate-a-reuniao.md': 'conhecimento',
      'conhecimento/05-bastidores.md': 'interno',
      'LEIA-ME.md': 'desligado',
      'skills/metodo/SKILL.md': 'regras'
    })
    const prices = d.files.find((f) => f.path.endsWith('02-pacotes-de-preco.md'))!
    expect(prices.title).toBe('Pacotes de preco')
    expect(prices.chunks.map((c) => c.heading)).toEqual(['Três pacotes', 'Como apresentar o preço'])
  })

  it('sem pasta raiz: nome do arquivo (sem .zip/.skill)', () => {
    const d = importArchive(makeZip([{ name: 'SKILL.md', data: '---\ndescription: Faz algo útil.\n---\n# Skill\n\nCorpo.' }]), 'C:/x/minha-skill.skill')
    expect(d.name).toBe('minha-skill')
  })

  it('recusa pacote sem texto', () => {
    expect(() => importArchive(makeZip([{ name: 'a.png', data: 'x' }]), 'a.zip')).toThrow(KbImportError)
  })
})

describe('importFolder, arquivo avulso e texto colado', () => {
  it('lê a pasta sem seguir links nem entrar em pastas ocultas', () => {
    const root = join(dir, 'Meu Pacote')
    mkdirSync(join(root, 'conhecimento'), { recursive: true })
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, 'conhecimento', '02-pacotes.md'), PRICES_MD)
    writeFileSync(join(root, '.git', 'config.md'), '# segredo\n\nnão ler')
    writeFileSync(join(root, 'foto.jpg'), 'x')
    writeFileSync(join(dir, 'fora.md'), '# Fora\n\nnão ler este arquivo')
    symlinkSync(join(dir, 'fora.md'), join(root, 'atalho.md'))
    const d = importFolder(root)
    expect(d.name).toBe('Meu Pacote')
    expect(d.files.map((f) => f.path)).toEqual(['conhecimento/02-pacotes.md'])
    expect(d.skipped).toBe(3) // .git, foto.jpg, atalho.md
  })

  it('.md, .txt e .docx avulsos; extensão desconhecida é recusada', () => {
    writeFileSync(join(dir, 'notas.txt'), 'Notas soltas sobre reunião de alinhamento com a turma.')
    expect(importSingleFile(join(dir, 'notas.txt'))).toMatchObject({ name: KB_MANUAL_PACKAGE, kind: 'manual', files: [{ path: 'notas.txt' }] })
    const xml =
      '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Pacotes &amp; preços</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">Três opções, </w:t></w:r><w:r><w:t>sempre, da mais completa à essencial.</w:t></w:r></w:p></w:body></w:document>'
    const docx = makeZip([{ name: '[Content_Types].xml', data: '<x/>' }, { name: 'word/document.xml', data: xml }])
    expect(docxToText(docx, 1_000_000)).toBe('# Pacotes & preços\n\nTrês opções, sempre, da mais completa à essencial.')
    writeFileSync(join(dir, 'guia.docx'), docx)
    const d = importSingleFile(join(dir, 'guia.docx'))
    expect(d.files[0].path).toBe('guia.md')
    expect(d.files[0].chunks[0].heading).toBe('Pacotes & preços')
    writeFileSync(join(dir, 'x.pdf'), '%PDF')
    expect(() => importSingleFile(join(dir, 'x.pdf'))).toThrow(KbImportError)
  })

  it('texto colado: título limpo e obrigatório', () => {
    expect(importPastedText('  Dúvidas: da turma?  ', '# A\n\nTexto colado aqui, com conteúdo.').files[0].path).toBe('Dúvidas da turma.md')
    expect(() => importPastedText('  ', 'x')).toThrow(KbImportError)
    expect(() => importPastedText('t', '   ')).toThrow(KbImportError)
  })
})

describe('KbRepo', () => {
  it('reimportar troca o pacote de uma vez e mantém o papel que o mentor mudou', () => {
    const first = repo.kb.replacePackage(importArchive(demoPackageZip(), 'p.zip'))
    expect(first.replaced).toBe(false)
    const [pkg] = repo.kb.listPackages()
    const prices = pkg.files.find((f) => f.path.endsWith('02-pacotes-de-preco.md'))!
    const meeting = pkg.files.find((f) => f.path.endsWith('03-conversa-ate-a-reuniao.md'))!
    repo.kb.updateFile(prices.id, { role: 'interno' })
    repo.kb.updateFile(meeting.id, { enabled: false })
    const oldHit = repo.kb.search('"tres"*', 10)
    expect(oldHit.length).toBeGreaterThan(0)

    const zip2 = makeZip([
      { name: 'Metodo Exemplo/conhecimento/02-pacotes-de-preco.md', data: PRICES_MD.replace('Três pacotes', 'Quatro pacotes') },
      { name: 'Metodo Exemplo/conhecimento/03-conversa-ate-a-reuniao.md', data: MEETING_MD },
      { name: 'Metodo Exemplo/conhecimento/01-regras-e-tom.md', data: RULES_MD }
    ])
    expect(repo.kb.replacePackage(importArchive(zip2, 'p.zip')).replaced).toBe(true)
    const [again] = repo.kb.listPackages()
    expect(again.files).toHaveLength(3)
    expect(again.files.find((f) => f.path.endsWith('02-pacotes-de-preco.md'))).toMatchObject({ role: 'interno', autoRole: 'conhecimento' })
    expect(again.files.find((f) => f.path.endsWith('03-conversa-ate-a-reuniao.md'))!.enabled).toBe(false)
    // o índice antigo saiu junto
    expect(repo.kb.getChunk(oldHit[0].id)).toBeNull()
    expect(repo.kb.counts()).toMatchObject({ packages: 1, files: 3 })
  })

  it('reimportação que falha no meio não perde o pacote antigo', () => {
    repo.kb.replacePackage(importArchive(demoPackageZip(), 'p.zip'))
    const before = repo.kb.counts()
    const bad = importArchive(demoPackageZip(), 'p.zip')
    // dois arquivos com o mesmo caminho: o segundo INSERT viola UNIQUE e a transação volta
    bad.files.push({ ...bad.files[0] })
    expect(() => repo.kb.replacePackage(bad)).toThrow()
    expect(repo.kb.counts()).toEqual(before)
  })

  it('arquivos avulsos: o de mesmo nome é substituído; remover pacote limpa o índice', () => {
    repo.kb.upsertManualFiles(importPastedText('Dúvidas', '# Reunião\n\nComo remarcar a reunião com calma.'))
    const r = repo.kb.upsertManualFiles(importPastedText('Dúvidas', '# Reunião\n\nNova versão do texto sobre remarcar.'))
    expect(r.replaced).toBe(true)
    const [manual] = repo.kb.listPackages()
    expect(manual).toMatchObject({ name: KB_MANUAL_PACKAGE, kind: 'manual' })
    expect(manual.files).toHaveLength(1)
    expect(repo.kb.search('"versao"*', 5)).toHaveLength(1)
    expect(repo.kb.search('"calma"*', 5)).toHaveLength(0)
    expect(repo.kb.deletePackage(manual.id)).toBe(true)
    expect(repo.kb.counts()).toEqual({ packages: 0, files: 0, chunks: 0 })
    expect(repo.kb.search('"versao"*', 5)).toHaveLength(0)
  })

  it('a busca ignora desligados, arquivos e pacotes fora de uso, e regras', () => {
    repo.kb.replacePackage(importArchive(demoPackageZip(), 'p.zip'))
    const roles = () => new Set(repo.kb.search('"pacot"* OR "ganch"* OR "postura"* OR "reuniao"*', 50).map((h) => h.role))
    expect([...roles()].sort()).toEqual(['conhecimento', 'interno'])
    const [pkg] = repo.kb.listPackages()
    repo.kb.setPackageEnabled(pkg.id, false)
    expect(roles().size).toBe(0)
    expect(repo.kb.hasActive()).toBe(false)
    expect(repo.kb.search('"x" AND (', 5)).toEqual([]) // expressão inválida
  })
})
