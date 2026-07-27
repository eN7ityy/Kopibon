// ─── nhentai API Response Types (shared with renderer) ──────────────────────

export interface SearchResult {
  id: number
  media_id: string
  title: {
    english: string
    japanese: string | null
    pretty: string
  }
  images?: {
    cover?: { t: string; w: number; h: number }
    pages?: Array<{ t: string; w: number; h: number }>
    thumbnail?: { t: string; w: number; h: number }
  }
  num_pages: number
  num_favorites: number
  upload_date: number
  tags?: Array<{
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

export interface SearchParams {
  query: string
  page?: number
  sort?: 'recent' | 'popular' | 'popular-today' | 'popular-week' | 'popular-month' | 'popular-year'
  language?: string
  category?: string
}

export const SORT_OPTIONS = [
  { value: 'recent', label: 'Recent' },
  { value: 'popular', label: 'Popular (All-Time)' },
  { value: 'popular-today', label: 'Popular (Today)' },
  { value: 'popular-week', label: 'Popular (Week)' },
  { value: 'popular-month', label: 'Popular (Month)' },
  { value: 'popular-year', label: 'Popular (Year)' }
] as const

export const LANGUAGE_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'english', label: 'English' },
  { value: 'japanese', label: 'Japanese' },
  { value: 'chinese', label: 'Chinese' }
] as const

export const CATEGORY_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'doujinshi', label: 'Doujinshi' },
  { value: 'manga', label: 'Manga' },
  { value: 'artist-cg', label: 'Artist CG' },
  { value: 'game-cg', label: 'Game CG' },
  { value: 'imageset', label: 'Imageset' },
  { value: 'cosplay', label: 'Cosplay' },
  { value: 'asian-porn', label: 'Asian Porn' },
  { value: 'western', label: 'Western' },
  { value: 'non-h', label: 'Non-H' }
] as const

export type DownloadStatus = 'not_downloaded' | 'in_library' | 'queued' | 'downloading' | 'completed' | 'failed'

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
