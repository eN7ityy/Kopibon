import { settingsRepo } from '../db/repositories/settings.repo'
import { getDownloadManager } from '../services/download-manager'
import { encryptKey, decryptKey } from './auth.ipc'
import { handle } from './handle'

/** Settings that need to be pushed into a running service when they change. */
const LIVE_SETTINGS = new Set(['downloadConcurrency'])

function applyLiveSettings(keys: string[]): void {
  if (!keys.some((key) => LIVE_SETTINGS.has(key))) return
  try {
    getDownloadManager().applyConcurrencyFromSettings()
  } catch {
    /* applying a live setting must never fail the save */
  }
}

/**
 * Settings whose value is a credential, stored encrypted the way the nhentai
 * key already is (`auth.ipc.ts`). The nhentai key gets its own dedicated IPC
 * channel for exactly this reason; Kavita's does not, because the settings
 * pane reads and writes it through this generic channel like any other
 * field. Rather than route it through a second channel, this layer encrypts
 * and decrypts transparently — the renderer store and the settings pane never
 * see anything but the plaintext value.
 */
const ENCRYPTED_SETTINGS = new Set(['kavitaApiKey'])

/**
 * `decryptKey` already falls back to returning its input unchanged when that
 * input is not valid encrypted data — needed here so a key saved before this
 * encryption existed keeps working with no migration step. It is re-encrypted
 * automatically the next time it is saved.
 */
function decryptIfEncrypted(key: string, value: string): string {
  return ENCRYPTED_SETTINGS.has(key) && value ? decryptKey(value) : value
}

function encryptIfSensitive(key: string, value: string): string {
  return ENCRYPTED_SETTINGS.has(key) && value ? encryptKey(value) : value
}

export function registerSettingsIpc(): void {
  handle('settings:get', async (_event, key: string) => {
    const value = settingsRepo.get(key)
    return { success: true, data: value != null ? decryptIfEncrypted(key, value) : value }
  })

  handle('settings:getAll', async () => {
    const all = settingsRepo.getAll()
    for (const key of ENCRYPTED_SETTINGS) {
      if (all[key]) all[key] = decryptIfEncrypted(key, all[key])
    }
    return { success: true, data: all }
  })

  handle('settings:set', async (_event, key: string, value: string) => {
    settingsRepo.set(key, encryptIfSensitive(key, value))
    applyLiveSettings([key])
    return { success: true }
  })

  handle('settings:setAll', async (_event, settings: Record<string, string>) => {
    const toStore: Record<string, string> = {}
    for (const [key, value] of Object.entries(settings)) {
      toStore[key] = encryptIfSensitive(key, value)
    }
    settingsRepo.setAll(toStore)
    applyLiveSettings(Object.keys(settings))
    return { success: true }
  })

  handle('settings:delete', async (_event, key: string) => {
    settingsRepo.delete(key)
    return { success: true }
  })
}
