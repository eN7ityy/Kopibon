import { ipcMain } from 'electron'
import { getApiClient } from '../services/api-client'

export function registerApiIpc(): void {
  const client = getApiClient()

  ipcMain.handle('api:search', async (_event, query: string, options?: Record<string, unknown>) => {
    try {
      const results = await client.searchGalleries(query, options)
      return { success: true, data: results }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('api:getGallery', async (_event, id: number) => {
    try {
      const gallery = await client.getGallery(id)
      return { success: true, data: gallery }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('api:getCdnConfig', async () => {
    try {
      const config = await client.getCdnConfig()
      return { success: true, data: config }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('api:getConfig', async () => {
    try {
      const config = await client.getConfig()
      return { success: true, data: config }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('api:setApiKey', async (_event, key: string | null) => {
    client.setApiKey(key)
    return { success: true }
  })
}
