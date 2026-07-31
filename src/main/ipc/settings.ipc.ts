import { settingsRepo } from '../db/repositories/settings.repo'
import { getDownloadManager } from '../services/download-manager'
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

export function registerSettingsIpc(): void {
  handle('settings:get', async (_event, key: string) => {
    const value = settingsRepo.get(key)
    return { success: true, data: value }
  })

  handle('settings:getAll', async () => {
    const all = settingsRepo.getAll()
    return { success: true, data: all }
  })

  handle('settings:set', async (_event, key: string, value: string) => {
    settingsRepo.set(key, value)
    applyLiveSettings([key])
    return { success: true }
  })

  handle('settings:setAll', async (_event, settings: Record<string, string>) => {
    settingsRepo.setAll(settings)
    applyLiveSettings(Object.keys(settings))
    return { success: true }
  })

  handle('settings:delete', async (_event, key: string) => {
    settingsRepo.delete(key)
    return { success: true }
  })
}
