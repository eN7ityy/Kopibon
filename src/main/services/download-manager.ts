import { join, basename } from 'path'
import { mkdirSync, existsSync, statSync, rmSync } from 'fs'
import { Worker } from 'worker_threads'
import { app, Notification } from 'electron'
import { getLogger } from './logger'
import { attachWorkerLogForwarding } from './worker-logger'
import { downloadRepo } from '../db/repositories/download.repo'
import { galleryRepo } from '../db/repositories/gallery.repo'
import { settingsRepo } from '../db/repositories/settings.repo'
import { libraryRepo } from '../db/repositories/library.repo'
import { relativizeLibraryPath } from './library-paths'
import { getApiClient } from './api-client'
// import { getKavitaClient } from './kavita-client'
import { resolveLanguageName } from './xml-utils'
import { countPages } from './page-count'
import type { GalleryMetadata } from './metadata/file-metadata'
import type { GalleryDetail } from './api-client'

// ─── Cached gallery metadata ─────────────────────────────────────────────────

/**
 * A cached gallery row, but only when it is a real API response.
 *
 * The `gallery` table holds two very different things. Downloads cache the
 * whole API response there. The library scanner also writes a row when it reads
 * an nhentai id out of a filename, and that one is a stub:
 *
 *   {"id":6436,"title":{"pretty":"Breast Play 2"}}
 *
 * 4,357 of 4,409 rows in a real library are that shape. A download that trusted
 * one crashed on `gallery.tags.find(...)`, because the stub has no tags — nor
 * `media_id`, `num_pages` or `pages`, which are the fields that actually fetch
 * the images. So the stub is not a partial cache to be topped up; it is a cache
 * miss wearing a row.
 *
 * Returning null sends the caller to the API, and its `upsert` then replaces
 * the stub with the full response — so this repairs the row as a side effect
 * rather than needing a migration.
 */
export function parseCachedGallery(rawJson: string | null | undefined): GalleryDetail | null {
  if (!rawJson) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    // Unparseable cache is a cache miss, not a failed download.
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const gallery = parsed as Partial<GalleryDetail>

  // Every field the download pipeline goes on to read without checking.
  const usable =
    Array.isArray(gallery.tags) &&
    Array.isArray(gallery.pages) &&
    gallery.pages.length > 0 &&
    typeof gallery.num_pages === 'number' &&
    gallery.num_pages > 0 &&
    gallery.media_id != null &&
    Boolean(gallery.title)

  return usable ? (gallery as GalleryDetail) : null
}

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
  outputFormat: string
  cancelRequested: boolean
  paused: boolean
}

// ─── Paths ────────────────────────────────────────────────────────────────────

/**
 * Scratch space for downloaded page images, resolved lazily so we use
 * Electron's per-platform userData location rather than $HOME (which is unset
 * on Windows, previously sending everything to C:\tmp).
 */
function imageDownloadRoot(): string {
  const base = app?.getPath ? app.getPath('userData') : join(process.cwd(), '.kopibon')
  return join(base, 'download-tmp')
}

/** Persistent thumbnail cache — must outlive reboots, so not in os.tmpdir(). */
function thumbnailRoot(): string {
  const base = app?.getPath ? app.getPath('userData') : join(process.cwd(), '.kopibon')
  return join(base, 'thumbnails')
}

/** Best-effort recursive delete of a gallery's scratch directory. */
function purgeScratchDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* leftover temp files are not fatal */
  }
}

// ─── Download Manager ─────────────────────────────────────────────────────────

export class DownloadManager {
  private activeDownloads: Map<number, ActiveDownload> = new Map()
  private maxConcurrent: number
  private progressCallback: ProgressCallback | null = null
  private processingQueue = false

  /** Consecutive non-404 errors before a server is demoted. */
  private static readonly DEMOTE_THRESHOLD = 3

  /** Consecutive non-404 errors each server has accumulated, keyed by bare hostname. */
  private serverFailures = new Map<string, number>()

  /** Servers currently considered unreliable, keyed by bare hostname. */
  private demotedServers = new Set<string>()

  constructor(maxConcurrent = 3) {
    this.maxConcurrent = maxConcurrent
  }

