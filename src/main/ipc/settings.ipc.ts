import { ipcMain } from 'electron'
import { settingsRepo } from '../db/repositories/settings.repo'
import { getDownloadManager } from '../services/download-manager'

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
  ipcMain.handle('settings:get', async (_event, key: string) => {
    try {
      const value = settingsRepo.get(key)
      return { success: true, data: value }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('settings:getAll', async () => {
    try {
      const all = settingsRepo.getAll()
      return { success: true, data: all }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('settings:set', async (_event, key: string, value: string) => {
    try {
      settingsRepo.set(key, value)
      applyLiveSettings([key])
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('settings:setAll', async (_event, settings: Record<string, string>) => {
    try {
      settingsRepo.setAll(settings)
      applyLiveSettings(Object.keys(settings))
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('settings:delete', async (_event, key: string) => {
    try {
      settingsRepo.delete(key)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}
