import { join } from 'path'
import { mkdirSync, existsSync, statSync } from 'fs'
import { downloadRepo } from '../db/repositories/download.repo'
import { galleryRepo } from '../db/repositories/gallery.repo'
import { settingsRepo } from '../db/repositories/settings.repo'
import { libraryRepo } from '../db/repositories/library.repo'
import { getApiClient } from './api-client'
import { generatePdf, type PdfOptions } from './pdf-generator'
import { embedMetadata } from './metadata-writer'
import type { GalleryDetail } from './api-client'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DownloadProgress {
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

export type ProgressCallback = (progress: DownloadProgress) => void

interface ActiveDownload {
  queueId: number
  galleryId: number
  cancelRequested: boolean
  paused: boolean
}

// ─── Constants ────────────────────────────────────────────────────────────────

const IMAGE_DOWNLOAD_DIR = join(process.env.HOME || '/tmp', '.config', 'doujin-downloader', 'tmp')

// ─── Download Manager ─────────────────────────────────────────────────────────

export class DownloadManager {
  private activeDownloads: Map<number, ActiveDownload> = new Map()
  private maxConcurrent: number
  private progressCallback: ProgressCallback | null = null
  private processingQueue = false

  constructor(maxConcurrent = 3) {
    this.maxConcurrent = maxConcurrent
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = n
  }

  onProgress(cb: ProgressCallback): void {
    this.progressCallback = cb
  }

  /**
   * Start processing the download queue. Called on app startup and
   * when new items are added.
   */
  async processQueue(): Promise<void> {
    if (this.processingQueue) return
    this.processingQueue = true

    try {
      while (this.activeDownloads.size < this.maxConcurrent) {
        const nextItem = this.dequeueNext()
        if (!nextItem) break

        const active: ActiveDownload = {
          queueId: nextItem.id,
          galleryId: nextItem.galleryId,
          cancelRequested: false,
          paused: false
        }
        this.activeDownloads.set(nextItem.id, active)

        // Fire and forget — errors are handled inside
        this.downloadItem(active).finally(() => {
          this.activeDownloads.delete(nextItem.id)
          // Continue processing queue
          this.processingQueue = false
          this.processQueue()
        })
      }
    } finally {
      this.processingQueue = false
    }
  }

  private dequeueNext(): { id: number; galleryId: number } | null {
    const items = downloadRepo.findByStatus('queued')
    if (items.length === 0) return null

    // Get highest priority first, then oldest
    items.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt)
    const next = items[0]

    downloadRepo.update(next.id, {
      status: 'downloading',
      startedAt: Date.now()
    } as Parameters<typeof downloadRepo.update>[1])

    return { id: next.id, galleryId: next.galleryId }
  }

  private emitProgress(
    queueId: number,
    galleryId: number,
    title: string,
    totalPages: number,
    completedPages: number,
    speedKBps: number,
    etaSeconds: number,
    status = 'downloading'
  ): void {
    if (!this.progressCallback) return
    this.progressCallback({
      queueId,
      galleryId,
      title,
      status,
      totalPages,
      completedPages,
      percentage: totalPages > 0 ? Math.round((completedPages / totalPages) * 100) : 0,
      speedKBps: Math.round(speedKBps * 10) / 10,
      etaSeconds: Math.round(etaSeconds)
    })
  }

  /**
   * Main download pipeline for a single gallery.
   */
  private async downloadItem(active: ActiveDownload): Promise<void> {
    const { queueId, galleryId } = active
    const client = getApiClient()

    try {
      // Step 1: Fetch gallery metadata
      const existingGallery = galleryRepo.findById(galleryId)
      let gallery: GalleryDetail

      if (existingGallery) {
        gallery = JSON.parse(existingGallery.rawJson) as GalleryDetail
      } else {
        this.emitProgress(queueId, galleryId, 'Fetching metadata...', 0, 0, 0, 0)
        gallery = await client.getGallery(galleryId)

        // Cache to DB
        galleryRepo.upsert({
          id: gallery.id,
          mediaId: Number(gallery.media_id),
          titlePretty: gallery.title.pretty,
          titleEnglish: gallery.title.english,
          titleJapanese: gallery.title.japanese,
          pageCount: gallery.num_pages,
          favoritesCount: gallery.num_favorites,
          uploadDate: gallery.upload_date,
          thumbnailUrl: gallery.thumbnail
            ? `https://t.nhentai.net/${gallery.thumbnail.path}`
            : null,
          coverUrl: gallery.cover
            ? `https://t.nhentai.net/${gallery.cover.path}`
            : null,
          rawTagsJson: JSON.stringify(gallery.tags),
          rawJson: JSON.stringify(gallery),
          createdAt: Date.now(),
          updatedAt: Date.now()
        } as Parameters<typeof galleryRepo.upsert>[0])
      }

      const title = gallery.title.pretty
      const totalPages = gallery.num_pages

      // Extract primary artist from tags
      const primaryArtist =
        gallery.tags.find((t) => t.type === 'artist')?.name || 'Unknown'
      // Determine library root from settings, fall back to ~/Downloads
      const libraryRoot =
        settingsRepo.get('libraryRoot') ||
        join(process.env.HOME || '/tmp', 'Downloads')

      // Step 2: Fetch CDN servers
      const cdn = await client.getCdnConfig()
      const servers = [...cdn.image_servers].filter(Boolean)

      // Step 3: Insert page records
      for (let i = 1; i <= totalPages; i++) {
        downloadRepo.insertPage({
          queueId,
          pageNumber: i,
          url: '', // Will be set per server during download
          status: 'pending',
          retryCount: 0
        } as Parameters<typeof downloadRepo.insertPage>[0])
      }

      // Step 4: Ensure temp directory
      const downloadDir = join(IMAGE_DOWNLOAD_DIR, String(galleryId))
      if (!existsSync(downloadDir)) {
        mkdirSync(downloadDir, { recursive: true })
      }

      // Step 5: Download pages (3 parallel)
      const pageItems = downloadRepo.getPages(queueId)
      const downloadedPaths: string[] = new Array(totalPages).fill('')
      let completedPages = 0
      let totalBytes = 0
      const startTime = Date.now()

      // Process pages in batches of 3
      const CONCURRENT_PAGES = 3
      for (let batchStart = 0; batchStart < pageItems.length; batchStart += CONCURRENT_PAGES) {
        if (active.cancelRequested) {
          downloadRepo.update(queueId, {
            status: 'failed',
            errorMessage: 'Cancelled by user'
          } as Parameters<typeof downloadRepo.update>[1])
          return
        }

        // Wait if paused
        while (active.paused && !active.cancelRequested) {
          await new Promise((r) => setTimeout(r, 500))
        }
        if (active.cancelRequested) break

        const batch = pageItems.slice(batchStart, batchStart + CONCURRENT_PAGES)
        const batchResults = await Promise.allSettled(
          batch.map(async (page) => {
            const pageInfo = gallery.pages?.[page.pageNumber - 1]
            const ext = pageInfo?.path?.split('.').pop() || 'jpg'
            return this.downloadPageWithRetry(
              page.pageNumber,
              gallery.media_id,
              ext,
              servers,
              downloadDir,
              active,
              3
            )
          })
        )

        for (let j = 0; j < batch.length; j++) {
          const result = batchResults[j]
          const page = batch[j]

          if (result.status === 'fulfilled' && result.value) {
            downloadedPaths[page.pageNumber - 1] = result.value
            completedPages++
            totalBytes += result.value ? 0 : 0 // We'll track bytes later
          } else {
            // Page failed
            downloadRepo.updatePage(page.id, {
              status: 'failed',
              retryCount: 3
            } as Parameters<typeof downloadRepo.updatePage>[1])
          }

          const elapsed = (Date.now() - startTime) / 1000
          const speedKBps = elapsed > 0 ? totalBytes / 1024 / elapsed : 0
          const remainingPages = totalPages - completedPages
          const etaSeconds =
            completedPages > 0
              ? (elapsed / completedPages) * remainingPages
              : remainingPages * 2

          this.emitProgress(
            queueId,
            galleryId,
            title,
            totalPages,
            completedPages,
            speedKBps,
            etaSeconds
          )
        }
      }

      if (active.cancelRequested) {
        downloadRepo.update(queueId, {
          status: 'failed',
          errorMessage: 'Cancelled by user'
        } as Parameters<typeof downloadRepo.update>[1])
        return
      }

      // Check if all pages downloaded
      const failedCount = totalPages - completedPages
      if (failedCount > 0) {
        downloadRepo.update(queueId, {
          status: 'failed',
          errorMessage: `${failedCount} pages failed to download`
        } as Parameters<typeof downloadRepo.update>[1])
        return
      }

      // Step 6: Generate PDF
      this.emitProgress(queueId, galleryId, title, totalPages, completedPages, 0, 0, 'converting')
      downloadRepo.update(queueId, {
        status: 'converting'
      } as Parameters<typeof downloadRepo.update>[1])

      // Build output path: {libraryRoot}/{Primary Artist}/[nhentai-{id}] {safe_title}.pdf
      const outputDir = join(libraryRoot, primaryArtist)
      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true })
      }
      const safeTitle = title.replace(/[/\\?%*:|"<>]/g, '_').substring(0, 180)
      const pdfPath = join(outputDir, `[nhentai-${galleryId}] ${safeTitle}.pdf`)

      const pdfOptions: PdfOptions = {
        pageSize: 'dynamic',
        quality: 90,
        blackBackground: false
      }

      const validPaths = downloadedPaths.filter(Boolean) as string[]
      // Emit conversion progress periodically during PDF generation
      await generatePdf(validPaths, pdfPath, pdfOptions, (current: number, total: number) => {
        this.emitProgress(
          queueId, galleryId, title, total, current, 0, 0, 'converting'
        )
      })

      // Step 7: Embed metadata
      await embedMetadata(pdfPath, {
        id: gallery.id,
        title: gallery.title,
        tags: gallery.tags,
        uploadDate: gallery.upload_date,
        numPages: gallery.num_pages
      })

      // Step 8: Mark complete
      downloadRepo.update(queueId, {
        status: 'completed',
        completedAt: Date.now()
      } as Parameters<typeof downloadRepo.update>[1])

      // Step 9: Add to library
      let fileSize = 0
      try { fileSize = statSync(pdfPath).size } catch { /* ignore */ }

      const now = Date.now()
      const artistTags = gallery.tags.filter((t) => t.type === 'artist')
      const tagNames = gallery.tags.map((t) => t.name).join(', ')
      const languageTag = gallery.tags.find((t) => t.type === 'language')
      const dateStr = new Date(gallery.upload_date * 1000).toISOString().split('T')[0]

      // Check if already in library (avoid duplicates)
      const existingLib = libraryRepo.findByGalleryId(gallery.id)
      if (!existingLib) {
        const libId = libraryRepo.insert({
          galleryId: gallery.id,
          isCustom: 0,
          customTitle: gallery.title.pretty,
          customTags: tagNames,
          customLanguage: languageTag?.name || null,
          customDate: dateStr,
          customCoverPath: null,
          filePath: pdfPath,
          fileSize,
          format: 'pdf',
          primaryArtist,
          seriesName: null,
          readProgress: 0,
          fileMtime: now,
          addedAt: now,
          updatedAt: now
        })

        // Insert artists
        for (let i = 0; i < artistTags.length; i++) {
          libraryRepo.addArtist({
            libraryItemId: libId,
            artistName: artistTags[i].name,
            sortOrder: i
          })
        }
      }

      this.emitProgress(queueId, galleryId, title, totalPages, totalPages, 0, 0, 'completed')
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      downloadRepo.update(queueId, {
        status: 'failed',
        errorMessage: errorMsg
      } as Parameters<typeof downloadRepo.update>[1])

      this.emitProgress(queueId, galleryId, 'Error', 0, 0, 0, 0, 'failed')
    }
  }

  /**
   * Download a single page with retry logic across CDN servers.
   */
  private async downloadPageWithRetry(
    pageNumber: number,
    mediaId: string,
    imageType: string,
    servers: string[],
    downloadDir: string,
    active: ActiveDownload,
    maxRetries: number
  ): Promise<string | null> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (active.cancelRequested) return null

      // Rotate through servers
      const serverIndex = attempt % servers.length
      const rawServer = servers[serverIndex]
      // Strip protocol prefix if present (CDN may return https://host or just host)
      const server = rawServer.replace(/^https?:\/\//, '')
      const url = `https://${server}/galleries/${mediaId}/${pageNumber}.${imageType}`

      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 30000)

        const response = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Doujin-Downloader/1.0' }
        })

        clearTimeout(timeout)

        if (!response.ok) {
          if (response.status === 404) {
            // Try next server
            continue
          }
          throw new Error(`HTTP ${response.status}`)
        }

        const buffer = Buffer.from(await response.arrayBuffer())

        // Determine correct extension from image type
        const imageTypeLower = imageType.toLowerCase()
        let ext: string
        if (imageTypeLower === 'png') {
          ext = 'png'
        } else if (imageTypeLower === 'webp') {
          ext = 'webp'
        } else if (imageTypeLower === 'gif') {
          ext = 'gif'
        } else if (imageTypeLower === 'bmp') {
          ext = 'bmp'
        } else {
          ext = 'jpg'
        }

        const filePath = join(downloadDir, `${String(pageNumber).padStart(4, '0')}.${ext}`)

        // Write file
        const { writeFileSync } = await import('fs')
        writeFileSync(filePath, buffer)

        return filePath
      } catch (err) {
        if (attempt === maxRetries - 1) {
          console.error(
            `Failed to download page ${pageNumber} after ${maxRetries} attempts:`,
            err
          )
          return null
        }
        // Wait before retry with exponential backoff
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)))
      }
    }
    return null
  }

  /**
   * Pause a download.
   */
  pauseDownload(queueId: number): boolean {
    const active = this.activeDownloads.get(queueId)
    if (!active) {
      // Not active, try to pause in queue
      const item = downloadRepo.findById(queueId)
      if (item && item.status === 'queued') {
        downloadRepo.update(queueId, {
          status: 'paused'
        } as Parameters<typeof downloadRepo.update>[1])
        return true
      }
      return false
    }
    active.paused = true
    // Update DB so the UI can reflect the paused state
    downloadRepo.update(queueId, {
      status: 'paused'
    } as Parameters<typeof downloadRepo.update>[1])
    return true
  }

  /**
   * Resume a paused download.
   */
  resumeDownload(queueId: number): boolean {
    const active = this.activeDownloads.get(queueId)
    if (active) {
      active.paused = false
      // Update DB so the UI can reflect the downloading state
      downloadRepo.update(queueId, {
        status: 'downloading'
      } as Parameters<typeof downloadRepo.update>[1])
      return true
    }

    const item = downloadRepo.findById(queueId)
    if (item && item.status === 'paused') {
      downloadRepo.update(queueId, {
        status: 'queued'
      } as Parameters<typeof downloadRepo.update>[1])
      this.processQueue()
      return true
    }
    return false
  }

  /**
   * Cancel a download.
   */
  cancelDownload(queueId: number): boolean {
    const active = this.activeDownloads.get(queueId)
    if (active) {
      active.cancelRequested = true
      return true
    }

    const item = downloadRepo.findById(queueId)
    if (item && ['queued', 'paused'].includes(item.status)) {
      downloadRepo.delete(queueId)
      downloadRepo.deletePages(queueId)
      return true
    }
    return false
  }

  /**
   * Pause all active and queued downloads.
   */
  pauseAll(): void {
    for (const active of this.activeDownloads.values()) {
      active.paused = true
    }
    const queued = downloadRepo.findByStatus('queued')
    for (const item of queued) {
      downloadRepo.update(item.id, {
        status: 'paused'
      } as Parameters<typeof downloadRepo.update>[1])
    }
  }

  /**
   * Resume all paused downloads.
   */
  resumeAll(): void {
    for (const active of this.activeDownloads.values()) {
      active.paused = false
    }
    const paused = downloadRepo.findByStatus('paused')
    for (const item of paused) {
      downloadRepo.update(item.id, {
        status: 'queued'
      } as Parameters<typeof downloadRepo.update>[1])
    }
    this.processQueue()
  }
}

// Singleton
let instance: DownloadManager | null = null

export function getDownloadManager(): DownloadManager {
  if (!instance) {
    instance = new DownloadManager(3)
  }
  return instance
}
