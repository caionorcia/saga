import { join } from 'node:path'

/**
 * Nome da pasta de dados do app (`%APPDATA%\saga` no Windows): banco, sessão do WhatsApp, `Local State` do
 * `safeStorage` (chaves cifradas), registros (`logs/saga.log`), mídia e base de conhecimento.
 *
 * Até a 0.4.1 o Electron derivava essa pasta do `name` do package.json ("saga"): o pacote nunca teve `productName`
 * (o `productName` do electron-builder.yml só dá nome ao .exe, ao instalador e aos atalhos). O app passou a se chamar
 * SagaZap, mas a pasta fica a mesma para sempre: mudar aqui perderia os dados de quem já usa.
 */
export const USER_DATA_DIR_NAME = 'saga'

/** Pasta de dados fixa, a partir de `app.getPath('appData')`. */
export function userDataDir(appData: string): string {
  return join(appData, USER_DATA_DIR_NAME)
}

/**
 * Como o Electron deriva o nome do app (e, por ele, a pasta de dados padrão) a partir do package.json:
 * `productName`, senão `name` (lib/browser/init.ts do Electron).
 */
export function electronDefaultAppName(pkg: { name?: string; productName?: string }): string | undefined {
  return pkg.productName?.trim() || pkg.name?.trim()
}

/**
 * Nome do valor em `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` ("Iniciar com o Windows"). Até a 0.4.1 o
 * Electron usava o padrão, o AppUserModelId gerado `electron.app.<nome do app>` = `electron.app.saga`. Fixado para a
 * atualização sobrescrever o mesmo valor com o caminho do SagaZap.exe (em vez de criar um segundo e deixar o antigo
 * apontando para o Saga.exe, que o instalador apaga). O build/installer.nsh usa o mesmo nome.
 */
export const LOGIN_ITEM_NAME = 'electron.app.saga'