  /**
   * Set the number of simultaneous downloads. Clamped to the range the
   * Settings slider exposes (1-8). Raising it starts more work immediately.
   */
  setMaxConcurrent(n: number): void {
    const next = Number.isFinite(n) ? Math.max(1, Math.min(8, Math.floor(n))) : this.maxConcurrent
    if (next === this.maxConcurrent) return
    const raised = next > this.maxConcurrent
    this.maxConcurrent = next
    getLogger('downloads').info(`Concurrency set to ${next}`)
    // Fill the newly available slots rather than waiting for the next event.
    if (raised) this.processQueue()
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent
  }

  /**
   * Apply the persisted `downloadConcurrency` setting. Called at startup and
   * whenever settings are saved — previously the setting was written to the DB
   * and never read, so the slider had no effect.
   */
  applyConcurrencyFromSettings(): void {
    const raw = settingsRepo.get('downloadConcurrency')
    if (raw === undefined) return
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return
    this.setMaxConcurrent(parsed)
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
          outputFormat: nextItem.outputFormat || 'cbz',
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

  private dequeueNext(): { id: number; galleryId: number; outputFormat?: string } | null {
    const items = downloadRepo.findByStatus('queued')
    if (items.length === 0) return null

    // Get highest priority first, then oldest
    items.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt)
    const next = items[0]

    downloadRepo.update(next.id, {
      status: 'downloading',
      startedAt: Date.now()
    } as Parameters<typeof downloadRepo.update>[1])

    return { id: next.id, galleryId: next.galleryId, outputFormat: (next as any).outputFormat || 'cbz' }
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
   * Reorder the CDN server list so reliable servers come first.
   *
   * Demoted servers stay in the list but sink to the end, so they are still
   * tried as a last resort. Keys are the bare hostname (protocol stripped),
   * which is what the failure trackers use.
   */
  private orderServers(servers: string[]): string[] {
    const hostOf = (raw: string): string => raw.replace(/^https?:\/\//, '')
    const reliable = servers.filter((s) => !this.demotedServers.has(hostOf(s)))
    const demoted = servers.filter((s) => this.demotedServers.has(hostOf(s)))
    return [...reliable, ...demoted]
  }

  /**
   * Reset downloads that were interrupted by a crash or a hard quit.
   *
   * Rows left as 'downloading'/'converting' have no live worker behind them,
   * so without this they stay "active" forever and inflate the status bar
   * counts. Called once at startup, before processQueue().
   */
  reconcileInterrupted(): number {
    let requeued = 0
    for (const status of ['downloading', 'converting']) {
      for (const item of downloadRepo.findByStatus(status)) {
        downloadRepo.update(item.id, {
          status: 'queued',
          startedAt: null,
          errorMessage: null
        } as Parameters<typeof downloadRepo.update>[1])
        // Page rows are re-created from scratch on the next attempt
        downloadRepo.deletePages(item.id)
        purgeScratchDir(join(imageDownloadRoot(), String(item.galleryId)))
        requeued++
      }
    }
    if (requeued > 0) {
      getLogger('downloads').info(`Re-queued ${requeued} interrupted download(s)`)
    }
    return requeued
  }

  /**
   * Remove the "pending download" library placeholder created in step 1.5.
   *
   * Placeholders are marked isCustom=2 with an empty filePath; every status
   * resolver reads that as "downloading", so leaving one behind after a
   * failure made the gallery look like it was downloading forever.
   */
  private removePlaceholder(galleryId: number): void {
    try {
      const item = libraryRepo.findByGalleryId(galleryId)
      if (item && item.isCustom === 2 && !item.filePath) {
        // libraryRepo.delete() removes artist rows too
        libraryRepo.delete(item.id)
      }
    } catch {
      /* best effort */
    }
  }

  /**
   * Mark a queue item failed and undo the side effects of a partial attempt.
   */
  private failDownload(
    queueId: number,
    galleryId: number,
    title: string,
    errorMessage: string
  ): void {
    downloadRepo.update(queueId, {
      status: 'failed',
      errorMessage
    } as Parameters<typeof downloadRepo.update>[1])
    this.removePlaceholder(galleryId)
    purgeScratchDir(join(imageDownloadRoot(), String(galleryId)))
    this.emitProgress(queueId, galleryId, title, 0, 0, 0, 0, 'failed')
  }

  /**
   * Main download pipeline for a single gallery.
   */
  private async downloadItem(active: ActiveDownload): Promise<void> {
    const { queueId, galleryId } = active
    const client = getApiClient()
    const scratchDir = join(imageDownloadRoot(), String(galleryId))

    try {
      // Step 1: Fetch gallery metadata
      const existingGallery = galleryRepo.findById(galleryId)
      let gallery: GalleryDetail

      const cachedGallery = existingGallery ? parseCachedGallery(existingGallery.rawJson) : null

      if (cachedGallery) {
        gallery = cachedGallery
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
      // Artist priority: artist tag → group tag → 'Unknown'
      const primaryArtist =
        gallery.tags.find((t) => t.type === 'artist')?.name ||
        gallery.tags.find((t) => t.type === 'group')?.name ||
        'Unknown'
      // Determine library root from settings (stored as 'libraryPath')
      const libraryRoot =
        settingsRepo.get('libraryPath') ||
        join(process.env.HOME || '/tmp', 'Doujinshi-Library')

      // Step 1.5: Create placeholder library entry so search shows "Downloading"
      const tagNames = gallery.tags.map((t) => t.name).join(', ')
      // First language-type tag is commonly 'translated', which is not a
      // language. Stores the canonical display name ('English'), which is what
      // the library UI shows and what emitters convert to ISO on write.
      const languageIso = resolveLanguageName(
        gallery.tags.filter((t) => t.type === 'language').map((t) => t.name)
      )
      const existingLib = libraryRepo.findByGalleryId(gallery.id)
      if (!existingLib) {
        libraryRepo.insert({
          galleryId: gallery.id,
          isCustom: 2, // 2 = pending download
          customTitle: gallery.title.pretty,
          customTags: tagNames,
          customLanguage: languageIso,
          customDate: null,
          customCoverPath: null,
          filePath: '', // placeholder, will be set on completion
          fileSize: 0,
          format: active.outputFormat || 'cbz',
          primaryArtist,
          seriesName: null,
          publisher: gallery.tags.find((t) => t.type === 'group')?.name || null,
          readProgress: 0,
          fileMtime: Date.now(),
          addedAt: Date.now(),
          updatedAt: Date.now()
        })
      }

      // Step 2: Fetch CDN servers
      const cdn = await client.getCdnConfig()
      const servers = this.orderServers([...cdn.image_servers].filter(Boolean))

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

      // Step 4: Ensure temp directory (fresh — drop anything left by a
      // previous attempt so a partial run can't contribute stale pages)
      const downloadDir = scratchDir
      purgeScratchDir(downloadDir)
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
          this.failDownload(queueId, galleryId, title, 'Cancelled by user')
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
            // Track real bytes so the speed readout isn't permanently 0 KB/s
            try {
              totalBytes += statSync(result.value).size
            } catch {
              /* size is only used for the speed estimate */
            }
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
        this.failDownload(queueId, galleryId, title, 'Cancelled by user')
        return
      }

      // Check if all pages downloaded
      const failedCount = totalPages - completedPages
      if (failedCount > 0) {
        this.failDownload(
          queueId,
          galleryId,
          title,
          `${failedCount} of ${totalPages} pages failed to download`
        )
        return
      }

      // Step 6: Generate PDF
      this.emitProgress(queueId, galleryId, title, totalPages, completedPages, 0, 0, 'converting')
      downloadRepo.update(queueId, {
        status: 'converting'
      } as Parameters<typeof downloadRepo.update>[1])

      // Route by output format
      const isCbz = active.outputFormat === 'cbz'
      const ext = isCbz ? 'cbz' : 'pdf'

      // Build output path: {libraryRoot}/{Primary Artist}/[nhentai-{id}] {safe_title}.{ext}
      const outputDir = join(libraryRoot, primaryArtist)
      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true })
      }
      const safeTitle = title.replace(/[/\\?%*:|"<>]/g, '_').substring(0, 180)
      const outputPath = join(outputDir, `${safeTitle} [nhentai-${galleryId}].${ext}`)

      // Preserve existing user-set metadata (series/volume) from previous download
      const existingItem = libraryRepo.findByGalleryId(galleryId)
      const existingSeries = existingItem?.seriesName || undefined
      const existingVolume = existingItem?.seriesIndex ?? undefined

      const validPaths = downloadedPaths.filter(Boolean) as string[]

      // Offload generation + metadata embedding + thumbnail to a worker thread
      const thumbDir = thumbnailRoot()
      const metadataPayload: GalleryMetadata = {
        id: gallery.id,
        title: gallery.title,
        tags: gallery.tags,
        uploadDate: gallery.upload_date,
        numPages: gallery.num_pages,
        publisher: gallery.tags.find((t) => t.type === 'group')?.name || undefined,
        seriesName: existingSeries,
        seriesIndex: existingVolume
      }

      const workerResult = await new Promise<{ thumbnailPath?: string }>((resolve, reject) => {
        const workerName = isCbz ? 'download-cbz.worker.js' : 'download-pdf.worker.js'
        const workerPath = join(__dirname, 'services', workerName)
        const worker = new Worker(workerPath)
        attachWorkerLogForwarding(worker, getLogger('downloads'))

        /*
         * Settle once, then end the thread.
         *
         * The generation workers never exit by themselves — each is parked on a
         * parentPort listener — so before this, every completed download left a
         * live worker behind, one V8 isolate each. Twenty downloads measured at
         * twenty live threads and 171 MB of RSS that never came back.
         *
         * Only the terminal messages settle: terminating on `progress` would
         * kill the worker mid-build, which is a bug this code has had before.
         */
        let settled = false
        const finish = (done: () => void): void => {
          if (settled) return
          settled = true
          done()
          worker.terminate().catch(() => {
            /* already gone */
          })
        }

        worker.on('message', (msg: { type: string; current?: number; total?: number; outputPath?: string; thumbnailPath?: string; message?: string }) => {
          if (msg.type === 'progress') {
            this.emitProgress(
              queueId, galleryId, title, msg.total!, msg.current!, 0, 0, 'converting'
            )
          } else if (msg.type === 'complete') {
            finish(() => resolve({ thumbnailPath: msg.thumbnailPath }))
          } else if (msg.type === 'error') {
            finish(() => reject(new Error(msg.message || 'PDF generation failed')))
          }
        })

        worker.on('error', (err) => finish(() => reject(err)))
        worker.on('exit', (code) => {
          if (code !== 0) finish(() => reject(new Error(`PDF worker exited with code ${code}`)))
        })

        const workerMsg: Record<string, unknown> = {
          type: 'generate',
          imagePaths: validPaths,
          outputPath,
          metadata: metadataPayload,
          firstImagePath: validPaths.length > 0 ? validPaths[0] : undefined,
          thumbnailDir: thumbDir,
          galleryId
        }
        if (isCbz) {
          // Reading direction was hardcoded in the worker, so cbzMangaDirection
          // only ever affected conversions, never downloads.
          workerMsg.mangaDirection = settingsRepo.get('cbzMangaDirection') || 'YesAndRightToLeft'
        }
        // Only PDF worker needs options; CBZ worker doesn't use them
        if (!isCbz) {
          const compressPdf = settingsRepo.get('compressPdf') !== 'false'
          const compressQuality = Number(settingsRepo.get('compressionQuality') || '80')
          const pageSize = (settingsRepo.get('pageSize') || 'Dynamic') === 'Fit to Image' ? 'fit'
            : (settingsRepo.get('pageSize') || 'Dynamic') === 'Letter' ? 'letter'
            : (settingsRepo.get('pageSize') || 'Dynamic') === 'A4' ? 'a4'
            : 'dynamic'
          const blackBg = settingsRepo.get('blackBackground') !== 'false'

          workerMsg.options = {
            pageSize,
            quality: compressPdf ? Math.max(1, Math.min(95, compressQuality)) : 100,
            blackBackground: blackBg
          }
        }
        worker.postMessage(workerMsg)
      })

      // Step 8: Mark complete
      downloadRepo.update(queueId, {
        status: 'completed',
        completedAt: Date.now()
      } as Parameters<typeof downloadRepo.update>[1])

      // Step 9: Update library entry (placeholder was created in Step 1.5)
      const libItem = libraryRepo.findByGalleryId(gallery.id)
      if (libItem) {
        let fileSize = 0
        try { fileSize = statSync(outputPath).size } catch { /* ignore */ }
        const dateStr = new Date(gallery.upload_date * 1000).toISOString().split('T')[0]

        /*
         * A re-download supersedes whatever file the row pointed at.
         *
         * Removed here, once the new file is on disk and about to be recorded,
         * rather than before the download starts. Re-download used to delete
         * first and fetch second, so a failure anywhere in between left the
         * gallery gone with nothing to restore. Now the worst case is an
         * unchanged library.
         *
         * Skipped when the paths match, which is the common case — the new
         * download simply overwrote it — and when the row is a placeholder,
         * whose filePath is empty.
         */
        const superseded = libItem.filePath
        if (superseded && superseded !== outputPath && existsSync(superseded)) {
          try {
            rmSync(superseded, { force: true })
            getLogger('downloads').info('replaced the previous file for a re-download', {
              galleryId: gallery.id,
              removed: superseded,
              replacedBy: outputPath
            })
          } catch (err) {
            // Leaves a stray file, which a rescan will pick up. Not a reason to
            // fail a download that has already succeeded.
            getLogger('downloads').warn('could not remove the superseded file', {
              path: superseded,
              error: String(err)
            })
          }
        }

        // Counted from the file just written, not from gallery.num_pages: a
        // download that dropped a page should report what is actually there.
        const downloadedPages = await countPages(outputPath, active.outputFormat || 'cbz')

        libraryRepo.update(libItem.id, {
          isCustom: 0,
          pageCount: downloadedPages,
          customTitle: gallery.title.pretty,
          customTags: tagNames,
          customLanguage: languageIso,
          customDate: dateStr,
          filePath: relativizeLibraryPath(outputPath, libraryRoot),
          fileSize,
          publisher: gallery.tags.find((t) => t.type === 'group')?.name || null,
          fileMtime: Date.now(),
          updatedAt: Date.now()
        })

        // Insert artists (if not already present)
        const artistTags = gallery.tags.filter((t) => t.type === 'artist')
        const existingArtists = libraryRepo.getArtists(libItem.id)
        if (existingArtists.length === 0) {
          for (let i = 0; i < artistTags.length; i++) {
            libraryRepo.addArtist({
              libraryItemId: libItem.id,
              artistName: artistTags[i].name,
              sortOrder: i
            })
          }
        }

        // Apply thumbnail path from worker result
        if (workerResult.thumbnailPath) {
          libraryRepo.update(libItem.id, {
            customCoverPath: basename(workerResult.thumbnailPath),
            thumbnailPath: basename(workerResult.thumbnailPath)
          })
        }
      }

      // Step 10: Page bookkeeping is only useful while a download is in
      // flight — drop it so the table doesn't grow without bound.
      downloadRepo.deletePages(queueId)

      this.emitProgress(queueId, galleryId, title, totalPages, totalPages, 0, 0, 'completed')

      // F4: Show system notification on completion
      if (settingsRepo.get('showNotifications') !== 'false') {
        new Notification({ title: 'Download Complete', body: `${title} has been added to your library` }).show()
      }

      // F5: Kavita folder scans are DISABLED — `scan-folder` on an artist/series
      // folder does not discover brand-new files in this setup (confirmed via a
      // clean-state test); only a full ~900-file library scan works, which is too
      // heavy per download. Kavita's own watch folder handles discovery instead.
      // const kavita = getKavitaClient()
      // if (kavita.isConfigured()) {
      //   void kavita.scanFolder(dirname(outputPath)).catch(() => {})
      // }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.failDownload(queueId, galleryId, 'Error', errorMsg)
    } finally {
      // Page images are large and only needed to build the PDF. Nothing
      // cleaned these up before, so every download leaked a full second copy
      // of the gallery into userData.
      purgeScratchDir(scratchDir)
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

        // Re-promote the server: a success resets its failure count and clears
        // any prior demotion, so a briefly flaky server is trusted again.
        this.serverFailures.delete(server)
        if (this.demotedServers.has(server)) {
          this.demotedServers.delete(server)
          getLogger('downloads').info(`Server ${server} re-promoted after successful download`)
        }

        return filePath
      } catch (err) {
        // ── Track server failure ──
        // Only server-level problems count toward demotion. A 404 is a
        // page-specific miss handled above via `continue`, so it never lands
        // here. `server` is already protocol-stripped (see URL building above),
        // which is also the key the failure trackers use.
        const failureCount = (this.serverFailures.get(server) || 0) + 1
        this.serverFailures.set(server, failureCount)
        if (failureCount >= DownloadManager.DEMOTE_THRESHOLD) {
          this.demotedServers.add(server)
          getLogger('downloads').warn(
            `Server ${server} demoted after ${failureCount} consecutive failures`
          )
        }

        if (attempt === maxRetries - 1) {
          getLogger('downloads').warn(
            `Page ${pageNumber} download failed after ${maxRetries} attempts`,
            { err: err instanceof Error ? err : new Error(String(err)) }
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
