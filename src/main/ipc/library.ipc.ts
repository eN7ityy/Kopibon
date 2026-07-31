import { ipcMain, BrowserWindow, app } from 'electron'
import { Worker } from 'worker_threads'
import { join as pathJoin } from 'path'
import { libraryRepo } from '../db/repositories/library.repo'
import { galleryRepo } from '../db/repositories/gallery.repo'
import { settingsRepo } from '../db/repositories/settings.repo'
import { conversionRepo } from '../db/repositories/conversion.repo'
import { getSqlite } from '../db/connection'
import { resolveOutputFormat } from '../services/output-format'
import { getStoredApiKey } from './auth.ipc'
import { renameSync, mkdirSync, existsSync, appendFileSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs'
import { createHash } from 'crypto'
import { dirname, join, basename } from 'path'
import { homedir } from 'os'

// ─── Metadata Worker Helper ────────────────────────────────────────────────

function spawnMetadataWorker(
  command: { type: 'apply'; pdfPath: string; metadata: Record<string, unknown> }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const workerPath = pathJoin(__dirname, 'services/metadata.worker.js')
    const worker = new Worker(workerPath)
    worker.on('message', (msg: { type: string; message?: string }) => {
      if (msg.type === 'complete') resolve()
      else if (msg.type === 'error') reject(new Error(msg.message || 'Metadata worker error'))
    })
    worker.on('error', reject)
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Metadata worker exited with code ${code}`))
    })
    worker.postMessage(command)
  })
}

let isScanning = false
let scanWorker: Worker | null = null

/**
 * Items currently being converted to CBZ, and items queued for it.
 *
 * Module-level rather than local to the handler because the edit paths need to
 * consult it. A conversion replaces the file on disk and rewrites `file_path`
 * and `format`; an edit landing in that window would either write metadata into
 * a file that is about to be replaced, or race the row update and leave the
 * database pointing at the deleted PDF. Disabling the buttons is not enough —
 * the guard has to be here, where the write actually happens.
 */
const cbzConverting = new Set<number>()
const cbzQueued = new Set<number>()

/** True when an item is mid-conversion or waiting for a runner. */
function isConversionLocked(id: number): boolean {
  return cbzConverting.has(id) || cbzQueued.has(id)
}

/** Standard refusal, so every guarded handler reports the same thing. */
function conversionLockError(): { success: false; error: string } {
  return { success: false, error: 'This file is being converted to CBZ. Try again once it finishes.' }
}

/**
 * Move a cached thumbnail to the key its new file path hashes to.
 *
 * Must stay in step with `generateThumbnail`/`generateCbzThumbnail` in
 * library-scanner.worker.ts, which name the file after
 * `sha1(filePath).slice(0, 16)`. Returns the new path, or null when there was
 * nothing to move — in which case the caller leaves the column alone and the
 * next scan regenerates.
 */
function renameThumbnailForPath(currentCover: string | null, newFilePath: string): string | null {
  if (!currentCover || !existsSync(currentCover)) return null
  try {
    const hash = createHash('sha1').update(newFilePath).digest('hex').slice(0, 16)
    const dest = join(dirname(currentCover), `${hash}.jpg`)
    if (dest === currentCover) return currentCover
    // A thumbnail already at the destination is equally valid — drop ours.
    if (existsSync(dest)) {
      try { unlinkSync(currentCover) } catch { /* harmless leftover */ }
      return dest
    }
    renameSync(currentCover, dest)
    return dest
  } catch {
    return null
  }
}

/**
 * Build a library thumbnail for a file, using the scanner's conventions.
 *
 * Must match `generateThumbnail`/`generateCbzThumbnail` in
 * library-scanner.worker.ts: same directory, same `sha1(filePath)` key and the
 * same 300x400 JPEG. Matching matters because a later rescan looks for exactly
 * that path — a differently named thumbnail would be regenerated and the old one
 * orphaned.
 *
 * @param sourceImage Image to shrink: a chosen cover, or the first page
 * @param targetFile  The library file the thumbnail belongs to
 * @returns The thumbnail path, or null if one could not be made
 */
async function buildThumbnailFor(
  sourceImage: string,
  targetFile: string
): Promise<string | null> {
  try {
    const sharp = (await import('sharp')).default
    const thumbDir = join(app.getPath('userData'), 'thumbnails')
    mkdirSync(thumbDir, { recursive: true })
    const hash = createHash('sha1').update(targetFile).digest('hex').slice(0, 16)
    const thumbPath = join(thumbDir, `${hash}.jpg`)
    await sharp(sourceImage, { failOn: 'none' })
      .resize(300, 400, { fit: 'inside' })
      .jpeg({ quality: 80 })
      .toFile(thumbPath)
    return thumbPath
  } catch {
    // A missing thumbnail is cosmetic; the entry is still valid without one.
    return null
  }
}

export function registerLibraryIpc(): void {
  ipcMain.handle('library:getAll', async () => {
    try {
      const items = libraryRepo.findAll()
      return { success: true, data: items }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('library:getById', async (_event, id: number) => {
    try {
      const item = libraryRepo.findById(id)
      return { success: true, data: item }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('library:getByGalleryId', async (_event, galleryId: number) => {
    try {
      const item = libraryRepo.findByGalleryId(galleryId)
      return { success: true, data: item }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('library:getPaginated', async (_event, params: {
    offset: number; limit: number; sortField?: string; searchQuery?: string
    artistFilters?: string[]; seriesFilters?: string[]; tagFilters?: string[]
    showUnmatchedOnly?: boolean
  }) => {
    try {
      const result = libraryRepo.findPaginated({
        offset: params.offset,
        limit: params.limit,
        sortField: params.sortField as 'added' | 'title' | 'artist' | undefined,
        searchQuery: params.searchQuery,
        artistFilters: params.artistFilters,
        seriesFilters: params.seriesFilters,
        tagFilters: params.tagFilters,
        showUnmatchedOnly: params.showUnmatchedOnly
      })
      return { success: true, data: result }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('library:search', async (_event, query: string) => {
    try {
      const items = libraryRepo.searchByTitle(query)
      return { success: true, data: items }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('library:getArtists', async (_event, libraryItemId: number) => {
    try {
      const artists = libraryRepo.getArtists(libraryItemId)
      return { success: true, data: artists }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('library:getAllArtistNames', async () => {
    try {
      const names = libraryRepo.getAllArtistNames()
      return { success: true, data: names }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('library:getAllSeriesNames', async () => {
    try {
      const names = libraryRepo.getAllSeriesNames()
      return { success: true, data: names }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('library:getAllTagNames', async () => {
    try {
      const names = libraryRepo.getAllTagNames()
      return { success: true, data: names }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('library:count', async () => {
    try {
      const count = libraryRepo.count()
      return { success: true, data: count }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // ─── Scan (Worker Thread) ──────────────────────────────────────────

  ipcMain.handle('library:scan', async (event, libraryRoot: string) => {
    if (isScanning || scanWorker) {
      return { success: false, error: 'Scan already in progress' }
    }

    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) {
      return { success: false, error: 'No window found' }
    }

    isScanning = true
    const workerPath = pathJoin(__dirname, 'services/library-scanner.worker.js')
    scanWorker = new Worker(workerPath)

    scanWorker.on('message', (msg: { type: string; current?: number; total?: number; status?: string; item?: { id: number; title: string; artist: string }; items?: Array<{ id: number; title: string; artist: string }>; result?: { total: number; newItems: number; removedItems: number; errors: string[]; cancelled: boolean; removalSkippedReason?: string | null }; message?: string }) => {
      switch (msg.type) {
        case 'newItems':
          // Send batched items as a single event to avoid flooding the renderer
          if (msg.items) {
            win.webContents.send('library:newItems', msg.items)
          }
          break
        case 'progress':
          win.webContents.send('library:scanProgress', { current: msg.current, total: msg.total, status: msg.status })
          break
        case 'newItem':
          win.webContents.send('library:newItem', msg.item)
          break
        case 'complete':
          scanWorker = null
          isScanning = false
          win.webContents.send('library:scanComplete', msg.result)
          break
        case 'paused':
          win.webContents.send('library:scanPaused')
          break
        case 'cancelled':
          scanWorker = null
          isScanning = false
          win.webContents.send('library:scanCancelled')
          break
        case 'error':
          win.webContents.send('library:scanError', msg.message)
          break
      }
    })

    scanWorker.on('error', (err) => {
      scanWorker = null
      isScanning = false
      win.webContents.send('library:scanError', err.message)
    })

    scanWorker.on('exit', () => {
      scanWorker = null
      isScanning = false
    })

    scanWorker.postMessage({
      type: 'start',
      libraryRoot,
      // Same persistent cache the download pipeline writes to, so covers
      // survive a reboot instead of living in os.tmpdir().
      thumbnailDir: join(app.getPath('userData'), 'thumbnails')
    })
    return { success: true, data: { scanning: true } }
  })

  ipcMain.handle('library:pauseScan', async () => {
    scanWorker?.postMessage({ type: 'pause' })
    return { success: true }
  })

  ipcMain.handle('library:resumeScan', async () => {
    scanWorker?.postMessage({ type: 'resume' })
    return { success: true }
  })

  ipcMain.handle('library:cancelScan', async () => {
    scanWorker?.postMessage({ type: 'cancel' })
    return { success: true }
  })

  ipcMain.handle('library:reset', async () => {
    try {
      const { getRawDatabase } = await import('../db/connection')
      const rawDb = getRawDatabase()
      rawDb.exec('DELETE FROM library_item_artist')
      rawDb.exec('DELETE FROM library_item')
      rawDb.exec('DELETE FROM library_scan_log')
      // The scan queue is keyed by file path and populated with INSERT OR
      // IGNORE, so leaving it behind meant a reset library rescanned against a
      // stale queue instead of a clean one.
      rawDb.exec('DELETE FROM scan_queue')
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('library:getScanStatus', async () => {
    try {
      const lastLog = libraryRepo.getLastScanLog()
      return { success: true, data: { scanning: isScanning, lastScan: lastLog ?? null } }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // ─── Autocomplete ──────────────────────────────────────────────────

  ipcMain.handle('library:autocompleteArtists', async (_event, query: string) => {
    try {
      const names = libraryRepo.autocompleteArtists(query)
      return { success: true, data: names }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('library:autocompleteSeries', async (_event, query: string) => {
    try {
      const names = libraryRepo.autocompleteSeries(query)
      return { success: true, data: names }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('library:autocompleteTags', async (_event, query: string) => {
    try {
      const names = libraryRepo.autocompleteTags(query)
      return { success: true, data: names }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // ─── Series Assignment ─────────────────────────────────────────────

  /**
   * Assign a series to a batch of items, each with its own volume number.
   *
   * Previously this took a single optional seriesIndex and then ignored it,
   * embedding `item.seriesIndex` (the item's *old* volume) into the PDF while
   * writing the new value to the database. The renderer compensated by calling
   * updateMetadata() for every item afterwards, which meant a second full
   * pikepdf pass per file on every batch assignment.
   */
  ipcMain.handle(
    'library:assignSeries',
    async (
      _event,
      entries: Array<{ id: number; seriesIndex?: number | null }>,
      seriesName: string
    ) => {
      try {
        const errors: string[] = []
        let updated = 0

        for (const entry of entries) {
          const item = libraryRepo.findById(entry.id)
          if (!item) {
            errors.push(`Item ${entry.id} not found`)
            continue
          }
          // Skip rather than fail the whole batch — assigning a series embeds
          // metadata into the file, which a conversion is about to replace.
          if (isConversionLocked(entry.id)) {
            errors.push(`Item ${entry.id} is being converted to CBZ`)
            continue
          }

          // The volume for THIS item, as chosen by the caller. Blank clears it.
          const volume =
            entry.seriesIndex != null && Number.isFinite(Number(entry.seriesIndex))
              ? Number(entry.seriesIndex)
              : null

          try {
            // 1. Embed series + volume using format-aware dispatcher
            try {
              const { applyMetadata } = await import('../services/apply-metadata')
              const format = item.format || 'pdf'
              await applyMetadata(item.filePath, format, {
                title: item.customTitle || `Gallery #${item.galleryId || item.id}`,
                creators: [item.primaryArtist || 'Unknown'],
                tags: item.customTags
                  ? item.customTags.split(',').map((t: string) => t.trim()).filter(Boolean)
                  : [],
                nhentaiId: item.galleryId,
                seriesName,
                seriesIndex: volume ?? undefined,
                language: item.language || item.customLanguage,
                publisher: item.publisher || undefined,
                description: item.description || undefined
              })
            } catch (err) {
              errors.push(`Failed to embed series in ${item.format || 'PDF'} for item ${entry.id}: ${String(err)}`)
              // Continue — the DB update is still valid
            }

            // 2. Move the file into a series subdirectory if it is still in the
            //    artist root. Structure: {libraryRoot}/{artist}/{series?}/{file}
            const currentDir = dirname(item.filePath)
            const fileName = basename(item.filePath)
            const parentDirName = basename(currentDir)

            const dbUpdate: Record<string, unknown> = { seriesName, seriesIndex: volume }

            if (parentDirName === item.primaryArtist || !item.seriesName) {
              const seriesDir = join(currentDir, seriesName)
              if (!existsSync(seriesDir)) {
                mkdirSync(seriesDir, { recursive: true })
              }
              const newPath = join(seriesDir, fileName)
              try {
                renameSync(item.filePath, newPath)
                dbUpdate.filePath = newPath
              } catch (moveErr) {
                errors.push(`Failed to move file for item ${entry.id}: ${String(moveErr)}`)
              }
            }

            libraryRepo.update(entry.id, dbUpdate)
            updated++
          } catch (err) {
            errors.push(`Error processing item ${entry.id}: ${String(err)}`)
          }
        }

        return {
          success: true,
          data: { updated, errors: errors.length > 0 ? errors : undefined }
        }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    }
  )

  // ─── Custom Entry ──────────────────────────────────────────────────

  ipcMain.handle('library:addCustom', async (event, metadata: {
    title: string
    artists: string[]
    series?: string
    tags?: string
    language?: string
    date?: string
    description?: string
    coverPath?: string | null
    sourcePath: string
    sourceType: 'pdf' | 'images'
    /** Output format. Falls back to the same rule downloads use. */
    format?: string
    /**
     * Re-encoding settings. Omitted means "leave the pages alone", which is the
     * right default for a PDF source (already compressed) and the wrong one for
     * a folder of images, where storing verbatim produced a CBZ exactly as large
     * as the folder.
     */
    compression?: {
      enabled: boolean
      /** JPEG quality 1-95. */
      quality: number
      /** Longest-edge cap in px, or null to keep the original size. CBZ only. */
      maxDimension: number | null
      /** PDF only. */
      pageSize?: 'dynamic' | 'fit' | 'letter' | 'a4'
      blackBackground?: boolean
    }
  }, libraryRoot: string) => {
    try {
      const { readdirSync, copyFileSync, mkdirSync, existsSync } = await import('fs')
      const { join } = await import('path')

      const format = resolveOutputFormat(metadata.format, settingsRepo.get('outputFormat'))

      // Re-encoding a folder of pages is slow enough to need feedback: without
      // it the dialog just sat there looking hung.
      const win = BrowserWindow.fromWebContents(event.sender)
      const report = (phase: string, current = 0, total = 0): void => {
        win?.webContents.send('library:addCustomProgress', { phase, current, total })
      }

      const primaryArtist = metadata.artists[0] || 'Unknown'
      const artistDir = join(libraryRoot, primaryArtist)
      if (!existsSync(artistDir)) {
        mkdirSync(artistDir, { recursive: true })
      }

      // Generate safe filename. The [nhentai-00000] prefix marks a custom entry
      // and the scanner relies on that shape, so it stays regardless of format.
      const safeTitle = metadata.title
        .replace(/[/\\?%*:|"<>]/g, '')
        .substring(0, 120)
        .trim()
      const destPath = join(artistDir, `[nhentai-00000] ${safeTitle}.${format}`)

      const tagList = metadata.tags
        ? metadata.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : []

      let finalPath: string
      // Image the thumbnail gets built from: a chosen cover wins, otherwise the
      // first page, captured below while the pages are in hand.
      let thumbSource: string | null = metadata.coverPath || null
      /**
       * Thumbnail written into the library's cache.
       *
       * customCoverPath used to be set to whatever file the user picked, which
       * meant no thumbnail at all unless they picked one, and a broken one if
       * they later moved that file. It now points at a generated thumbnail keyed
       * the way the scanner keys them.
       */
      let generatedThumb: string | null = null

      if (format === 'cbz') {
        // A CBZ carries its metadata inside the archive, so it is written during
        // generation rather than by a second pass over a finished file.
        const { generateCbz } = await import('../services/cbz-generator')
        const { resolveLanguageName } = await import('../services/xml-utils')
        const { rmSync } = await import('fs')

        // No gallery behind a custom entry, so there is no Web URL and no real
        // release date — omitted rather than invented, the same rule the
        // conversion path applies to scanner stubs.
        const ciMeta = {
          title: metadata.title,
          series: metadata.series || metadata.title,
          writers: metadata.artists.length > 0 ? metadata.artists : ['Unknown'],
          genres: [] as string[],
          tags: tagList,
          characters: [] as string[],
          summary: metadata.description || undefined,
          pageCount: 0, // generateCbz overwrites this with the real count
          languageIso: resolveLanguageName([metadata.language]),
          ageRating: 'Adults Only 18+',
          manga: (settingsRepo.get('cbzMangaDirection') || 'YesAndRightToLeft') as
            | 'Yes'
            | 'YesAndRightToLeft'
            | 'No'
        }

        // Scratch only exists for a PDF source, and lives under userData rather
        // than /tmp because extracted pages can run to hundreds of megabytes.
        let scratch: string | null = null
        try {
          let imageFiles: string[]
          if (metadata.sourceType === 'images') {
            imageFiles = readdirSync(metadata.sourcePath)
              .filter((f) => /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(f))
              .sort()
              .map((f) => join(metadata.sourcePath, f))
            if (imageFiles.length === 0) {
              return { success: false, error: 'No image files found in selected folder' }
            }
          } else {
            // Reuses the conversion extractor, so a PDF source gets the same
            // lossless copy, page-count verification and fallback instead of a
            // second implementation that could drift from it.
            const { extractPdfImages } = await import('../services/pdf-extract')
            report('Extracting pages from the PDF')
            scratch = join(app.getPath('userData'), 'add-custom', String(Date.now()))
            mkdirSync(scratch, { recursive: true })
            imageFiles = (await extractPdfImages(metadata.sourcePath, scratch)).imagePaths
          }

          if (!thumbSource && imageFiles.length > 0) thumbSource = imageFiles[0]

          const compress = metadata.compression?.enabled === true
          await generateCbz(
            imageFiles,
            destPath,
            ciMeta,
            {
              quality: compress ? metadata.compression!.quality : null,
              maxDimension: compress ? metadata.compression!.maxDimension : null,
              // Transform scratch under userData, not beside the library file.
              scratchDir: compress
                ? join(app.getPath('userData'), 'add-custom-pages', String(Date.now()))
                : undefined
            },
            (current, total) => report(compress ? 'Compressing pages' : 'Building archive', current, total)
          )
          finalPath = destPath
        } finally {
          if (scratch) {
            try { rmSync(scratch, { recursive: true, force: true }) } catch { /* */ }
          }
        }
      } else {
        const { generatePdf } = await import('../services/pdf-generator')

        if (metadata.sourceType === 'images') {
          const imageFiles = readdirSync(metadata.sourcePath)
            .filter((f) => /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(f))
            .sort()
            .map((f) => join(metadata.sourcePath, f))

          if (imageFiles.length === 0) {
            return { success: false, error: 'No image files found in selected folder' }
          }

          if (!thumbSource && imageFiles.length > 0) thumbSource = imageFiles[0]

          // quality >= 100 makes pdf-generator embed the source bytes untouched,
          // which is what "compression off" has to mean for a PDF.
          const compress = metadata.compression?.enabled === true
          await generatePdf(
            imageFiles,
            destPath,
            {
              pageSize: metadata.compression?.pageSize ?? 'fit',
              quality: compress ? metadata.compression!.quality : 100,
              blackBackground: metadata.compression?.blackBackground ?? false
            },
            (current, total) => report(compress ? 'Compressing pages' : 'Building PDF', current, total)
          )
        } else {
          copyFileSync(metadata.sourcePath, destPath)
        }
        finalPath = destPath

        report('Writing metadata')
        // Embed metadata (offloaded to worker thread)
        await spawnMetadataWorker({
          type: 'apply',
          pdfPath: finalPath,
          metadata: {
            id: 0,
            title: {
              english: metadata.title,
              japanese: null,
              pretty: metadata.title
            },
            tags: [
              ...tagList.map((name) => ({ id: 0, type: 'tag', name })),
              ...metadata.artists.map((name) => ({ id: 0, type: 'artist', name })),
              ...(metadata.language ? [{ id: 0, type: 'language', name: metadata.language }] : [])
            ],
            uploadDate: metadata.date
              ? Math.floor(new Date(metadata.date).getTime() / 1000)
              : Math.floor(Date.now() / 1000),
            numPages: 0,
            seriesName: metadata.series,
            description: metadata.description
          }
        })
      }

      report('Creating the thumbnail')
      // Copying a PDF straight into the library never touches its pages, so
      // there is no first image to hand. Render page one for the thumbnail.
      if (!thumbSource && format === 'pdf') {
        const { execFile } = await import('child_process')
        const { rmSync } = await import('fs')
        const dir = join(app.getPath('userData'), 'thumb-src', String(Date.now()))
        mkdirSync(dir, { recursive: true })
        try {
          await new Promise<void>((resolve, reject) => {
            execFile(
              'pdftoppm',
              ['-f', '1', '-l', '1', '-r', '60', '-jpeg', finalPath, join(dir, 'p')],
              { timeout: 30_000 },
              (err) => (err ? reject(err) : resolve())
            )
          })
          const rendered = readdirSync(dir).find((f) => f.startsWith('p'))
          if (rendered) {
            generatedThumb = await buildThumbnailFor(join(dir, rendered), finalPath)
          }
        } catch {
          // poppler missing or the render failed: no thumbnail, entry still fine.
        } finally {
          try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ }
        }
      } else if (thumbSource) {
        generatedThumb = await buildThumbnailFor(thumbSource, finalPath)
      }

      // Get file size
      const { statSync } = await import('fs')
      const fileSize = statSync(finalPath).size

      // Insert into DB
      const now = Date.now()
      const newId = libraryRepo.insert({
        galleryId: null,
        isCustom: 1,
        customTitle: metadata.title,
        customTags: metadata.tags || null,
        customLanguage: metadata.language || null,
        customDate: metadata.date || null,
        customCoverPath: generatedThumb,
        filePath: finalPath,
        fileSize,
        // Must match what was actually written: a wrong format column sends
        // every later metadata edit to the wrong writer.
        format,
        primaryArtist,
        seriesName: metadata.series || null,
        description: metadata.description || null,
        readProgress: 0,
        addedAt: now,
        updatedAt: now
      })

      // Insert artists
      for (let i = 0; i < metadata.artists.length; i++) {
        libraryRepo.addArtist({
          libraryItemId: newId,
          artistName: metadata.artists[i],
          sortOrder: i
        })
      }

      return { success: true, data: { id: newId, filePath: finalPath, format } }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // ─── File Actions ──────────────────────────────────────────────────

  ipcMain.handle('library:delete', async (_event, id: number) => {
    if (isConversionLocked(id)) return conversionLockError()
    try {
      const item = libraryRepo.findById(id)
      libraryRepo.delete(id)
      // Notify all renderers so search status can update
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        win.webContents.send('library:itemDeleted', { id, galleryId: item?.galleryId ?? null })
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('library:deleteFile', async (_event, id: number) => {
    if (isConversionLocked(id)) return conversionLockError()
    try {
      const { unlinkSync, existsSync } = await import('fs')
      const item = libraryRepo.findById(id)
      if (item && existsSync(item.filePath)) {
        try { unlinkSync(item.filePath) } catch { /* file may be locked */ }
      }
      libraryRepo.delete(id)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('library:getThumbnail', async (_event, id: number) => {
    try {
      const { readFileSync, existsSync } = await import('fs')
      const item = libraryRepo.findById(id)
      if (!item || !item.customCoverPath || !existsSync(item.customCoverPath)) {
        return { success: true, data: null }
      }
      const buffer = readFileSync(item.customCoverPath)
      const base64 = buffer.toString('base64')
      return { success: true, data: `data:image/jpeg;base64,${base64}` }
    } catch {
      return { success: true, data: null }
    }
  })

  ipcMain.handle('library:isPathAccessible', async (_event, dirPath: string) => {
    try {
      const { existsSync } = await import('fs')
      return { success: true, data: existsSync(dirPath) }
    } catch {
      return { success: true, data: false }
    }
  })

  ipcMain.handle('library:updateMetadata', async (_event, id: number, metadata: Record<string, string | number | null>, libraryRoot?: string) => {
    if (isConversionLocked(id)) return conversionLockError()
    try {
      const item = libraryRepo.findById(id)
      if (!item) {
        return { success: false, error: `Library item ${id} not found` }
      }

      // ── Merge metadata for DB update ──────────────────────────────
      // Use 'in' check to distinguish explicit null (clear) from undefined (not provided)
      const newTitle = 'customTitle' in metadata ? (metadata.customTitle as string | null) : item.customTitle
      const newTags = 'customTags' in metadata ? (metadata.customTags as string | null) : item.customTags
      const newLanguage = 'customLanguage' in metadata ? (metadata.customLanguage as string | null) : item.customLanguage
      const newDate = 'customDate' in metadata ? (metadata.customDate as string | null) : item.customDate
      const newSeriesName = 'seriesName' in metadata ? (metadata.seriesName as string | null) : item.seriesName
      const newPrimaryArtist = 'primaryArtist' in metadata ? (metadata.primaryArtist as string | null) : item.primaryArtist
      const newSeriesIndex = 'seriesIndex' in metadata
        ? (metadata.seriesIndex != null ? Number(metadata.seriesIndex) : null)
        : (item.seriesIndex ?? null)
      const newPublisher = 'publisher' in metadata ? (metadata.publisher as string | null) : (item.publisher ?? null)
      const newDescription = 'description' in metadata ? (metadata.description as string | null) : (item.description ?? null)

      // ── Update DB row ─────────────────────────────────────────────
      const dbUpdateData: Record<string, unknown> = {
        customTitle: newTitle,
        customTags: newTags,
        customLanguage: newLanguage,
        customDate: newDate,
        seriesName: newSeriesName,
        primaryArtist: newPrimaryArtist,
        updatedAt: Date.now()
      }
      if ('seriesIndex' in metadata) dbUpdateData.seriesIndex = newSeriesIndex
      if ('publisher' in metadata) dbUpdateData.publisher = newPublisher
      if ('description' in metadata) dbUpdateData.description = newDescription
      libraryRepo.update(id, dbUpdateData)

      // ── Re-embed metadata into file ──────────────────────────────
      // Route by format: pikepdf for PDF, ComicInfo rewrite for CBZ
      try {
        const { applyMetadata } = await import('../services/apply-metadata')
        const tagList: Array<{ id: number; type: string; name: string }> = []
        if (newTags) {
          newTags.split(',').forEach((t: string) => {
            const trimmed = t.trim()
            if (trimmed) tagList.push({ id: 0, type: 'tag', name: trimmed })
          })
        }
        if (newPrimaryArtist) {
          tagList.push({ id: 0, type: 'artist', name: newPrimaryArtist })
        }

        const format = item.format || 'pdf'
        await applyMetadata(item.filePath, format, {
          title: newTitle || `Gallery #${item.galleryId || item.id}`,
          creators: newPrimaryArtist ? [newPrimaryArtist] : [item.primaryArtist || 'Unknown'],
          tags: tagList.map((t: { name: string }) => t.name),
          nhentaiId: item.galleryId ?? undefined,
          seriesName: newSeriesName ?? item.seriesName ?? undefined,
          seriesIndex: newSeriesIndex ?? item.seriesIndex ?? undefined,
          language: newLanguage || item.language || undefined,
          publisher: newPublisher || item.publisher || undefined,
          description: newDescription || item.description || undefined,
          date: newDate || undefined
        })
      } catch (embedErr) {
        // Non-fatal: metadata embedding failure shouldn't block the update
        console.error('Failed to re-embed metadata:', embedErr)
      }

      // ── Determine library root ────────────────────────────────────
      let root = libraryRoot
      if (!root) {
        // Derive root from file path: {root}/{artist}/{series?}/file.pdf
        const { dirname, basename: pathBasename } = await import('path')
        const parentDir = dirname(item.filePath)
        const grandparentDir = dirname(parentDir)
        // If parent dir matches primary artist, file is directly in artist dir
        if (pathBasename(parentDir) === item.primaryArtist) {
          root = grandparentDir
        } else {
          // File is in series subdirectory: root is 3 levels up
          root = dirname(grandparentDir)
        }
      }

      // ── Compute new file path if artist or series changed ─────────
      const oldArtist = item.primaryArtist
      const oldSeries = item.seriesName
      const artistChanged = newPrimaryArtist && newPrimaryArtist !== oldArtist
      const seriesChanged = (newSeriesName ?? null) !== (oldSeries ?? null)

      let newPath: string | null = null

      if (artistChanged || seriesChanged) {
        const { join, dirname: pathDirname, basename: pathBasename } = await import('path')
        const { existsSync: pathExistsSync, mkdirSync: pathMkdirSync, renameSync: pathRenameSync, rmdirSync: pathRmdirSync } = await import('fs')

        const fileName = pathBasename(item.filePath)
        const targetArtistDir = join(root!, newPrimaryArtist!)

        let targetDir: string
        if (newSeriesName) {
          targetDir = join(targetArtistDir, newSeriesName)
        } else {
          targetDir = targetArtistDir
        }

        // Create target directories
        if (!pathExistsSync(targetArtistDir)) {
          pathMkdirSync(targetArtistDir, { recursive: true })
        }
        if (newSeriesName && !pathExistsSync(targetDir)) {
          pathMkdirSync(targetDir, { recursive: true })
        }

        newPath = join(targetDir, fileName)

        // Move file (skip if source == dest)
        if (item.filePath !== newPath) {
          try {
            pathRenameSync(item.filePath, newPath)
          } catch {
            // Cross-device fallback
            const { copyFileSync, unlinkSync } = await import('fs')
            try {
              copyFileSync(item.filePath, newPath)
              try { unlinkSync(item.filePath) } catch { /* */ }
            } catch (moveErr) {
              console.error('Failed to move file:', moveErr)
              newPath = null // Don't update DB path if move failed
            }
          }

          // Try to clean up empty source directory
          if (newPath) {
            try {
              const oldParentDir = pathDirname(item.filePath)
              const { readdirSync } = await import('fs')
              const remaining = readdirSync(oldParentDir)
              if (remaining.length === 0) {
                pathRmdirSync(oldParentDir)
              }
            } catch { /* cleanup is best-effort */ }
          }
        }

        // Update file_path in DB
        if (newPath && newPath !== item.filePath) {
          libraryRepo.update(id, { filePath: newPath } as Record<string, unknown>)
        }
      }

      return { success: true, data: { newPath: newPath ?? item.filePath } }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // ─── Batch Metadata Conversion ───────────────────────────────────────

  let conversionCancelled = false

  ipcMain.handle('library:convertAllMetadata', async (event, runners: number = 3) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false, error: 'No window found' }

    conversionCancelled = false
    const items = libraryRepo.findAll()
    const total = items.length
    let queueIndex = 0
    let converted = 0
    let failed = 0
    const errors: string[] = []
    const logLines: string[] = []
    const concurrency = Math.max(1, Math.min(runners, 20))

    // Set up file logging (same location as scanner logs)
    const LOG_DIR = join(homedir(), '.config', 'doujin-downloader', 'logs')
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
    const logTimestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const logPath = join(LOG_DIR, `convert-${logTimestamp}.log`)
    writeFileSync(logPath, `Conversion started at ${new Date().toISOString()}\n${'='.repeat(60)}\n`)
    writeFileSync(logPath, `Total items: ${total}\n`, { flag: 'a' })
    writeFileSync(logPath, `Runners: ${concurrency}\n`, { flag: 'a' })
    
    function writeLog(line: string) {
      try { appendFileSync(logPath, line + '\n') } catch { /* best effort */ }
    }

    function sendProgress() {
      win!.webContents.send('library:convertProgress', {
        current: converted + failed,
        total,
        converted,
        failed,
        logLines: logLines.splice(0, logLines.length) // send and clear
      })
    }

    function buildMetadata(item: ReturnType<typeof libraryRepo.findById>): Record<string, unknown> {
      if (!item) return {}
      const tags = item.customTags
        ? item.customTags.split(',').map((t: string) => t.trim()).filter(Boolean)
        : []
      return {
        title: item.customTitle || `Gallery #${item.galleryId || item.id}`,
        creators: [item.primaryArtist || 'Unknown'],
        tags,
        nhentaiId: item.galleryId,
        seriesName: item.seriesName,
        seriesIndex: item.seriesIndex,
        language: item.language || item.customLanguage,
        publisher: item.publisher,
        description: item.description
      }
    }

    function spawnWorker(): Promise<void> {
      return new Promise((resolve) => {
        const workerPath = pathJoin(__dirname, 'services/convert.worker.js')
        const worker = new Worker(workerPath)
        let currentItem: ReturnType<typeof libraryRepo.findById> | null = null
        // Set once we deliberately stop this runner. worker.terminate() exits
        // with code 1, which the exit handler would otherwise count as a
        // failure — one phantom failure per runner on every clean run.
        let stopping = false

        const stop = (): void => {
          if (stopping) return
          stopping = true
          worker.terminate().then(() => resolve()).catch(() => resolve())
        }

        const processNext = (): void => {
          if (conversionCancelled || queueIndex >= total) {
            stop()
            return
          }
          currentItem = items[queueIndex++]
          // Defensive: a hole in the array used to leave the runner pending
          // forever, hanging Promise.all and the whole conversion.
          if (!currentItem) {
            stop()
            return
          }
          worker.postMessage({
            type: 'convert',
            item: {
              id: currentItem.id,
              filePath: currentItem.filePath,
              // Without this the worker assumed PDF and handed every CBZ to
              // pikepdf, failing on each one.
              format: currentItem.format || 'pdf',
              metadata: buildMetadata(currentItem)
            }
          })
        }

        worker.on('message', (msg: { type: string; itemId?: number; success?: boolean; newPath?: string; error?: string; log?: string }) => {
          if (msg.type === 'done') {
            if (!conversionCancelled && msg.success) {
              converted++
              if (msg.newPath && currentItem && msg.newPath !== currentItem.filePath) {
                try { libraryRepo.update(currentItem.id, { filePath: msg.newPath } as Record<string, unknown>) } catch { /* */ }
              }
            } else {
              failed++
              if (msg.error) errors.push(msg.error)
            }
            if (msg.log) {
              logLines.push(msg.log)
              writeLog(msg.log)
            }

            sendProgress()
            processNext()
          }
        })

        worker.on('error', (err) => {
          if (!stopping) {
            failed++
            errors.push(String(err))
            sendProgress()
          }
          // The worker is unusable after an uncaught error — retire this runner
          // rather than posting more work into a dead thread.
          stop()
        })
        worker.on('exit', (code) => {
          // Only a code we did not ask for counts as a real failure.
          if (!stopping && code !== 0 && currentItem) { failed++; sendProgress() }
          stopping = true
          resolve()
        })

        processNext()
      })
    }

    try {
      // Start N parallel workers
      const workers = Array.from({ length: concurrency }, () => spawnWorker())
      await Promise.all(workers)

      // Final progress
      sendProgress()
      const status = conversionCancelled ? 'CANCELLED' : 'COMPLETE'
      writeLog(`${'='.repeat(60)}\n${status}: ${converted} converted, ${failed} failed, ${total} total`)

      return {
        success: true,
        data: { converted, failed, total, cancelled: conversionCancelled, errors: errors.length > 0 ? errors.slice(0, 20) : undefined }
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('library:cancelConversion', async () => {
    conversionCancelled = true
    return { success: true }
  })

  // ─── Nhentai Sync ────────────────────────────────────────────────────

  const syncingItems = new Set<number>()

  function spawnSyncWorker(itemId: number, nhentaiId: number, filePath: string, format?: string): Promise<{ success: boolean; message?: string }> {
    return new Promise((resolve) => {
      const workerPath = pathJoin(__dirname, 'services/sync.worker.js')
      const worker = new Worker(workerPath)

      // Get the decrypted API key so sync runs at authenticated rate limits.
      // (Previously this used a runtime require() for a function that was
      // never exported, so sync was always anonymous.)
      const apiKey = getStoredApiKey()

      worker.on('message', (msg: { type: string; itemId: number; success?: boolean; message?: string; metadata?: { title: string; primaryArtist: string; tags: string; language: string | null; publisher: string | null } }) => {
        if (msg.type === 'complete') {
          const now = Date.now()
          try {
            const updateData: Record<string, unknown> = { synced: 1, syncedAt: now }
            if (msg.metadata) {
              updateData.customTitle = msg.metadata.title
              updateData.primaryArtist = msg.metadata.primaryArtist
              updateData.customTags = msg.metadata.tags
              updateData.customLanguage = msg.metadata.language
              if (msg.metadata.publisher) updateData.publisher = msg.metadata.publisher
            }
            libraryRepo.update(msg.itemId, updateData)
          } catch { /* */ }
          syncingItems.delete(msg.itemId)
          resolve({ success: true })
        } else if (msg.type === 'error') {
          syncingItems.delete(msg.itemId)
          resolve({ success: false, message: msg.message })
        }
        worker.terminate()
      })

      worker.on('error', () => {
        syncingItems.delete(itemId)
        resolve({ success: false, message: 'Worker error' })
      })

      worker.postMessage({ type: 'sync', itemId, nhentaiId, filePath, apiKey, format })
    })
  }

  ipcMain.handle('library:syncItem', async (_event, itemId: number) => {
    if (isConversionLocked(itemId)) return conversionLockError()
    if (syncingItems.has(itemId)) return { success: false, error: 'Already syncing' }

    const item = libraryRepo.findById(itemId)
    if (!item || !item.galleryId) return { success: false, error: 'No nhentai ID' }

    syncingItems.add(itemId)
    const result = await spawnSyncWorker(itemId, item.galleryId, item.filePath, item.format || 'pdf')

    if (result.success) {
      return { success: true, data: { synced: true } }
    }
    return { success: false, error: result.message }
  })

  ipcMain.handle('library:syncBatch', async (event, ids: number[]) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    let succeeded = 0
    let failed = 0
    const total = ids.length
    const startTime = Date.now()

    if (win) {
      win.webContents.send('library:syncProgress', { current: 0, total, title: 'Starting...', etaSeconds: null })
    }

    for (let i = 0; i < ids.length; i++) {
      const item = libraryRepo.findById(ids[i])
      if (!item || !item.galleryId || syncingItems.has(ids[i]) || isConversionLocked(ids[i])) {
        failed++
        continue
      }

      syncingItems.add(ids[i])
      const result = await spawnSyncWorker(ids[i], item.galleryId, item.filePath, item.format || 'pdf')

      if (result.success) succeeded++
      else failed++

      // Send progress to renderer
      if (win) {
        const elapsed = (Date.now() - startTime) / 1000
        const rate = (i + 1) / Math.max(elapsed, 1)
        const eta = rate > 0 ? Math.round((total - i - 1) / rate) : null
        win.webContents.send('library:syncProgress', {
          current: i + 1,
          total,
          title: `Syncing #${item?.galleryId || '?'}`,
          etaSeconds: eta
        })
      }

      // 3-second delay between syncs
      if (i < ids.length - 1) {
        await new Promise((r) => setTimeout(r, 3000))
      }
    }

    // Send completion
    if (win) {
      win.webContents.send('library:syncComplete', { succeeded, failed, total })
    }

    // Send notification
    if (win) {
      try {
        const { Notification } = require('electron')
        new Notification({
          title: 'Nhentai Sync Complete',
          body: `${succeeded} succeeded, ${failed} failed (${ids.length} total)`
        }).show()
      } catch { /* notification is best-effort */ }
    }

    return { success: true, data: { succeeded, failed, total: ids.length } }
  })

  ipcMain.handle('library:isSyncing', async (_event, itemId: number) => {
    return { success: true, data: syncingItems.has(itemId) }
  })

  // ─── File Read ─────────────────────────────────────────────────────────

  /**
   * Small preview of what a custom entry's first page will look like.
   *
   * Lets the add-entry form show a cover without the user having to pick one:
   * for a folder that is the first image, for a PDF it is page one rendered with
   * poppler. Returns a base64 JPEG, or a failure the form can quietly ignore —
   * a missing preview should never block adding an entry.
   */
  ipcMain.handle(
    'library:previewSource',
    async (_event, sourcePath: string, sourceType: 'pdf' | 'images') => {
      try {
        const sharp = (await import('sharp')).default
        const toThumb = async (input: string | Buffer): Promise<string> =>
          (
            await sharp(input, { failOn: 'none' })
              .resize(360, 480, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 78 })
              .toBuffer()
          ).toString('base64')

        if (sourceType === 'images') {
          const first = readdirSync(sourcePath)
            .filter((f) => /\.(jpg|jpeg|png|webp|gif|bmp|avif)$/i.test(f))
            .sort()[0]
          if (!first) return { success: false, error: 'No images in folder' }
          return { success: true, data: await toThumb(join(sourcePath, first)) }
        }

        // Render page 1 only. Scratch under userData, cleaned up either way.
        const { execFile } = await import('child_process')
        const { rmSync } = await import('fs')
        const dir = join(app.getPath('userData'), 'preview', String(Date.now()))
        mkdirSync(dir, { recursive: true })
        try {
          await new Promise<void>((resolve, reject) => {
            execFile(
              'pdftoppm',
              ['-f', '1', '-l', '1', '-r', '50', '-jpeg', sourcePath, join(dir, 'p')],
              { timeout: 20_000 },
              (err) => (err ? reject(err) : resolve())
            )
          })
          const rendered = readdirSync(dir).find((f) => f.startsWith('p'))
          if (!rendered) return { success: false, error: 'Could not render the first page' }
          return { success: true, data: await toThumb(join(dir, rendered)) }
        } finally {
          try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ }
        }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    }
  )

  ipcMain.handle('file:read', async (_event, filePath: string) => {
    try {
      const buffer = readFileSync(filePath)
      return { success: true, data: buffer.toString('base64') }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // ─── CBZ: Read a single page image ─────────────────────────────────────

  ipcMain.handle('cbz:readPage', async (_event, filePath: string, pageIndex: number) => {
    try {
      const { open } = await import('yauzl')
      const buffer = await new Promise<Buffer | null>((resolve, reject) => {
        open(filePath, { lazyEntries: true }, (err, zipfile) => {
          if (err) return reject(err)
          if (!zipfile) return reject(new Error('Failed to open zip'))

          const entries: Array<{ name: string; offset: number; compSize: number; compression: number }> = []
          zipfile.readEntry()

          zipfile.on('entry', (entry) => {
            entries.push({
              name: entry.fileName,
              offset: (entry as any).relativeOffsetOfLocalHeader,
              compSize: entry.compressedSize,
              compression: entry.compressionMethod
            })
            zipfile.readEntry()
          })

          zipfile.on('end', () => {
            // Sort by filename and filter images
            const images = entries
              .filter((e) => !e.name.endsWith('/') && !e.name.endsWith('ComicInfo.xml') && /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(e.name))
              .sort((a, b) => a.name.localeCompare(b.name))

            if (pageIndex < 0 || pageIndex >= images.length) {
              resolve(null)
              return
            }

            const target = images[pageIndex]
            // Re-open to get the entry data
            open(filePath, { lazyEntries: true }, (err2, zipfile2) => {
              if (err2) return reject(err2)
              if (!zipfile2) return reject(new Error('Failed to open zip'))

              zipfile2.readEntry()
              zipfile2.on('entry', (entry2) => {
                if (entry2.fileName === target.name) {
                  const chunks: Buffer[] = []
                  zipfile2.openReadStream(entry2, (openErr, readStream) => {
                    if (openErr) return reject(openErr)
                    if (!readStream) return reject(new Error('No read stream'))
                    readStream.on('data', (chunk: Buffer) => chunks.push(chunk))
                    readStream.on('end', () => resolve(Buffer.concat(chunks)))
                    readStream.on('error', reject)
                  })
                } else {
                  zipfile2.readEntry()
                }
              })
              zipfile2.on('end', () => resolve(null))
              zipfile2.on('error', reject)
            })
          })

          zipfile.on('error', reject)
        })
      })

      if (!buffer) {
        return { success: false, error: 'Page not found' }
      }

      return { success: true, data: buffer.toString('base64') }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('cbz:getPageCount', async (_event, filePath: string) => {
    try {
      const { open } = await import('yauzl')

      const count = await new Promise<number>((resolve, reject) => {
        open(filePath, { lazyEntries: true }, (err, zipfile) => {
          if (err) return reject(err)
          if (!zipfile) return reject(new Error('Failed to open zip'))

          let imageCount = 0
          zipfile.readEntry()

          zipfile.on('entry', (entry) => {
            if (!entry.fileName.endsWith('/') && !entry.fileName.endsWith('ComicInfo.xml') && /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(entry.fileName)) {
              imageCount++
            }
            zipfile.readEntry()
          })

          zipfile.on('end', () => resolve(imageCount))
          zipfile.on('error', reject)
        })
      })

      return { success: true, data: count }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // ─── Convert to CBZ ────────────────────────────────────────────────────────

  let cbzConversionCancelled = false

  ipcMain.handle('library:convertToCbz', async (
    event,
    ids: number[],
    dryRun: boolean = false,
    options?: { keepOriginal?: boolean; resume?: boolean }
  ) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false, error: 'No window found' }

    cbzConversionCancelled = false
    const runners = Number(settingsRepo.get('downloadConcurrency') || '3')
    const concurrency = Math.max(1, Math.min(runners, 8))
    const libraryRoot = settingsRepo.get('libraryPath') || ''
    // A per-run choice wins over the stored default, so the user can keep
    // originals as a rule and still delete them for one batch (or vice versa)
    // without editing settings first.
    const keepOriginal =
      typeof options?.keepOriginal === 'boolean'
        ? options.keepOriginal
        : settingsRepo.get('cbzKeepOriginal') !== 'false'
    // The worker joins libraryRoot into '_originals/{artist}/' when preserving
    // originals. An empty or missing root makes that a *relative* path, which
    // would move the user's only copy of each PDF somewhere under the process
    // working directory. Refuse the batch instead.
    if (keepOriginal && (!libraryRoot || !existsSync(libraryRoot))) {
      return {
        success: false,
        error:
          'Library path is not set or does not exist. Set it in Settings before ' +
          'converting, or disable "keep original".'
      }
    }
    const mangaDirection = (settingsRepo.get('cbzMangaDirection') || 'YesAndRightToLeft') as 'Yes' | 'YesAndRightToLeft' | 'No'
    const parodyAsCollection = settingsRepo.get('cbzParodyAsCollection') === 'true'

    if (dryRun) {
      const items = ids.map((id) => {
        const item = libraryRepo.findById(id)
        return item ? { id: item.id, title: item.customTitle, format: item.format } : null
      }).filter(Boolean)
      return { success: true, data: { dryRun: true, items, count: items.length } }
    }

    // Only PDFs are convertible. Filtering here rather than failing per item
    // keeps the reported total honest: a mixed selection should show progress
    // out of the number actually being worked on.
    const targets = ids
      .map((id) => libraryRepo.findById(id))
      .filter((item): item is NonNullable<typeof item> => !!item && (item.format || 'pdf') === 'pdf')
    const skipped = ids.length - targets.length

    // `resume: true` continues whatever is already pending instead of enqueuing.
    // Anything left over from an interrupted run is still in the table, and
    // startup-maintenance has already put mid-crash 'converting' rows back to
    // 'pending', so there is nothing to rebuild.
    const resume = options?.resume === true
    if (!resume) {
      if (targets.length === 0) {
        return { success: true, data: { converted: 0, failed: 0, total: 0, skipped, cancelled: false } }
      }
      // Finished rows from earlier batches are history, not work.
      conversionRepo.clearFinished()
      conversionRepo.enqueue(
        targets.map((item) => ({
          libraryItemId: item.id,
          filePath: item.filePath,
          keepOriginal
        }))
      )
    }

    // The queue, not the caller's array, decides how much work there is: on a
    // resume the batch is whatever survived.
    const batchTotal = conversionRepo.counts().pending
    if (batchTotal === 0) {
      return { success: true, data: { converted: 0, failed: 0, total: 0, skipped, cancelled: false } }
    }

    // Claim every queued item up front so the edit guard covers rows that are
    // still waiting for a runner, not just the handful inside workers.
    for (const id of conversionRepo.pendingItemIds()) cbzQueued.add(id)

    let converted = 0
    let failed = 0
    // Items whose original had to be kept despite keepOriginal=false, because
    // the lossy fallback ran. Reported back so the UI can say so explicitly
    // rather than leaving the user to wonder why some PDFs survived.
    let forcedKeeps = 0
    const errors: string[] = []
    const logLines: string[] = []

    function sendProgress(running = true): void {
      win!.webContents.send('library:convertToCbzProgress', {
        current: converted + failed,
        total: batchTotal,
        converted,
        failed,
        skipped,
        running,
        // Per-item state, so the library can mark individual cards busy and
        // refuse editing on exactly the right rows.
        activeIds: [...cbzConverting],
        queuedIds: [...cbzQueued],
        logLines: logLines.splice(0, logLines.length)
      })
    }

    function spawnWorker(): Promise<void> {
      return new Promise((resolve) => {
        const workerPath = pathJoin(__dirname, 'services/convert-cbz.worker.js')
        const worker = new Worker(workerPath)
        let currentId: number | null = null
        /** conversion_queue row id for the item in flight, so it can be settled. */
        let currentRowId: number | null = null
        // Captured when the item is dispatched: the message handler needs it to
        // re-key the thumbnail, and the row is re-read there anyway.
        let currentCover: string | null = null
        let stopping = false

        const stop = (): void => {
          if (stopping) return
          stopping = true
          worker.terminate().then(() => resolve()).catch(() => resolve())
        }

        const processNext = (): void => {
          if (cbzConversionCancelled) {
            stop()
            return
          }
          // Claiming is a single atomic statement, so runners never collide on a
          // row and there is no shared index to keep in step.
          const claim = conversionRepo.claimNext()
          if (!claim) {
            stop()
            return
          }
          currentId = claim.libraryItemId
          currentRowId = claim.id

          const item = currentId ? libraryRepo.findById(currentId) : null
          if (!item || item.format !== 'pdf') {
            // Already converted, or the row vanished. Not a failure worth
            // reporting to the user, but the queue row has to be settled or a
            // resume would retry it forever.
            conversionRepo.markCompleted(claim.id)
            if (currentId) cbzQueued.delete(currentId)
            sendProgress()
            processNext()
            return
          }

          // Hand off from queued to active — the item is now being written to.
          cbzQueued.delete(currentId)
          cbzConverting.add(currentId)
          currentCover = item.customCoverPath ?? null
          sendProgress()

          // Read real gallery row for typed tags (only 41 rows have them, but those 41 matter)
          let uploadDate: number | null = null
          let rawTagsJson: string | null = null
          if (item.galleryId) {
            const gallery = galleryRepo.findById(item.galleryId)
            if (gallery) {
              uploadDate = gallery.uploadDate ?? null
              rawTagsJson = gallery.rawTagsJson ?? null
            }
          }

          worker.postMessage({
            type: 'convert',
            item: {
              id: item.id,
              filePath: item.filePath,
              metadata: {
                customTitle: item.customTitle,
                primaryArtist: item.primaryArtist,
                seriesName: item.seriesName,
                seriesIndex: item.seriesIndex,
                customTags: item.customTags,
                customLanguage: item.customLanguage || item.language,
                publisher: item.publisher,
                description: item.description,
                galleryId: item.galleryId,
                uploadDate,
                rawTagsJson
              },
              options: {
                // Per-row rather than per-batch: a resumed run must honour the
                // choice the user made when they started it, not whatever the
                // setting happens to say now.
                keepOriginal: claim.keepOriginal,
                libraryRoot,
                userDataDir: app.getPath('userData'),
                mangaDirection,
                parodyAsCollection
              }
            }
          })
        }

        worker.on('message', (msg: {
          type: string
          itemId?: number
          success?: boolean
          newPath?: string
          fileSize?: number
          // Real mtime of the written CBZ. Declared here rather than cast at the
          // use site: the scanner compares this against the file on disk to
          // decide whether to re-extract, so a wrong value costs a full rescan
          // of every converted item.
          fileMtime?: number
          error?: string
          log?: string
          lossless?: boolean
          originalKept?: boolean
          forcedKeep?: boolean
        }) => {
          if (msg.type === 'done') {
            if (!cbzConversionCancelled && msg.success && msg.newPath && currentId) {
              converted++
              if (msg.forcedKeep) forcedKeeps++
              // Thumbnails are content-addressed by SHA-1 of the file path
              // (library-scanner.worker.ts), so renaming .pdf to .cbz orphans
              // the cached cover: the DB keeps working, but the next rescan
              // computes the new hash, finds nothing and regenerates. Move it
              // to the new key so that work — and the stale file — never happen.
              const movedCover = renameThumbnailForPath(currentCover, msg.newPath)
              try {
                libraryRepo.update(currentId, {
                  filePath: msg.newPath,
                  format: 'cbz',
                  fileSize: msg.fileSize ?? 0,
                  fileMtime: msg.fileMtime ?? Date.now(),
                  ...(movedCover ? { customCoverPath: movedCover } : {}),
                  updatedAt: Date.now()
                })
              } catch { /* */ }
              // Settle the queue row only after the library row is updated, so a
              // crash between the two leaves the item pending and it converts
              // again rather than being silently skipped.
              if (currentRowId) conversionRepo.markCompleted(currentRowId)
            } else if (cbzConversionCancelled) {
              // Not a failure: put it back so a resume picks it up.
              if (currentRowId) conversionRepo.release(currentRowId)
            } else {
              failed++
              if (msg.error) errors.push(msg.error)
              if (currentRowId) conversionRepo.markFailed(currentRowId, msg.error || 'unknown error')
            }
            if (msg.log) {
              logLines.push(msg.log)
            }
            // Release the lock only after the row has been updated, so an edit
            // arriving the instant the bar ticks cannot see the stale path.
            if (currentId) cbzConverting.delete(currentId)
            sendProgress()
            processNext()
          }
        })

        worker.on('error', (err) => {
          if (!stopping) {
            failed++
            errors.push(String(err))
            // The item in flight died with the runner. Mark it failed rather
            // than leaving the row 'converting' forever: startup-maintenance
            // would eventually reset it, but only after a restart.
            if (currentRowId) conversionRepo.markFailed(currentRowId, String(err))
            if (currentId) { cbzConverting.delete(currentId); cbzQueued.delete(currentId) }
            sendProgress()
          }
          stop()
        })
        worker.on('exit', (code) => {
          if (!stopping && code !== 0 && currentId) {
            failed++
            if (currentRowId) conversionRepo.markFailed(currentRowId, `worker exited with code ${code}`)
            cbzConverting.delete(currentId)
            cbzQueued.delete(currentId)
            sendProgress()
          }
          stopping = true
          resolve()
        })

        processNext()
      })
    }

    try {
      const workers = Array.from({ length: concurrency }, () => spawnWorker())
      await Promise.all(workers)
      // Clear anything left claimed — a cancel or a dead runner leaves items in
      // the queued set, and a stale entry would lock those rows for the rest of
      // the session. Cleared wholesale rather than per-target because a resume
      // works on rows this call never saw.
      cbzQueued.clear()
      cbzConverting.clear()
      sendProgress(false)

      return {
        success: true,
        data: {
          converted,
          failed,
          total: batchTotal,
          skipped,
          keptOriginals: keepOriginal,
          forcedKeeps,
          cancelled: cbzConversionCancelled,
          errors: errors.length > 0 ? errors.slice(0, 20) : undefined
        }
      }
    } catch (error) {
      // Never leave rows claimed on an unexpected throw — a stale lock would
      // make those items permanently uneditable until the app restarts. Queue
      // rows are deliberately left alone: whatever is still pending stays
      // pending and can be resumed.
      cbzQueued.clear()
      cbzConverting.clear()
      sendProgress(false)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('library:cancelConvertToCbz', async () => {
    cbzConversionCancelled = true
    return { success: true }
  })

  /**
   * Outstanding conversion work, so an interrupted batch can be offered back.
   *
   * Quitting mid-conversion leaves rows pending; startup-maintenance resets any
   * that were mid-flight. Without this the queue survived but nothing ever asked
   * about it, which is why converting a large library had no working resume.
   */
  ipcMain.handle('library:getConversionQueue', async () => {
    try {
      const counts = conversionRepo.counts()
      return {
        success: true,
        data: {
          ...counts,
          // 'converting' only appears here if a batch is running right now:
          // crashed rows were already reset to pending at startup.
          outstanding: counts.pending + counts.converting,
          errors: counts.failed > 0 ? conversionRepo.recentErrors(5) : []
        }
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  /** Forget a leftover queue, when the user would rather not resume it. */
  ipcMain.handle('library:clearConversionQueue', async () => {
    try {
      const cleared = getSqlite().prepare('DELETE FROM conversion_queue').run().changes
      cbzQueued.clear()
      cbzConverting.clear()
      return { success: true, data: { cleared } }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  /**
   * Walk `_originals`, separating the freely-deletable archive from `_lossy`.
   *
   * Returns counts and byte totals so the UI can state exactly what a purge
   * would remove before the user agrees to it.
   */
  function scanOriginals(root: string): {
    files: string[]
    bytes: number
    lossyFiles: string[]
    lossyBytes: number
  } {
    const files: string[] = []
    const lossyFiles: string[] = []
    let bytes = 0
    let lossyBytes = 0

    const walk = (dir: string, inLossy: boolean): void => {
      let entries: import('fs').Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full, inLossy || entry.name === '_lossy')
        } else if (entry.isFile()) {
          let size = 0
          try { size = statSync(full).size } catch { /* counted as 0 */ }
          if (inLossy) { lossyFiles.push(full); lossyBytes += size }
          else { files.push(full); bytes += size }
        }
      }
    }

    walk(join(root, '_originals'), false)
    return { files, bytes, lossyFiles, lossyBytes }
  }

  ipcMain.handle('library:getOriginalsInfo', async () => {
    try {
      const root = settingsRepo.get('libraryPath') || ''
      if (!root || !existsSync(join(root, '_originals'))) {
        return { success: true, data: { count: 0, bytes: 0, lossyCount: 0, lossyBytes: 0 } }
      }
      const s = scanOriginals(root)
      return {
        success: true,
        data: {
          count: s.files.length,
          bytes: s.bytes,
          lossyCount: s.lossyFiles.length,
          lossyBytes: s.lossyBytes
        }
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  /**
   * Delete archived original PDFs.
   *
   * Irreversible, so it is never implicit: `includeLossy` must be passed
   * explicitly to touch the `_lossy` subtree, whose files are the only
   * full-quality copies of pages that went through the re-rasterising fallback.
   */
  ipcMain.handle('library:purgeOriginals', async (_event, includeLossy: boolean = false) => {
    try {
      const root = settingsRepo.get('libraryPath') || ''
      if (!root || !existsSync(join(root, '_originals'))) {
        return { success: true, data: { deleted: 0, bytes: 0, failed: 0 } }
      }

      const { unlinkSync, rmdirSync } = await import('fs')
      const s = scanOriginals(root)
      const doomed = includeLossy ? [...s.files, ...s.lossyFiles] : s.files
      const bytes = includeLossy ? s.bytes + s.lossyBytes : s.bytes

      let deleted = 0
      let failed = 0
      for (const f of doomed) {
        try { unlinkSync(f); deleted++ } catch { failed++ }
      }

      // Deleting the files left the whole artist directory tree behind, since
      // only the include-lossy branch removed anything. Prune what is now empty
      // instead: recursion first, so a directory whose children all disappear is
      // itself considered empty on the way back up. Anything still holding a
      // spared _lossy file, or a file we failed to delete, survives because it is
      // not empty — no special-casing needed.
      const originalsRoot = join(root, '_originals')
      let removedDirs = 0
      const pruneEmpty = (dir: string): boolean => {
        let entries: import('fs').Dirent[]
        try {
          entries = readdirSync(dir, { withFileTypes: true })
        } catch {
          return false
        }
        let remaining = 0
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (!pruneEmpty(join(dir, entry.name))) remaining++
          } else {
            remaining++
          }
        }
        if (remaining > 0) return false
        try {
          // rmdirSync, not rmSync: rmSync without `recursive: true` throws
          // ERR_FS_EISDIR on a directory, and the catch here would have
          // swallowed it, leaving every folder in place with no error reported.
          rmdirSync(dir)
          removedDirs++
          return true
        } catch {
          return false
        }
      }
      pruneEmpty(originalsRoot)

      return { success: true, data: { deleted, bytes, failed, removedDirs } }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  /**
   * Current conversion state, for a renderer that mounted mid-run.
   *
   * Progress arrives as events, so a page that opens after a batch started
   * would otherwise show nothing busy and offer an Edit button the main process
   * will refuse.
   */
  ipcMain.handle('library:getCbzConversionState', async () => {
    return {
      success: true,
      data: {
        running: cbzConverting.size > 0 || cbzQueued.size > 0,
        activeIds: [...cbzConverting],
        queuedIds: [...cbzQueued]
      }
    }
  })
}
