import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { cp, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap
} from '@whiskeysockets/baileys'

export interface AtomicAuthState {
  state: AuthenticationState
  saveCreds(): Promise<void>
  /** Copia `dir` → `backupDir` (chamar após cada conexão aberta com sucesso). */
  backup(): Promise<void>
  /** Substitui `dir` pelo backup. `false` se não há backup utilizável. */
  restoreBackup(): boolean
  /** Apaga a sessão e o backup (a próxima conexão pede QR). */
  wipe(): void
}

const CREDS = 'creds.json'
const fixFileName = (file: string) => file.replace(/\//g, '__').replace(/:/g, '-')

function hasCreds(dir: string): boolean {
  try {
    JSON.parse(readFileSync(join(dir, CREDS), 'utf8'))
    return true
  } catch {
    return false
  }
}

/** Troca `target` pelo conteúdo de `source` copiando para `target.tmp` e depois renomeando. */
function replaceDirSync(source: string, target: string): void {
  const tmp = `${target}.tmp`
  const old = `${target}.old`
  rmSync(tmp, { recursive: true, force: true })
  rmSync(old, { recursive: true, force: true })
  cpSync(source, tmp, { recursive: true })
  if (existsSync(target)) renameSync(target, old)
  renameSync(tmp, target)
  rmSync(old, { recursive: true, force: true })
}

/**
 * Igual ao `useMultiFileAuthState` do Baileys, mas cada gravação vai para `arquivo.tmp`
 * e depois `rename` (uma queda no meio não deixa um JSON pela metade).
 */
export async function useAtomicAuthState(dir: string, backupDir: string): Promise<AtomicAuthState> {
  await mkdir(dir, { recursive: true })

  // gravações por arquivo em série; backup() espera as gravações em andamento e segura as novas
  const fileChains = new Map<string, Promise<unknown>>()
  const inflight = new Set<Promise<unknown>>()
  let gate: Promise<void> = Promise.resolve()

  const withFile = async <T>(file: string, fn: (path: string) => Promise<T>): Promise<T> => {
    await gate
    const path = join(dir, fixFileName(file))
    const prev = fileChains.get(path) ?? Promise.resolve()
    const run = prev.catch(() => {}).then(() => fn(path))
    fileChains.set(path, run)
    inflight.add(run)
    try {
      return await run
    } finally {
      inflight.delete(run)
      if (fileChains.get(path) === run) fileChains.delete(path)
    }
  }

  const writeData = (data: unknown, file: string) =>
    withFile(file, async (path) => {
      const tmp = `${path}.tmp`
      await writeFile(tmp, JSON.stringify(data, BufferJSON.replacer))
      await rename(tmp, path)
    })

  const readData = async (file: string): Promise<any> => {
    try {
      const raw = await readFile(join(dir, fixFileName(file)), 'utf8')
      return JSON.parse(raw, BufferJSON.reviver)
    } catch {
      return null
    }
  }

  const removeData = (file: string) => withFile(file, (path) => unlink(path).catch(() => {}))

  const restoreBackup = (): boolean => {
    if (!hasCreds(backupDir)) return false
    replaceDirSync(backupDir, dir)
    return true
  }

  // creds.json existe mas está ilegível: tenta o backup antes de cair num QR novo
  if (existsSync(join(dir, CREDS)) && !hasCreds(dir)) restoreBackup()

  const creds: AuthenticationCreds = (await readData(CREDS)) || initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {}
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`)
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value)
              }
              data[id] = value
            })
          )
          return data
        },
        set: async (data) => {
          const tasks: Promise<unknown>[] = []
          for (const category in data) {
            const entries = (data as Record<string, Record<string, unknown>>)[category]
            for (const id in entries) {
              const value = entries[id]
              const file = `${category}-${id}.json`
              tasks.push(value ? writeData(value, file) : removeData(file))
            }
          }
          await Promise.all(tasks)
        }
      }
    },
    saveCreds: () => writeData(creds, CREDS),
    backup: async () => {
      let release!: () => void
      const prev = gate
      gate = new Promise<void>((r) => (release = r))
      try {
        await prev
        await Promise.allSettled([...inflight])
        if (!hasCreds(dir)) return // nada válido para guardar: não sobrescreve um backup bom
        const tmp = `${backupDir}.tmp`
        const old = `${backupDir}.old`
        await rm(tmp, { recursive: true, force: true })
        await cp(dir, tmp, { recursive: true, filter: (src) => !src.endsWith('.tmp') })
        await rm(old, { recursive: true, force: true })
        if (existsSync(backupDir)) await rename(backupDir, old)
        await rename(tmp, backupDir)
        await rm(old, { recursive: true, force: true })
      } finally {
        release()
      }
    },
    restoreBackup,
    wipe: () => {
      rmSync(dir, { recursive: true, force: true })
      rmSync(backupDir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
    }
  }
}
