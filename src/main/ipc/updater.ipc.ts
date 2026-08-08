import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { settingsRepo } from '../db/repositories/settings.repo'
import { getLogger } from '../services/logger'
import { handle } from './handle'

const logger = getLogger('updater')

type ReleaseChannel = 'stable' | 'beta'

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

function sendUpdateStatus(payload: Record<string, unknown>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('app:updateStatus', payload)
  }
}

export function registerUpdaterIpc(): void {
  applyReleaseChannel()

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
      version: info?.version
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

  // Startup check. Rejections are handled by the 'error' listener above; this
  // catch only stops an unhandled rejection when no feed exists yet.
  autoUpdater.checkForUpdates().catch(() => {
    /* reported via the error event */
  })
}
