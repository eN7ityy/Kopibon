import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { settingsRepo } from '../db/repositories/settings.repo'
import { getLogger } from '../services/logger'
import { handle } from './handle'

const logger = getLogger('updater')

type ReleaseChannel = 'stable' | 'beta'

type UpdateState = 'available' | 'current' | 'downloading' | 'ready' | 'error' | 'checking'

interface UpdateStatusPayload {
  state: UpdateState
  version?: string
  percent?: number
  message?: string
  releaseNotes?: string | null
}

/**
 * Normalise electron-updater's `releaseNotes` field — `string |
 * ReleaseNoteInfo[] | null` — to a plain `string | null` for display.
 */
function releaseNotesText(notes: unknown): string | null {
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    const text = notes
      .map((n) => (n && typeof n === 'object' && 'note' in n ? String((n as { note: unknown }).note) : ''))
      .filter((line) => line.length > 0)
      .join('\n')
    return text.length > 0 ? text : null
  }
  return null
}

/**
 * Before this setting existed, a beta build opted itself into prerelease
 * updates purely by matching "beta" in its own version string — there was no
 * stored preference to read. Treating that as the one-time default means
 * shipping this feature doesn't silently switch existing beta testers back to
 * stable; everyone else defaults to stable, same as electron-updater's own
 * default.
 */
function getReleaseChannel(): ReleaseChannel {
  const stored = settingsRepo.get('releaseChannel')
  if (stored === 'stable' || stored === 'beta') return stored
  const inferred: ReleaseChannel = /beta/.test(app.getVersion()) ? 'beta' : 'stable'
  settingsRepo.set('releaseChannel', inferred)
  return inferred
}

function applyReleaseChannel(): void {
  autoUpdater.allowPrerelease = getReleaseChannel() === 'beta'
}

/**
 * Called from settings.ipc.ts when `releaseChannel` is saved. Re-applies
 * `allowPrerelease` and checks immediately, so flipping the setting is
 * reflected right away instead of waiting for the next natural check.
 */
export function refreshReleaseChannel(): void {
  applyReleaseChannel()
  autoUpdater.checkForUpdates().catch(() => {
    /* reported via the 'error' event below, same as the startup check */
  })
}

// Last status broadcast to the renderer. Kept so components that mount after an
// event has already fired (e.g. Settings, which renders only when navigated to)
// can read the current state instead of waiting for — and missing — the next one.
let lastUpdateStatus: UpdateStatusPayload | null = null

function sendUpdateStatus(payload: UpdateStatusPayload): void {
  lastUpdateStatus = payload
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('app:updateStatus', payload)
  }
}

export function registerUpdaterIpc(): void {
  applyReleaseChannel()

  // Updates are surfaced in the UI and only ever applied on explicit user
  // action. Nothing downloads or installs in the background at boot.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus({ state: 'checking' })
  })
  autoUpdater.on('error', (err) => {
    logger.error('Auto-updater error', {
      err: err instanceof Error ? err : new Error(String((err as Error)?.message || err))
    })
    sendUpdateStatus({
      state: 'error',
      message: String(err?.message || err)
    })
  })
  autoUpdater.on('update-available', (info) => {
    logger.info('Update available', { version: info?.version })
    sendUpdateStatus({
      state: 'available',
      version: info?.version,
      releaseNotes: releaseNotesText(info?.releaseNotes)
    })
  })
  autoUpdater.on('update-not-available', () => {
    sendUpdateStatus({ state: 'current' })
  })
  autoUpdater.on('download-progress', (p) => {
    sendUpdateStatus({
      state: 'downloading',
      percent: Math.round(p?.percent ?? 0)
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    logger.info('Update downloaded', { version: info?.version })
    sendUpdateStatus({
      state: 'ready',
      version: info?.version
    })
  })

  handle('app:checkForUpdates', async () => {
    const result = await autoUpdater.checkForUpdates()
    return {
      success: true,
      data: result ? { version: result.updateInfo?.version } : null
    }
  })

  /** Apply a staged update now. No-op unless 'update-downloaded' has fired. */
  handle('app:installUpdate', async () => {
    // isSilent=false, isForceRunAfter=true — reopen the app after updating.
    autoUpdater.quitAndInstall(false, true)
    return { success: true }
  })

  /** Begin downloading a staged update the user explicitly asked for. */
  handle('app:downloadUpdate', async () => {
    await autoUpdater.downloadUpdate()
    return { success: true }
  })

  /** The latest updater status, or null before the first event has fired. */
  handle('app:getUpdateStatus', async () => ({ success: true, data: lastUpdateStatus }))

  // Startup check. Rejections are handled by the 'error' listener above; this
  // catch only stops an unhandled rejection when no feed exists yet.
  autoUpdater.checkForUpdates().catch(() => {
    /* reported via the error event */
  })
}
