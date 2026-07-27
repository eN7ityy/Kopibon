import { ipcMain, dialog, BrowserWindow } from 'electron'
import { shell } from 'electron'
import { getApiClient } from '../services/api-client'
import { settingsRepo } from '../db/repositories/settings.repo'

// ─── Auth State (main-process-only) ─────────────────────────────────────────

let loggedIn = false
let username: string | undefined

/**
 * Load saved API key from settings DB and apply it to the client.
 * Called at startup to restore previous session.
 */
export async function restoreAuthFromDb(): Promise<void> {
  const savedKey = settingsRepo.get('nhentai_api_key')
  if (savedKey) {
    const client = getApiClient()
    client.setApiKey(savedKey)

    // Try to validate the saved key
    try {
      const user = await client.getUser()
      loggedIn = true
      username = user.username

      // Fetch and apply rate limit from config
      try {
        const config = await client.getConfig()
        client['rateLimiter'].setRateLimit(config.max_requests_per_minute)
      } catch {
        // Default to 60 if config endpoint fails
        client['rateLimiter'].setRateLimit(60)
      }
    } catch {
      // Saved key is invalid — clear it
      client.setApiKey(null)
      settingsRepo.delete('nhentai_api_key')
      loggedIn = false
      username = undefined
    }
  }
}

export function registerAuthIpc(): void {
  const client = getApiClient()

  /**
   * Validate an API key by calling GET /api/v2/user.
   * If valid, saves the key to settings DB and configures the rate limiter.
   */
  ipcMain.handle('auth:validateKey', async (_event, key: string) => {
    try {
      // Temporarily set the key to test it
      client.setApiKey(key)
      const user = await client.getUser()

      // Key is valid — persist it
      settingsRepo.set('nhentai_api_key', key)
      loggedIn = true
      username = user.username

      // Try to get the authenticated rate limit from config
      try {
        const config = await client.getConfig()
        client['rateLimiter'].setRateLimit(config.max_requests_per_minute)
      } catch {
        // Default to 60 req/min if config endpoint unavailable
        client['rateLimiter'].setRateLimit(60)
      }

      return { success: true, data: { username: user.username } }
    } catch (error) {
      // Key is invalid — remove it from client
      client.setApiKey(null)
      return { success: false, error: 'Invalid API key' }
    }
  })

  /**
   * Get the current authentication status.
   */
  ipcMain.handle('auth:getAuthStatus', async () => {
    return { success: true, data: { loggedIn, username } }
  })

  /**
   * Set the API key on the client without validation (e.g., when restoring
   * a previously validated key from the DB during startup).
   */
  ipcMain.handle('auth:setKey', async (_event, key: string) => {
    client.setApiKey(key)
    return { success: true }
  })

  /**
   * Clear the API key — removes it from client, settings DB, and resets
   * the rate limiter to the anonymous default (30 req/min).
   */
  ipcMain.handle('auth:clearKey', async () => {
    client.setApiKey(null)
    settingsRepo.delete('nhentai_api_key')
    client['rateLimiter'].setRateLimit(30)
    loggedIn = false
    username = undefined
    return { success: true }
  })

  /**
   * Open an external URL in the system browser.
   */
  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    await shell.openExternal(url)
  })

  ipcMain.handle('shell:openPath', async (_event, path: string) => {
    await shell.openPath(path)
  })

  ipcMain.handle('shell:showItemInFolder', async (_event, path: string) => {
    shell.showItemInFolder(path)
  })

  // ─── File Dialogs ──────────────────────────────────────────────────

  ipcMain.handle('dialog:openFile', async (event, options?: { filters?: Array<{ name: string; extensions: string[] }> }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false, error: 'No window found' }

    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: options?.filters || [{ name: 'PDF Files', extensions: ['pdf'] }]
    })

    return { success: true, data: result.canceled ? null : result.filePaths[0] }
  })

  ipcMain.handle('dialog:openDirectory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false, error: 'No window found' }

    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })

    return { success: true, data: result.canceled ? null : result.filePaths[0] }
  })
}
