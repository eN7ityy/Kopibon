import { ApiRateLimiter, type EndpointKey } from './rate-limiter'

// ─── Types (matching openapi_documentation.json) ─────────────────────────────

export interface SearchParams {
  query: string
  page?: number
  sort?: 'date' | 'popular' | 'popular-today' | 'popular-week' | 'popular-month'
}

export interface GalleryListItem {
  id: number
  media_id: string
  english_title: string
  japanese_title: string | null
  thumbnail: string
  thumbnail_width: number
  thumbnail_height: number
  num_pages: number
  num_favorites: number
  tag_ids: number[]
  blacklisted: boolean
}

export interface SearchResponse {
  result: GalleryListItem[]
  num_pages: number
  per_page: number
  total?: number | null
}

export interface CoverInfo {
  path: string
  width: number
  height: number
}

export interface PageInfo {
  number: number
  path: string
  width: number
  height: number
  thumbnail: string
  thumbnail_width: number
  thumbnail_height: number
}

export interface TagResponse {
  id: number
  type: string
  name: string
  slug: string
  url: string
  count: number
  description?: string | null
  is_community?: boolean | null
  pending_describe_id?: string | null
}

export interface GalleryTitle {
  english: string
  japanese: string | null
  pretty: string
}

export interface GalleryDetail {
  id: number
  media_id: string
  title: GalleryTitle
  cover: CoverInfo
  thumbnail: CoverInfo
  scanlator: string
  upload_date: number
  tags: TagResponse[]
  num_pages: number
  num_favorites: number
  pages: PageInfo[]
}

export interface CdnConfig {
  image_servers: string[]
  thumb_servers: string[]
}

export interface AnnouncementLink {
  text: string
  url: string
}

export interface Announcement {
  message: string
  links?: AnnouncementLink[]
}

/**
 * GET /config response. Note: the API does *not* return a rate limit here —
 * limits are per-endpoint and documented in the spec, see rate-limiter.ts.
 */
export interface ApiConfig {
  image_servers: string[]
  thumb_servers: string[]
  announcement?: Announcement | null
}

export interface UserProfile {
  id: number
  username: string
  email: string | null
}

export interface FavoritesResponse {
  result: GalleryListItem[]
  num_pages: number
  per_page: number
}

export interface FavoriteResponse {
  favorited: boolean
  num_favorites: number | null
}

// ─── Client ─────────────────────────────────────────────────────────────────

const BASE_URL = 'https://nhentai.net/api/v2'

export class ApiClient {
  private rateLimiter: ApiRateLimiter
  private apiKey: string | null = null
  private cdnConfig: CdnConfig | null = null
  private cdnConfigFetchedAt = 0

  constructor(rateLimiter?: ApiRateLimiter) {
    this.rateLimiter = rateLimiter ?? new ApiRateLimiter(false)
  }

  setApiKey(key: string | null): void {
    this.apiKey = key
    // Authenticated calls get higher per-endpoint allowances.
    this.rateLimiter.setAuthenticated(key !== null)
  }

  /**
   * Explicitly switch the limiter between anonymous and authenticated limit
   * sets. setApiKey() already does this; this exists for the case where a key
   * is present but turned out to be invalid.
   */
  setAuthenticated(authenticated: boolean): void {
    this.rateLimiter.setAuthenticated(authenticated)
  }

