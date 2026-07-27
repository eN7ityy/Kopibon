import { ipcMain, BrowserWindow } from 'electron'
import { downloadRepo } from '../db/repositories/download.repo'
import { getDownloadManager, type DownloadProgress } from '../services/download-manager'

export function registerDownloadIpc(): void {
  const manager = getDownloadManager()

  // Forward progress events to all renderer windows
  manager.onProgress((progress: DownloadProgress) => {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('download:progress', progress)
    }
  })

  ipcMain.handle('download:getAll', async () => {
    try {
      const items = downloadRepo.findAll()
      return { success: true, data: items }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('download:getById', async (_event, id: number) => {
    try {
      const item = downloadRepo.findById(id)
      return { success: true, data: item }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('download:getByStatus', async (_event, status: string) => {
    try {
      const items = downloadRepo.findByStatus(status)
      return { success: true, data: items }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('download:getByGalleryId', async (_event, galleryId: number) => {
    try {
      const item = downloadRepo.findByGalleryId(galleryId)
      return { success: true, data: item ?? null }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(
    'download:addToQueue',
    async (_event, galleryId: number, outputFormat?: string, outputDirectory?: string) => {
      try {
        const id = downloadRepo.insert({
          galleryId,
          status: 'queued',
          priority: 0,
          retryCount: 0,
          maxRetries: 3,
          outputFormat: outputFormat ?? 'pdf',
          outputDirectory: outputDirectory ?? null
        })
        // Start processing if not already running
        manager.processQueue()
        return { success: true, data: { id } }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    }
  )

  ipcMain.handle('download:remove', async (_event, id: number) => {
    try {
      manager.cancelDownload(id)
      downloadRepo.delete(id)
      downloadRepo.deletePages(id)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('download:pause', async (_event, id: number) => {
    try {
      const result = manager.pauseDownload(id)
      return { success: result }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('download:resume', async (_event, id: number) => {
    try {
      const result = manager.resumeDownload(id)
      return { success: result }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('download:cancel', async (_event, id: number) => {
    try {
      const result = manager.cancelDownload(id)
      return { success: result }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('download:pauseAll', async () => {
    try {
      manager.pauseAll()
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('download:resumeAll', async () => {
    try {
      manager.resumeAll()
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('download:getPages', async (_event, queueId: number) => {
    try {
      const pages = downloadRepo.getPages(queueId)
      return { success: true, data: pages }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('download:getStatusCounts', async () => {
    try {
      const active = downloadRepo.activeCount()
      const queued = downloadRepo.queuedCount()
      return { success: true, data: { active, queued } }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}
