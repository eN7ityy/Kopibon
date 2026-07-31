import { dialog, BrowserWindow, safeStorage } from 'electron'
import { shell } from 'electron'
import { getApiClient } from '../services/api-client'
import { settingsRepo } from '../db/repositories/settings.repo'
import { handle } from './handle'

// ─── Auth State (main-process-only) ─────────────────────────────────────────

let loggedIn = false
let username: string | undefined

// ─── Key Encryption (safeStorage → OS keychain) ────────────────────────────

export function encryptKey(key: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(key).toString('base64')
  }
  return key
}

/**
 * Decrypt a stored API key. Exported so worker-spawning code (e.g. the
 * library sync) can authenticate its own requests.
 */
export function decryptKey(stored: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      return stored
    }
  }
  return stored
}

/**
 * Get the currently stored (decrypted) API key, if any.
 */
export function getStoredApiKey(): string | undefined {
  const encrypted = settingsRepo.get('nhentai_api_key')
  if (!encrypted) return undefined
  try {
    return decryptKey(encrypted)
  } catch {
    return undefined
  }
}

/**
 * Load saved API key from settings DB and apply it to the client.
 * Called at startup to restore previous session.
 */
export async function restoreAuthFromDb(): Promise<void> {
  const savedKey = getStoredApiKey()
  if (!savedKey) return

  const client = getApiClient()
  // setApiKey() also switches the rate limiter to the authenticated
  // per-endpoint limits.
  client.setApiKey(savedKey)

  // Try to validate the saved key
  try {
    const user = await client.getUser()
    loggedIn = true
    username = user.username
  } catch {
    // Saved key is invalid — clear it and fall back to anonymous limits
    client.setApiKey(null)
    settingsRepo.delete('nhentai_api_key')
    loggedIn = false
    username = undefined
  }
}

export function registerAuthIpc(): void {
  const client = getApiClient()

  /**
   * Validate an API key by calling GET /api/v2/user.
   * If valid, saves the key to settings DB and configures the rate limiter.
   */
  handle('auth:validateKey', async (_event, key: string) => {
    // Temporarily set the key to test it — this also raises the rate limits
    client.setApiKey(key)
    try {
      const user = await client.getUser()
      // Key is valid — persist it encrypted
      settingsRepo.set('nhentai_api_key', encryptKey(key))
      loggedIn = true
      username = user.username
      return { success: true, data: { username: user.username } }
    } catch {
      // Key is invalid — remove it from client (drops back to anon limits)
      client.setApiKey(null)
      throw new Error('Invalid API key')
    }
  })

  /**
   * Get the current authentication status.
   */
  handle('auth:getAuthStatus', async () => {
    return { success: true, data: { loggedIn, username } }
  })

  /**
   * Set the API key on the client without validation (e.g., when restoring
   * a previously validated key from the DB during startup).
   */
  handle('auth:setKey', async (_event, key: string) => {
    client.setApiKey(key)
    return { success: true }
  })

  /**
   * Clear the API key — removes it from client, settings DB, and resets
   * the rate limiter to the anonymous default (30 req/min).
   */
  handle('auth:clearKey', async () => {
    // setApiKey(null) reverts the limiter to the anonymous per-endpoint limits
    client.setApiKey(null)
    settingsRepo.delete('nhentai_api_key')
    loggedIn = false
    username = undefined
    return { success: true }
  })

  /**
   * Diagnostics: current rate limiter state per endpoint group.
   */
  handle('auth:getRateLimits', async () => {
    return {
      success: true,
      data: { authenticated: loggedIn, buckets: client.getRateLimitSnapshot() }
    }
  })

  /**
   * Open an external URL in the system browser.
   */
  handle('shell:openExternal', async (_event, url: string) => {
    await shell.openExternal(url)
  })

  handle('shell:openPath', async (_event, path: string) => {
    await shell.openPath(path)
  })

  handle('shell:showItemInFolder', async (_event, path: string) => {
    shell.showItemInFolder(path)
  })

  // ─── File Dialogs ──────────────────────────────────────────────────

  handle(
    'dialog:openFile',
    async (
      event,
      options?: { filters?: Array<{ name: string; extensions: string[] }> }
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { success: false, error: 'No window found' }

      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: options?.filters || [
          { name: 'PDF Files', extensions: ['pdf'] }
        ]
      })

      return {
        success: true,
        data: result.canceled ? null : result.filePaths[0]
      }
    }
  )

  handle('dialog:openDirectory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false, error: 'No window found' }

    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })

    return {
      success: true,
      data: result.canceled ? null : result.filePaths[0]
    }
  })
}
