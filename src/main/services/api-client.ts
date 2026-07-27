import { RateLimiter } from './rate-limiter'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SearchParams {
  query: string
  page?: number
  sort?: 'recent' | 'popular' | 'popular-today' | 'popular-week' | 'popular-month' | 'popular-year'
  language?: string
  category?: string
}

export interface SearchResult {
  id: number
  media_id: string
  title: {
    english: string
    japanese: string | null
    pretty: string
  }
  images: {
    cover: { t: string; w: number; h: number }
    pages: Array<{ t: string; w: number; h: number }>
    thumbnail: { t: string; w: number; h: number }
  }
  num_pages: number
  num_favorites: number
  upload_date: number
  tags: Array<{
    id: number
    type: string
    name: string
    url: string
  }>
}

export interface SearchResponse {
  result: SearchResult[]
  num_pages: number
  per_page: number
}

export interface GalleryDetail {
  id: number
  media_id: string
  title: {
    english: string
    japanese: string | null
    pretty: string
  }
  images: {
    cover: { t: string; w: number; h: number }
    pages: Array<{ t: string; w: number; h: number }>
    thumbnail: { t: string; w: number; h: number }
  }
  scanlator: string
  upload_date: number
  tags: Array<{
    id: number
    type: string
    name: string
    url: string
  }>
  num_pages: number
  num_favorites: number
}

export interface CdnConfig {
  image_server: string
  servers: string[]
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
  result: SearchResult[]
  num_pages: number
  per_page: number
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

  private async request<T>(path: string): Promise<T> {
    await this.rateLimiter.acquire()

    const url = `${BASE_URL}${path}`
    const response = await fetch(url, { headers: this.getHeaders() })

    if (!response.ok) {
      if (response.status === 429) {
        // Rate limited — wait and retry once
        await new Promise((r) => setTimeout(r, 5000))
        await this.rateLimiter.acquire()
        const retryResponse = await fetch(url, { headers: this.getHeaders() })
        if (!retryResponse.ok) {
          throw new Error(`API error: ${retryResponse.status} ${retryResponse.statusText}`)
        }
        return retryResponse.json() as Promise<T>
      }
      throw new Error(`API error: ${response.status} ${response.statusText}`)
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
    if (options.sort) params.set('sort', options.sort)

    return this.request<SearchResponse>(`/search?${params.toString()}`)
  }

  async getGallery(id: number): Promise<GalleryDetail> {
    return this.request<GalleryDetail>(`/gallery/${id}`)
  }

  async getCdnConfig(): Promise<CdnConfig> {
    // Cache for 1 hour
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

  /**
   * Get user profile — used to validate an API key.
   * Requires a valid API key to be set.
   */
  async getUser(): Promise<UserProfile> {
    return this.request<UserProfile>('/user')
  }

  /**
   * Get paginated favorites list for the authenticated user.
   * Requires a valid API key to be set.
   */
  async getFavorites(page = 1, query?: string): Promise<FavoritesResponse> {
    const params = new URLSearchParams()
    params.set('page', String(page))
    if (query) params.set('query', query)
    return this.request<FavoritesResponse>(`/user/favorites?${params.toString()}`)
  }

  /**
   * Build the image URL for a given gallery page.
   */
  async getImageUrl(galleryId: number, pageNumber: number, imageType: string): Promise<string> {
    const cdn = await this.getCdnConfig()
    const server = cdn.image_server || cdn.servers[0]
    return `https://${server}/galleries/${galleryId}/${pageNumber}.${imageType}`
  }

  /**
   * Build the thumbnail URL for a given gallery.
   */
  async getThumbnailUrl(galleryId: number, imageType: string): Promise<string> {
    const cdn = await this.getCdnConfig()
    const server = cdn.image_server || cdn.servers[0]
    return `https://${server}/galleries/${galleryId}/thumb.${imageType}`
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
