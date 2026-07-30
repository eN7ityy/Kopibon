import { ipcMain } from 'electron'
import { getApiClient, type GalleryDetail } from '../services/api-client'

// ─── Gallery cache ───────────────────────────────────────────────────────────

/**
 * Bounded, time-limited cache of gallery details.
 *
 * Previously an unbounded Map that never evicted or expired, so it grew for the
 * whole session and served stale favourite counts indefinitely. Map preserves
 * insertion order, which gives us LRU eviction for free.
 */
const GALLERY_CACHE_MAX_ENTRIES = 300
const GALLERY_CACHE_TTL_MS = 15 * 60_000

interface CachedGallery {
  value: GalleryDetail
  cachedAt: number
}

const galleryCache = new Map<number, CachedGallery>()

function getCachedGallery(id: number): GalleryDetail | undefined {
  const hit = galleryCache.get(id)
  if (!hit) return undefined

  if (Date.now() - hit.cachedAt > GALLERY_CACHE_TTL_MS) {
    galleryCache.delete(id)
    return undefined
  }

  // Re-insert to mark as most recently used
  galleryCache.delete(id)
  galleryCache.set(id, hit)
  return hit.value
}

function setCachedGallery(id: number, value: GalleryDetail): void {
  galleryCache.delete(id)
  galleryCache.set(id, { value, cachedAt: Date.now() })

  while (galleryCache.size > GALLERY_CACHE_MAX_ENTRIES) {
    const oldest = galleryCache.keys().next()
    if (oldest.done) break
    galleryCache.delete(oldest.value)
  }
}

/** Drop a cached entry whose data we know just changed (e.g. favourited). */
function invalidateCachedGallery(id: number): void {
  galleryCache.delete(id)
}

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

  ipcMain.handle('api:getLatest', async (_event, page?: number) => {
    try {
      const results = await client.getLatestGalleries(page ?? 1)
      return { success: true, data: results }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('api:getPopular', async () => {
    try {
      const results = await client.getPopularGalleries()
      return { success: true, data: results }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('api:getGallery', async (_event, id: number) => {
    try {
      const cached = getCachedGallery(id)
      if (cached) {
        return { success: true, data: cached }
      }
      const gallery = await client.getGallery(id)
      setCachedGallery(id, gallery)
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
      // Not cached here: this endpoint returns GalleryListItem[], not the full
      // GalleryDetail the cache stores. Detail is cached on its own fetch.
      const results = await client.getRelatedGalleries(id)
      return { success: true, data: results }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('api:checkFavorite', async (_event, galleryId: number) => {
    try {
      const isFav = await client.checkFavorite(galleryId)
      return { success: true, data: isFav }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('api:addFavorite', async (_event, galleryId: number) => {
    try {
      await client.addFavorite(galleryId)
      // num_favorites just changed — don't keep serving the stale detail
      invalidateCachedGallery(galleryId)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('api:removeFavorite', async (_event, galleryId: number) => {
    try {
      await client.removeFavorite(galleryId)
      invalidateCachedGallery(galleryId)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}
