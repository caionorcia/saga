import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOGIN_ITEM_NAME, USER_DATA_DIR_NAME, electronDefaultAppName, userDataDir } from '../../src/main/appPaths'

const root = join(import.meta.dirname, '../..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')
const pkg = JSON.parse(read('package.json')) as { name?: string; productName?: string; version: string }
const builder = read('electron-builder.yml')

describe('pasta de dados depois do nome SagaZap', () => {
  it('é a mesma que o Electron derivava até a 0.4.1 (package.json "name", sem "productName")', () => {
    expect(USER_DATA_DIR_NAME).toBe('saga')
    // um `productName` no package.json mudaria o nome do app (e a pasta padrão, o AppUserModelId e o item de
    // "Iniciar com o Windows"); o nome SagaZap fica só no electron-builder.yml
    expect(pkg.productName).toBeUndefined()
    expect(pkg.name).toBe('saga')
    expect(electronDefaultAppName(pkg)).toBe(USER_DATA_DIR_NAME)
  })

  it('fica dentro de appData', () => {
    expect(userDataDir('C:\\Users\\Ana\\AppData\\Roaming').replace(/\\/g, '/')).toBe('C:/Users/Ana/AppData/Roaming/saga')
    expect(userDataDir('/home/ana/.config').replace(/\\/g, '/')).toBe('/home/ana/.config/saga')
  })

  it('o main fixa a pasta antes de qualquer leitura de userData e não renomeia o app', () => {
    const src = read('src/main/index.ts')
    const pin = src.indexOf("app.setPath('userData', userDataDir(app.getPath('appData')))")
    expect(pin).toBeGreaterThan(0)
    expect(src.slice(0, pin)).not.toContain("app.getPath('userData')")
    expect(src.indexOf("app.getPath('userData')", pin + 1)).toBeGreaterThan(pin)
    expect(src.indexOf('requestSingleInstanceLock')).toBeGreaterThan(pin)
    expect(src).not.toMatch(/app\.setName|app\.name\s*=/)
  })
})

describe('instalador SagaZap atualizando o Saga 0.4.1', () => {
  it('mesmo appId (mesma chave de desinstalação/GUID do NSIS), nome e atalhos novos', () => {
    expect(builder).toMatch(/^appId: br\.com\.saga\.mentoria$/m)
    expect(builder).toMatch(/^productName: SagaZap$/m)
    expect(builder).toMatch(/^\s+shortcutName: SagaZap$/m)
    expect(builder).toMatch(/^\s+artifactName: SagaZap-Setup-\$\{version\}\.\$\{ext\}$/m)
  })

  it('o include do NSIS limpa os atalhos "Saga" e corrige o "Iniciar com o Windows"', () => {
    const nsh = read('build/installer.nsh')
    expect(nsh).toMatch(/!macro customInstall/)
    expect(nsh).toContain('$DESKTOP\\Saga.lnk')
    expect(nsh).toContain('$SMPROGRAMS\\Saga.lnk')
    // o mesmo valor que o app grava (o AppUserModelId padrão de até a 0.4.1: electron.app.<nome do app>)
    expect(LOGIN_ITEM_NAME).toBe(`electron.app.${USER_DATA_DIR_NAME}`)
    expect(nsh.match(/"electron\.app\.saga"/g)).toHaveLength(2)
  })

  it('o workflow de release publica os arquivos com o nome novo', () => {
    const wf = read('.github/workflows/release.yml')
    expect(wf).toContain('dist/SagaZap-Setup-$VERSION.exe dist/SagaZap-Setup-$VERSION.exe.blockmap dist/latest.yml')
    expect(wf).not.toMatch(/dist\/Saga-Setup/)
    expect(read('.github/workflows/ci.yml')).toContain('dist/SagaZap-Setup-*.exe')
  })
})
