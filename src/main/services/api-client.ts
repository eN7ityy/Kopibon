import { RateLimiter } from './rate-limiter'

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

export interface ApiConfig {
  max_requests_per_minute: number
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
  private rateLimiter: RateLimiter
  private apiKey: string | null = null
  private cdnConfig: CdnConfig | null = null
  private cdnConfigFetchedAt = 0

  constructor(rateLimiter?: RateLimiter) {
    this.rateLimiter = rateLimiter ?? new RateLimiter(30)
  }

  setApiKey(key: string | null): void {
    this.apiKey = key
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
    path: string,
    options?: { method?: string; body?: unknown }
  ): Promise<T> {
    await this.rateLimiter.acquire()

    const url = `${BASE_URL}${path}`
    const fetchOptions: RequestInit = {
      method: options?.method ?? 'GET',
      headers: this.getHeaders()
    }
    if (options?.body) {
      fetchOptions.body = JSON.stringify(options.body)
      ;(fetchOptions.headers as Record<string, string>)['Content-Type'] =
        'application/json'
    }

    const doFetch = (): Promise<Response> => fetch(url, fetchOptions)

    let response = await doFetch()

    if (!response.ok) {
      if (response.status === 429) {
        await new Promise((r) => setTimeout(r, 5000))
        await this.rateLimiter.acquire()
        response = await doFetch()
        if (!response.ok) {
          throw new Error(`API error: ${response.status} ${response.statusText}`)
        }
        // For 204 No Content or empty responses, return undefined as T
        if (response.status === 204) {
          return undefined as T
        }
        return response.json() as Promise<T>
      }
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
    if (query.trim()) params.set('query', query)
    if (options.page) params.set('page', String(options.page))
    if (options.sort) params.set('sort', options.sort)

    return this.request<SearchResponse>(`/search?${params.toString()}`)
  }

  async getGallery(id: number): Promise<GalleryDetail> {
    return this.request<GalleryDetail>(`/galleries/${id}`)
  }

  async getCdnConfig(): Promise<CdnConfig> {
    const now = Date.now()
    if (this.cdnConfig && now - this.cdnConfigFetchedAt < 3_600_000) {
      return this.cdnConfig
    }

    this.cdnConfig = await this.request<CdnConfig>('/cdn')
    this.cdnConfigFetchedAt = now
    return this.cdnConfig
  }

  async getConfig(): Promise<ApiConfig> {
    return this.request<ApiConfig>('/config')
  }

  async getUser(): Promise<UserProfile> {
    return this.request<UserProfile>('/user')
  }

  async getFavorites(page = 1, query?: string): Promise<FavoritesResponse> {
    const params = new URLSearchParams()
    params.set('page', String(page))
    if (query) params.set('query', query)
    return this.request<FavoritesResponse>(`/favorites?${params.toString()}`)
  }

  async getRelatedGalleries(id: number): Promise<SearchResponse> {
    return this.request<SearchResponse>(`/galleries/${id}/related`)
  }

  async checkFavorite(galleryId: number): Promise<boolean> {
    try {
      const result = await this.request<FavoriteResponse>(
        `/galleries/${galleryId}/favorite`
      )
      return result.favorited
    } catch {
      return false
    }
  }

  async addFavorite(galleryId: number): Promise<void> {
    await this.request(`/galleries/${galleryId}/favorite`, { method: 'POST' })
  }

  async removeFavorite(galleryId: number): Promise<void> {
    await this.request(`/galleries/${galleryId}/favorite`, { method: 'DELETE' })
  }

  /**
   * Build the image URL for a given gallery page using the first image server.
   */
  async getImageUrl(
    mediaId: string,
    pageNumber: number,
    pagePath: string
  ): Promise<string> {
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
