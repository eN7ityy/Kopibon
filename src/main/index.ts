import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import icon from '../../resources/icon.png?asset'
import { initDatabase, closeDatabase } from './db/connection'
import { registerApiIpc } from './ipc/api.ipc'
import { registerDownloadIpc } from './ipc/download.ipc'
import { registerLibraryIpc } from './ipc/library.ipc'
import { registerSettingsIpc } from './ipc/settings.ipc'
import { registerAuthIpc, restoreAuthFromDb } from './ipc/auth.ipc'
import { getDownloadManager } from './services/download-manager'
import { checkToolchain } from './services/toolchain'
import { runStartupMaintenance } from './services/startup-maintenance'
import { createLogger } from './services/logger'
import { handle } from './ipc/handle'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Doujin Downloader',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.en7ity.doujin-downloader')

  // ─── Logger ──────────────────────────────────────────────────────────

  const logDir = join(app.getPath('userData'), 'logs')
  const logger = createLogger({ logDir })

  logger.info('App starting', {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch
  })

  // ─── Crash handlers (§1.7) ───────────────────────────────────────────

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', {
      err: error,
      origin: 'uncaughtException'
    })
  })

  process.on('unhandledRejection', (reason) => {
    const err =
      reason instanceof Error
        ? reason
        : new Error(String(reason))
    logger.error('Unhandled rejection', {
      err,
      origin: 'unhandledRejection'
    })
  })

  app.on('render-process-gone', (_event, _webContents, details) => {
    logger.error('Render process gone', {
      reason: details.reason,
      exitCode: details.exitCode
    })
  })

  app.on('child-process-gone', (_event, details) => {
    logger.error('Child process gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName
    })
  })

  // ─── Main window ─────────────────────────────────────────────────────

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Initialize database
  initDatabase()
  logger.info('Database initialised')

  // Register IPC handlers
  registerApiIpc()
  registerDownloadIpc()
  registerLibraryIpc()
  registerSettingsIpc()
  registerAuthIpc()

  // Restore any previously-validated API key from the DB
  restoreAuthFromDb()

  // Sweep transient bookkeeping tables
  const maintenance = runStartupMaintenance()
  if (
    maintenance.downloadPagesCleared +
      maintenance.scanQueueCleared +
      maintenance.completedDownloadsPruned +
      maintenance.orphanedArtistsRemoved >
    0
  ) {
    logger.info('Startup maintenance', {
      downloadPagesCleared: maintenance.downloadPagesCleared,
      scanQueueCleared: maintenance.scanQueueCleared,
      completedDownloadsPruned: maintenance.completedDownloadsPruned,
      orphanedArtistsRemoved: maintenance.orphanedArtistsRemoved
    })
  }

  // Re-queue downloads that were interrupted by a crash/quit, then resume
  const dm = getDownloadManager()
  dm.applyConcurrencyFromSettings()
  const requeued = dm.reconcileInterrupted()
  if (requeued > 0) {
    logger.info('Re-queued interrupted downloads', { count: requeued })
  }
  dm.processQueue()

  // Probe the external toolchain (Python/pikepdf, poppler)
  checkToolchain()
    .then((report) => {
      if (report.ok) {
        logger.info('External toolchain OK')
      } else {
        const missing = report.tools
          .filter((t) => !t.ok)
          .map((t) => t.name)
        logger.error('Missing external tools', {
          missing: missing.join(', '),
          installHint: report.installHint
        })
      }
    })
    .catch((err) => {
      logger.warn('Toolchain probe failed (non-fatal)', {
        err: err instanceof Error ? err : new Error(String(err))
      })
    })

  // ─── IPC handlers defined in main (not in a separate module) ──────────

  handle('app:checkToolchain', async (_event, force = false) => {
    return { success: true, data: await checkToolchain(force) }
  })

  // ─── Auto-update ─────────────────────────────────────────────────────

  /** Broadcast updater state so the renderer can show it instead of guessing. */
  const sendUpdateStatus = (
    payload: Record<string, unknown>
  ): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('app:updateStatus', payload)
    }
  }

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

  // ─── Renderer log forwarding (§1.6) ─────────────────────────────────

  ipcMain.handle(
    'log:write',
    async (
      _event,
      level: string,
      scope: string,
      msg: string,
      fields?: Record<string, unknown>
    ) => {
      // Validate level to prevent injection
      const validLevels = ['error', 'warn', 'info', 'debug']
      if (!validLevels.includes(level)) return
      const logFn = logger[level as 'error' | 'warn' | 'info' | 'debug']
      if (typeof logFn === 'function') {
        ;(logFn as (msg: string, fields?: Record<string, unknown>) => void)(
          msg,
          { scope, ...fields }
        )
      }
    }
  )

  handle('app:checkForUpdates', async () => {
    const result = await autoUpdater.checkForUpdates()
    return {
      success: true,
      data: result
        ? { version: result.updateInfo?.version }
        : null
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

  // App version for Settings display
  handle('app:getVersion', async () => {
    return { success: true, data: app.getVersion() }
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  closeDatabase()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
