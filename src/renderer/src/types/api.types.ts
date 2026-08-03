// ─── nhentai API Response Types (matching openapi_documentation.json) ───────

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
  /** Only present when ?include=favorite is passed (requires API key). Null otherwise. */
  is_favorited?: boolean | null
  pages: PageInfo[]
}

export interface CdnConfig {
  image_servers: string[]
  thumb_servers: string[]
}

export const SORT_OPTIONS = [
  { value: '', label: 'Date' },
  { value: 'popular', label: 'Popular (All-Time)' },
  { value: 'popular-today', label: 'Popular (Today)' },
  { value: 'popular-week', label: 'Popular (Week)' },
  { value: 'popular-month', label: 'Popular (Month)' }
] as const

export type DownloadStatus = 'not_downloaded' | 'in_library' | 'queued' | 'downloading' | 'converting' | 'completed' | 'failed'

export interface DownloadQueueItem {
  id: number
  galleryId: number
  status: string
  priority: number
  retryCount: number
  maxRetries: number
  errorMessage: string | null
  outputFormat: string
  outputDirectory: string | null
  queuedAt: number
  startedAt: number | null
  completedAt: number | null
}

export interface DownloadPageItem {
  id: number
  queueId: number
  pageNumber: number
  url: string
  status: string
  localPath: string | null
  fileSize: number | null
  retryCount: number
}

export interface DownloadProgressEvent {
  queueId: number
  galleryId: number
  title: string
  status: string
  totalPages: number
  completedPages: number
  percentage: number
  speedKBps: number
  etaSeconds: number
  errorMessage?: string
}
