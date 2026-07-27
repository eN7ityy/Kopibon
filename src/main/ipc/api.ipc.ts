import { ipcMain } from 'electron'
import { getApiClient, type GalleryDetail } from '../services/api-client'

const galleryCache = new Map<number, GalleryDetail>()

export function registerApiIpc(): void {
  const client = getApiClient()

  ipcMain.handle(
    'api:search',
    async (_event, query: string, options?: { page?: number; sort?: string }) => {
      try {
        const results = await client.searchGalleries(query, {
          page: options?.page,
          sort: options?.sort as 'date' | 'popular' | 'popular-today' | 'popular-week' | 'popular-month' | undefined
        })
        return { success: true, data: results }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    }
  )

  ipcMain.handle('api:getGallery', async (_event, id: number) => {
    try {
      const cached = galleryCache.get(id)
      if (cached) {
        return { success: true, data: cached }
      }
      const gallery = await client.getGallery(id)
      galleryCache.set(id, gallery)
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

  ipcMain.handle('api:getFavorites', async (_event, page: number, query?: string) => {
    try {
      const results = await client.getFavorites(page, query)
      return { success: true, data: results }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('api:getUser', async () => {
    try {
      const user = await client.getUser()
      return { success: true, data: user }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('api:getRelatedGalleries', async (_event, id: number) => {
    try {
      const results = await client.getRelatedGalleries(id)
      // Cache each related gallery for reuse
      for (const item of results.result) {
        if (!galleryCache.has(item.id)) {
          // We don't have full detail here, but the cache is keyed by id for getGallery
          // The related endpoint returns GalleryListItem[], not full GalleryDetail
          // We'll cache only when detail is fetched
        }
      }
      return { success: true, data: results }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}
