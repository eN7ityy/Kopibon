import { getApiClient, type GalleryDetail } from '../services/api-client'
import { handle } from './handle'

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

  handle(
    'api:search',
    async (
      _event,
      query: string,
      options?: { page?: number; sort?: string }
    ) => {
      const results = await client.searchGalleries(query, {
        page: options?.page,
        sort: options?.sort as
          | 'date'
          | 'popular'
          | 'popular-today'
          | 'popular-week'
          | 'popular-month'
          | undefined
      })
      return { success: true, data: results }
    }
  )

  handle('api:getLatest', async (_event, page?: number) => {
    const results = await client.getLatestGalleries(page ?? 1)
    return { success: true, data: results }
  })

  handle('api:getPopular', async () => {
    const results = await client.getPopularGalleries()
    return { success: true, data: results }
  })

  handle('api:getGallery', async (_event, id: number) => {
    const cached = getCachedGallery(id)
    if (cached) {
      return { success: true, data: cached }
    }
    const gallery = await client.getGallery(id)
    setCachedGallery(id, gallery)
    return { success: true, data: gallery }
  })

  handle('api:getCdnConfig', async () => {
    const config = await client.getCdnConfig()
    return { success: true, data: config }
  })

  handle('api:getConfig', async () => {
    const config = await client.getConfig()
    return { success: true, data: config }
  })

  handle('api:setApiKey', async (_event, key: string | null) => {
    client.setApiKey(key)
    return { success: true }
  })

  handle(
    'api:getFavorites',
    async (_event, page: number, query?: string) => {
      const results = await client.getFavorites(page, query)
      return { success: true, data: results }
    }
  )

  handle('api:getUser', async () => {
    const user = await client.getUser()
    return { success: true, data: user }
  })

  handle('api:getRelatedGalleries', async (_event, id: number) => {
    // Not cached here: this endpoint returns GalleryListItem[], not the full
    // GalleryDetail the cache stores. Detail is cached on its own fetch.
    const results = await client.getRelatedGalleries(id)
    return { success: true, data: results }
  })

  handle('api:addFavorite', async (_event, galleryId: number) => {
    await client.addFavorite(galleryId)
    // num_favorites just changed — don't keep serving the stale detail
    invalidateCachedGallery(galleryId)
    return { success: true }
  })

  handle('api:removeFavorite', async (_event, galleryId: number) => {
    await client.removeFavorite(galleryId)
    invalidateCachedGallery(galleryId)
    return { success: true }
  })
}
