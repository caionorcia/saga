import { safeStorage } from 'electron'
import type { Repo } from '../core/db/repo'
import { SettingsStore, type Cipher } from '../core/settings'

/** Chaves de API cifradas pelo sistema (DPAPI no Windows) via `safeStorage`; guardadas em base64 no `settings_kv`. */
export const safeStorageCipher: Cipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (data) => safeStorage.decryptString(data)
}

export function createSettingsStore(repo: Repo): SettingsStore {
  return new SettingsStore(repo, safeStorageCipher)
}
