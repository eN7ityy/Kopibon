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
import { registerSearchSettingsIpc } from './ipc/search-settings.ipc'
import { registerAuthIpc, restoreAuthFromDb } from './ipc/auth.ipc'
import { registerKavitaIpc } from './ipc/kavita.ipc'
import { inFlightHandlers } from './ipc/handle'
import { getDownloadManager } from './services/download-manager'
import { checkToolchain } from './services/toolchain'
import { runStartupMaintenance } from './services/startup-maintenance'
import { createLogger, getLogger } from './services/logger'
import { handle } from './ipc/handle'
import { installUserTemplates } from './services/metadata/templates'

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

  /*
   * Freeze detection.
   *
   * The common failure here is not a crash but a hang: the window stops
   * painting and has to be force-quit, leaving nothing in the log because
   * nothing threw. Electron already notices — it fires 'unresponsive' when the
   * renderer stops servicing its message loop — and until now nothing listened,
   * so every one of these went unrecorded.
   *
   * The in-flight IPC list is the useful half. A hang while the renderer waits
   * on a slow handler looks identical, from the outside, to a hang caused by a
   * render loop in the renderer itself; which channels are running at the
   * moment it locks up separates the two.
   */
  let unresponsiveSince: number | null = null

  mainWindow.on('unresponsive', () => {
    unresponsiveSince = Date.now()
    getLogger('window').error('Window stopped responding', {
      inFlightIpc: inFlightHandlers(),
      // No in-flight handler means main was idle, so the freeze is in the
      // renderer — a render loop or a very long synchronous task there.
      likelyIn: inFlightHandlers().length > 0 ? 'main' : 'renderer'
    })
  })

  mainWindow.on('responsive', () => {
    getLogger('window').warn('Window recovered', {
      frozenForMs: unresponsiveSince ? Date.now() - unresponsiveSince : null
    })
    unresponsiveSince = null
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

  // ─── Metadata templates ──────────────────────────────────────────────
  //
  // Before any worker is spawned: the workers inherit process.env, and this is
  // what tells them where the templates are. Seeded into userData so a user can
  // edit what gets written into their files without rebuilding the app.

  const templateDir = installUserTemplates(app.getPath('userData'))
  logger.info(
    templateDir
      ? `Metadata templates: ${templateDir}`
      : 'Metadata templates: using the shipped copies (userData not writable)'
  )

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
  registerSearchSettingsIpc()
  registerAuthIpc()
  registerKavitaIpc()

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
      const validLevels = ['error', 'warn', 'info', 'debug']
      if (!validLevels.includes(level)) return
      // Route through a scoped logger so scope is the record's scope field,
      // not a user field — otherwise filtering by scope never groups renderer
      // records.
      logger.scope(scope)[level as 'error' | 'warn' | 'info' | 'debug'](msg, fields)
    }
  )

  // ─── Log viewer / diagnostics (§1.9) ────────────────────────────────

  handle('log:getRecords', async () => {
    return { success: true, data: logger.getRingBuffer() }
  })

  ipcMain.handle('log:setLevel', async (_event, level: string) => {
    const validLevels = ['error', 'warn', 'info', 'debug']
    if (!validLevels.includes(level)) return { success: false, error: 'Invalid level' }
    logger.setLevel(level as 'error' | 'warn' | 'info' | 'debug')
    return { success: true }
  })

  ipcMain.handle('log:getLevel', async () => {
    return { success: true, data: logger.getConfig().level }
  })

  handle('log:setRetention', async (_event, days: number) => {
    // getConfig() returns Readonly, so this went through `any` to write to it.
    // Cast to the mutable shape once instead: the intent is a deliberate config
    // write, and spelling it out beats disabling the type system.
    const cfg = logger.getConfig() as unknown as { retentionDays: number }
    cfg.retentionDays = Math.max(1, Math.min(365, Math.floor(days)))
    return { success: true }
  })

  handle('log:getRetention', async () => {
    return { success: true, data: logger.getConfig().retentionDays }
  })

  ipcMain.handle('log:openFolder', async () => {
    await shell.openPath(logger.getConfig().logDir)
  })

  handle('log:exportDiagnostics', async () => {
    const { writeFileSync } = await import('fs')
    const { platform, arch, release, cpus, totalmem, homedir } = await import('os')
    const { buildDiagnostics, serializeDiagnostics } = await import('./services/diagnostics')
    const { libraryRepo } = await import('./db/repositories/library.repo')
    const { settingsRepo } = await import('./db/repositories/settings.repo')

    let toolchain: unknown = null
    try {
      toolchain = await checkToolchain()
    } catch {
      toolchain = { error: 'probe failed' }
    }

    let allSettings: Record<string, string> = {}
    try {
      allSettings = settingsRepo.getAll()
    } catch {
      /* settings may not be readable; the bundle is still worth writing */
    }

    let libraryCount = -1
    try {
      libraryCount = libraryRepo.count()
    } catch {
      /* DB may not be ready */
    }

    // The stored key is decrypted only to register it for scrubbing. safeStorage
    // falls back to storing the key verbatim when unavailable, so both the
    // encrypted blob and the plaintext have to be treated as secrets.
    const secrets: string[] = []
    try {
      const stored = settingsRepo.get('nhentai_api_key')
      if (stored) {
        secrets.push(stored)
        const { decryptKey } = await import('./ipc/auth.ipc')
        const real = decryptKey(stored)
        if (real) secrets.push(real)
      }
    } catch {
      /* the allowlist already keeps the key out; this is belt and braces */
    }

    const input = {
      appVersion: app.getVersion(),
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node
      },
      os: {
        platform: platform(),
        arch: arch(),
        release: release(),
        cpus: cpus().length,
        totalMemGb: Math.round(totalmem() / (1024 * 1024 * 1024))
      },
      toolchain,
      settings: allSettings,
      libraryItemCount: libraryCount,
      records: logger.getRingBuffer().slice(-500),
      secrets,
      redactPaths: true,
      exportedAt: new Date().toISOString()
    }

    // Written once, from already-scrubbed text. The previous version wrote the
    // file and then "rewrote" it after registering the secret, which re-emitted
    // an unchanged object and so produced identical bytes.
    const text = serializeDiagnostics(input, homedir())
    const ts = input.exportedAt.replace(/[:.]/g, '-')
    const exportPath = join(logger.getConfig().logDir, `diagnostics-${ts}.json`)
    writeFileSync(exportPath, text, 'utf-8')

    const bundle = buildDiagnostics(input)
    logger.info('diagnostics exported', {
      path: exportPath,
      records: bundle.recentRecords.length,
      omittedSettings: bundle.omittedSettings.length
    })

    await shell.showItemInFolder(exportPath)
    return { success: true, data: { path: exportPath } }
  })

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