  getRateLimitSnapshot(): Record<string, { available: number; limit: number }> {
    return this.rateLimiter.snapshot()
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': 'Doujin-Downloader/1.0',
      Accept: 'application/json'
    }
    if (this.apiKey) {
      headers['Authorization'] = `Key ${this.apiKey}`
    }
    return headers
  }

  private async request<T>(
    endpoint: EndpointKey,
    path: string,
    options?: { method?: string; body?: unknown }
  ): Promise<T> {
    await this.rateLimiter.acquire(endpoint)

    const url = `${BASE_URL}${path}`
    const fetchOptions: RequestInit = {
      method: options?.method ?? 'GET',
      headers: this.getHeaders()
    }
    if (options?.body) {
      fetchOptions.body = JSON.stringify(options.body)
      ;(fetchOptions.headers as Record<string, string>)['Content-Type'] = 'application/json'
    }

    const doFetch = (): Promise<Response> => fetch(url, fetchOptions)

    let response = await doFetch()

    if (response.status === 429) {
      // Honour Retry-After when the server sends it, otherwise back off 5s.
      const retryAfter = Number(response.headers.get('Retry-After'))
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 60_000)))
      await this.rateLimiter.acquire(endpoint)
      response = await doFetch()
    }

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`)
    }

    // For 204 No Content, no JSON body
    if (response.status === 204) {
      return undefined as T
    }
    return response.json() as Promise<T>
  }

  async searchGalleries(
    query: string,
    options: Omit<SearchParams, 'query'> = {}
  ): Promise<SearchResponse> {
    const params = new URLSearchParams()
    params.set('query', query)
    if (options.page) params.set('page', String(options.page))
    if (options.sort && options.sort !== 'date') params.set('sort', options.sort)

    return this.request<SearchResponse>('search', `/search?${params.toString()}`)
  }

  async getLatestGalleries(page = 1): Promise<SearchResponse> {
    const params = new URLSearchParams()
    params.set('page', String(page))
    return this.request<SearchResponse>('galleries', `/galleries?${params.toString()}`)
  }

  async getPopularGalleries(): Promise<{ result: GalleryListItem[] }> {
    const galleries = await this.request<GalleryListItem[]>('popular', '/galleries/popular')
    return { result: galleries }
  }

  async getGallery(id: number): Promise<GalleryDetail> {
    return this.request<GalleryDetail>('gallery', `/galleries/${id}`)
  }

  async getCdnConfig(): Promise<CdnConfig> {
    const now = Date.now()
    if (this.cdnConfig && now - this.cdnConfigFetchedAt < 3_600_000) {
      return this.cdnConfig
    }

    this.cdnConfig = await this.request<CdnConfig>('meta', '/cdn')
    this.cdnConfigFetchedAt = now
    return this.cdnConfig
  }

  async getConfig(): Promise<ApiConfig> {
    return this.request<ApiConfig>('meta', '/config')
  }

  async getUser(): Promise<UserProfile> {
    return this.request<UserProfile>('user', '/user')
  }

  async getFavorites(page = 1, query?: string): Promise<FavoritesResponse> {
    const params = new URLSearchParams()
    params.set('page', String(page))
    // The endpoint takes `q`, not `query`.
    if (query) params.set('q', query)
    return this.request<FavoritesResponse>('favorites', `/favorites?${params.toString()}`)
  }

  async getRelatedGalleries(id: number): Promise<SearchResponse> {
    return this.request<SearchResponse>('related', `/galleries/${id}/related`)
  }

  /**
   * Resolve tag ids to names, 100 at a time.
   *
   * Search results carry `tag_ids` and no names, so this is the only way to tell
   * whether a result holds a blocked tag. The 100-id cap is the documented
   * maximum; the caller is responsible for batching and for caching what comes
   * back, since this endpoint is only 15/min.
   */
  async getTagsByIds(ids: readonly number[]): Promise<TagResponse[]> {
    const unique = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0)
    if (unique.length === 0) return []
    if (unique.length > 100) {
      throw new Error(`getTagsByIds accepts at most 100 ids, got ${unique.length}`)
    }
    return this.request<TagResponse[]>('tagsIds', `/tags/ids?ids=${unique.join(',')}`)
  }

  /**
   * Tag autocomplete by name prefix, for the blocked-value input.
   *
   * Picking from real tags matters here: a blocked value typed by hand that does
   * not correspond to an actual tag becomes a query negation that silently
   * matches nothing.
   */
  async searchTags(
    query: string,
    options: { type?: string | null; limit?: number } = {}
  ): Promise<TagResponse[]> {
    const trimmed = query.trim()
    if (!trimmed) return []
    return this.request<TagResponse[]>('tagsSearch', '/tags/search', {
      method: 'POST',
      body: {
        query: trimmed,
        // Omitting type searches every tag type, which is what the picker wants
        // when no type has been chosen yet.
        type: options.type || null,
        limit: Math.min(Math.max(options.limit ?? 10, 1), 50)
      }
    })
  }

  async checkFavorite(galleryId: number): Promise<boolean> {
    try {
      const result = await this.request<FavoriteResponse>(
        'favorite',
        `/galleries/${galleryId}/favorite`
      )
      return result.favorited
    } catch {
      return false
    }
  }

  async addFavorite(galleryId: number): Promise<void> {
    await this.request('favorite', `/galleries/${galleryId}/favorite`, { method: 'POST' })
  }

  async removeFavorite(galleryId: number): Promise<void> {
    await this.request('favorite', `/galleries/${galleryId}/favorite`, { method: 'DELETE' })
  }

  /**
   * Build the image URL for a given gallery page using the first image server.
   */
  async getImageUrl(mediaId: string, pageNumber: number, pagePath: string): Promise<string> {
    const cdn = await this.getCdnConfig()
    const server = cdn.image_servers[0]
    // pagePath is like "1234.jpg" but we use the page number + extension from path
    const ext = pagePath.split('.').pop() || 'jpg'
    return `https://${server}/galleries/${mediaId}/${pageNumber}.${ext}`
  }

  /**
   * Build the thumbnail URL using the first thumb server.
   */
  getThumbnailUrl(_mediaId: string, thumbPath: string): string {
    // thumbnail field from GalleryListItem is a full URL or needs server prefix
    // The API returns thumbnail as a URL path like "galleries/{media_id}/thumb.jpg"
    // We construct: https://t{n}.nhentai.net/{path}
    return `https://t.nhentai.net/${thumbPath}`
  }

  /**
   * Build the cover URL using the first thumb server.
   */
  getCoverUrl(_mediaId: string, coverPath: string): string {
    return `https://t.nhentai.net/${coverPath}`
  }
}

// Singleton
let clientInstance: ApiClient | null = null

export function getApiClient(): ApiClient {
  if (!clientInstance) {
    clientInstance = new ApiClient()
  }
  return clientInstance
}
