import { ipcMain } from 'electron'
import { downloadRepo } from '../db/repositories/download.repo'

export function registerDownloadIpc(): void {
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

  ipcMain.handle('download:addToQueue', async (_event, galleryId: number, outputFormat?: string, outputDirectory?: string) => {
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
      return { success: true, data: { id } }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('download:remove', async (_event, id: number) => {
    try {
      downloadRepo.delete(id)
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
