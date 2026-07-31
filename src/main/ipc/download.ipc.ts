import { BrowserWindow } from 'electron'
import { downloadRepo } from '../db/repositories/download.repo'
import { settingsRepo } from '../db/repositories/settings.repo'
import { getDownloadManager, type DownloadProgress } from '../services/download-manager'
import { resolveOutputFormat } from '../services/output-format'
import { handle } from './handle'

export function registerDownloadIpc(): void {
  const manager = getDownloadManager()

  // Forward progress events to all renderer windows
  manager.onProgress((progress: DownloadProgress) => {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('download:progress', progress)
    }
  })

  handle('download:getAll', async () => {
    const items = downloadRepo.findAll()
    return { success: true, data: items }
  })

  handle('download:getById', async (_event, id: number) => {
    const item = downloadRepo.findById(id)
    return { success: true, data: item }
  })

  handle('download:getByStatus', async (_event, status: string) => {
    const items = downloadRepo.findByStatus(status)
    return { success: true, data: items }
  })

  handle('download:getByGalleryId', async (_event, galleryId: number) => {
    const item = downloadRepo.findByGalleryId(galleryId)
    return { success: true, data: item ?? null }
  })

  handle(
    'download:addToQueue',
    async (
      _event,
      galleryId: number,
      outputFormat?: string,
      outputDirectory?: string
    ) => {
      // Collapse duplicate requests (double-click, or queueing the same
      // gallery from two views). Two rows for one gallery would race on the
      // same scratch directory and the same output path.
      const existing = downloadRepo.findActiveByGalleryId(galleryId)
      if (existing) {
        return { success: true, data: { id: existing.id, duplicate: true } }
      }

      // Explicit choice wins, else the persisted setting, else PDF.
      const format = resolveOutputFormat(
        outputFormat,
        settingsRepo.get('outputFormat')
      )
      const id = downloadRepo.insert({
        galleryId,
        status: 'queued',
        priority: 0,
        retryCount: 0,
        maxRetries: 3,
        outputFormat: format,
        outputDirectory: outputDirectory ?? null
      })
      // Start processing if not already running
      manager.processQueue()
      return { success: true, data: { id } }
    }
  )

  handle('download:remove', async (_event, id: number) => {
    manager.cancelDownload(id)
    downloadRepo.delete(id)
    downloadRepo.deletePages(id)
    return { success: true }
  })

  handle('download:pause', async (_event, id: number) => {
    const result = manager.pauseDownload(id)
    return { success: result }
  })

  handle('download:resume', async (_event, id: number) => {
    const result = manager.resumeDownload(id)
    return { success: result }
  })

  handle('download:cancel', async (_event, id: number) => {
    const result = manager.cancelDownload(id)
    return { success: result }
  })

  handle('download:pauseAll', async () => {
    manager.pauseAll()
    return { success: true }
  })

  handle('download:resumeAll', async () => {
    manager.resumeAll()
    return { success: true }
  })

  handle('download:getPages', async (_event, queueId: number) => {
    const pages = downloadRepo.getPages(queueId)
    return { success: true, data: pages }
  })

  handle('download:getStatusCounts', async () => {
    const active = downloadRepo.activeCount()
    const queued = downloadRepo.queuedCount()
    return { success: true, data: { active, queued } }
  })
}
