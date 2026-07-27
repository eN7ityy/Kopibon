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

  // Resume any pending downloads from previous session
  const dm = getDownloadManager()
  dm.processQueue()

  // F5: Auto-update — check for updates on startup
  autoUpdater.checkForUpdatesAndNotify()

  // Manual update check from renderer
  ipcMain.handle('app:checkForUpdates', async () => {
    try {
      const result = await autoUpdater.checkForUpdatesAndNotify()
      return { success: true, data: result }
    } catch (error) {
      return { success: false, error: String(error) }
    }
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
