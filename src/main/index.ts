import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'

// Debug: log process context per Gemini's recommended diagnosis
console.log(
  '[main] Process Type:',
  process.type,
  '| Run As Node:',
  process.env.ELECTRON_RUN_AS_NODE,
  '| electron.app:',
  typeof app
)
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

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Initialize database
  initDatabase()

  // Register IPC handlers
  registerApiIpc()
  registerDownloadIpc()
  registerLibraryIpc()
  registerSettingsIpc()
  registerAuthIpc()

  // Restore any previously-validated API key from the DB
  restoreAuthFromDb()

  // Sweep transient bookkeeping tables (page rows, scan queue, completed
  // history). Must run before reconcileInterrupted(), which rebuilds the
  // page rows it needs for the downloads it re-queues.
  runStartupMaintenance()

  // Re-queue downloads that were interrupted by a crash/quit, then resume
  const dm = getDownloadManager()
  dm.applyConcurrencyFromSettings()
  dm.reconcileInterrupted()
  dm.processQueue()

  // Probe the external toolchain (Python/pikepdf, poppler). Neither is bundled,
  // and without them PDFs get no metadata and conversion cannot run — so the
  // result is also exposed over IPC and shown in Settings, because a console
  // message is invisible in a packaged build.
  checkToolchain()
    .then((report) => {
      if (report.ok) {
        console.log('[startup] external toolchain OK')
      } else {
        const missing = report.tools.filter((t) => !t.ok).map((t) => t.name)
        console.error(`[startup] MISSING TOOLS: ${missing.join(', ')} — ${report.installHint}`)
      }
    })
    .catch(() => {
      /* probe failure is non-fatal */
    })

  ipcMain.handle('app:checkToolchain', async (_event, force = false) => {
    try {
      return { success: true, data: await checkToolchain(force) }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // ─── Auto-update ───────────────────────────────────────────────────────────

  /** Broadcast updater state so the renderer can show it instead of guessing. */
  const sendUpdateStatus = (payload: Record<string, unknown>): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('app:updateStatus', payload)
    }
  }

  // Errors were previously swallowed at both call sites, so a permanently broken
  // update feed was invisible to everyone including the developer.
  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err?.message || err)
    sendUpdateStatus({ state: 'error', message: String(err?.message || err) })
  })
  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus({ state: 'available', version: info?.version })
  })
  autoUpdater.on('update-not-available', () => {
    sendUpdateStatus({ state: 'current' })
  })
  autoUpdater.on('download-progress', (p) => {
    sendUpdateStatus({ state: 'downloading', percent: Math.round(p?.percent ?? 0) })
  })
  // The update is staged but NOT applied until the app restarts. Without this
  // event reaching the UI the user had no idea a restart would change anything.
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateStatus({ state: 'ready', version: info?.version })
  })

  ipcMain.handle('app:checkForUpdates', async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      return { success: true, data: result ? { version: result.updateInfo?.version } : null }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  /** Apply a staged update now. No-op unless 'update-downloaded' has fired. */
  ipcMain.handle('app:installUpdate', async () => {
    try {
      // isSilent=false, isForceRunAfter=true — reopen the app after updating.
      autoUpdater.quitAndInstall(false, true)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // Startup check. Rejections are handled by the 'error' listener above; this
  // catch only stops an unhandled rejection when no feed exists yet.
  autoUpdater.checkForUpdates().catch(() => {
    /* reported via the error event */
  })

  // App version for Settings display
  ipcMain.handle('app:getVersion', async () => {
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
