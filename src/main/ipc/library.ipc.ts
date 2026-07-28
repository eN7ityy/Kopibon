import { ipcMain, BrowserWindow } from 'electron'
import { Worker } from 'worker_threads'
import { join as pathJoin } from 'path'
import { libraryRepo } from '../db/repositories/library.repo'
import { settingsRepo } from '../db/repositories/settings.repo'
import { renameSync, mkdirSync, existsSync, appendFileSync, writeFileSync } from 'fs'
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

    scanWorker.on('message', (msg: { type: string; current?: number; total?: number; status?: string; item?: { id: number; title: string; artist: string }; items?: Array<{ id: number; title: string; artist: string }>; result?: { total: number; newItems: number; removedItems: number; errors: string[]; cancelled: boolean }; message?: string }) => {
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

    scanWorker.postMessage({ type: 'start', libraryRoot })
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

  ipcMain.handle('library:assignSeries', async (_event, ids: number[], seriesName: string, seriesIndex?: number) => {
    try {
      const errors: string[] = []
      let updated = 0

      for (const id of ids) {
        const item = libraryRepo.findById(id)
        if (!item) {
          errors.push(`Item ${id} not found`)
          continue
        }

        try {
          // 1. Embed series into PDF metadata (offloaded to worker)
          try {
            await spawnMetadataWorker({
              type: 'apply',
              pdfPath: item.filePath,
              metadata: {
                title: item.customTitle || `Gallery #${item.galleryId || item.id}`,
                creators: [item.primaryArtist || 'Unknown'],
                tags: item.customTags ? item.customTags.split(',').map((t: string) => t.trim()).filter(Boolean) : [],
                nhentaiId: item.galleryId,
                seriesName,
                seriesIndex: item.seriesIndex ?? undefined,
                language: item.language || item.customLanguage,
                publisher: item.publisher || undefined,
                description: item.description || undefined
              }
            })
          } catch (err) {
            errors.push(`Failed to embed series in PDF for item ${id}: ${String(err)}`)
            // Continue — DB update is still valid
          }

          // 2. Move file if currently in artist root (no series dir)
          const currentDir = dirname(item.filePath)
          const fileName = basename(item.filePath)

          // Check if file is directly under artist dir (no series subdir)
          // The structure is: {libraryRoot}/{artist}/{series?}/{file}
          // If the current dir's basename matches the primary artist, we need to create series subdir
          const parentDirName = basename(currentDir)

          if (parentDirName === item.primaryArtist || !item.seriesName) {
            // File is in artist root — move to series subdirectory
            const seriesDir = join(currentDir, seriesName)
            if (!existsSync(seriesDir)) {
              mkdirSync(seriesDir, { recursive: true })
            }
            const newPath = join(seriesDir, fileName)
            try {
              renameSync(item.filePath, newPath)
              libraryRepo.update(id, {
                seriesName,
                seriesIndex: seriesIndex ?? undefined,
                filePath: newPath
              } as Record<string, unknown>)
            } catch (moveErr) {
              errors.push(`Failed to move file for item ${id}: ${String(moveErr)}`)
              libraryRepo.update(id, { seriesName, seriesIndex: seriesIndex ?? undefined } as Record<string, unknown>)
            }
          } else {
            // Already in a subdirectory — just update DB
            libraryRepo.update(id, { seriesName, seriesIndex: seriesIndex ?? undefined } as Record<string, unknown>)
          }

          updated++
        } catch (err) {
          errors.push(`Error processing item ${id}: ${String(err)}`)
        }
      }

      return {
        success: true,
        data: { updated, errors: errors.length > 0 ? errors : undefined }
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // ─── Custom Entry ──────────────────────────────────────────────────

  ipcMain.handle('library:addCustom', async (_event, metadata: {
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
  }, libraryRoot: string) => {
    try {
      const { readdirSync, copyFileSync, mkdirSync, existsSync } = await import('fs')
      const { join } = await import('path')
      const { generatePdf } = await import('../services/pdf-generator')

      const primaryArtist = metadata.artists[0] || 'Unknown'
      const artistDir = join(libraryRoot, primaryArtist)
      if (!existsSync(artistDir)) {
        mkdirSync(artistDir, { recursive: true })
      }

      // Generate safe filename
      const safeTitle = metadata.title
        .replace(/[/\\?%*:|"<>]/g, '')
        .substring(0, 120)
        .trim()
      const filename = `[nhentai-00000] ${safeTitle}.pdf`
      const destPath = join(artistDir, filename)

      let finalPdfPath: string

      if (metadata.sourceType === 'images') {
        // Convert images to PDF
        const imageFiles = readdirSync(metadata.sourcePath)
          .filter((f) => /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(f))
          .sort()
          .map((f) => join(metadata.sourcePath, f))

        if (imageFiles.length === 0) {
          return { success: false, error: 'No image files found in selected folder' }
        }

        await generatePdf(imageFiles, destPath, {
          pageSize: 'fit',
          quality: 90,
          blackBackground: false
        })
        finalPdfPath = destPath
      } else {
        // Copy PDF to library
        copyFileSync(metadata.sourcePath, destPath)
        finalPdfPath = destPath
      }

      // Embed metadata
      const tagList = metadata.tags
        ? metadata.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : []

      // Embed metadata (offloaded to worker thread)
      await spawnMetadataWorker({
        type: 'apply',
        pdfPath: finalPdfPath,
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

      // Get file size
      const { statSync } = await import('fs')
      const fileSize = statSync(finalPdfPath).size

      // Insert into DB
      const now = Date.now()
      const newId = libraryRepo.insert({
        galleryId: null,
        isCustom: 1,
        customTitle: metadata.title,
        customTags: metadata.tags || null,
        customLanguage: metadata.language || null,
        customDate: metadata.date || null,
        customCoverPath: metadata.coverPath || null,
        filePath: finalPdfPath,
        fileSize,
        format: 'pdf',
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

      return { success: true, data: { id: newId, filePath: finalPdfPath } }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // ─── File Actions ──────────────────────────────────────────────────

  ipcMain.handle('library:delete', async (_event, id: number) => {
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

      // ── Re-embed metadata into PDF ────────────────────────────────
      try {
        const tagList: Array<{ id: number; type: string; name: string }> = []
        // Parse existing tags from customTags
        if (newTags) {
          newTags.split(',').forEach((t: string) => {
            const trimmed = t.trim()
            if (trimmed) tagList.push({ id: 0, type: 'tag', name: trimmed })
          })
        }
        // Add artist tags
        if (newPrimaryArtist) {
          tagList.push({ id: 0, type: 'artist', name: newPrimaryArtist })
        }

        await spawnMetadataWorker({
          type: 'apply',
          pdfPath: item.filePath,
          metadata: {
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
          }
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

        const processNext = () => {
          if (conversionCancelled || queueIndex >= total) {
            worker.terminate().then(() => resolve()).catch(() => resolve())
            return
          }
          currentItem = items[queueIndex++]
          if (!currentItem) return
          worker.postMessage({
            type: 'convert',
            item: {
              id: currentItem.id,
              filePath: currentItem.filePath,
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

        worker.on('error', () => { failed++; processNext() })
        worker.on('exit', (code) => {
          if (code !== 0 && currentItem) { failed++; sendProgress() }
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

  function spawnSyncWorker(itemId: number, nhentaiId: number, filePath: string): Promise<{ success: boolean; message?: string }> {
    return new Promise((resolve) => {
      const workerPath = pathJoin(__dirname, 'services/sync.worker.js')
      const worker = new Worker(workerPath)

      // Get API key from settings
      const encryptedKey = settingsRepo.get('nhentai_api_key')
      let apiKey: string | undefined
      if (encryptedKey) {
        try {
          // Simple decrypt — auth.ipc has encryptKey/decryptKey functions
          const auth = require('../ipc/auth.ipc')
          if (auth.decryptKey && typeof auth.decryptKey === 'function') {
            apiKey = auth.decryptKey(encryptedKey as string)
          }
        } catch { /* ignore — sync without auth is fine */ }
      }

      worker.on('message', (msg: { type: string; itemId: number; success?: boolean; message?: string; metadata?: { title: string; primaryArtist: string; tags: string; language: string | null } }) => {
        if (msg.type === 'complete') {
          const now = Date.now()
          try {
            const updateData: Record<string, unknown> = { synced: 1, syncedAt: now }
            if (msg.metadata) {
              updateData.customTitle = msg.metadata.title
              updateData.primaryArtist = msg.metadata.primaryArtist
              updateData.customTags = msg.metadata.tags
              updateData.customLanguage = msg.metadata.language
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

      worker.postMessage({ type: 'sync', itemId, nhentaiId, filePath, apiKey })
    })
  }

  ipcMain.handle('library:syncItem', async (_event, itemId: number) => {
    if (syncingItems.has(itemId)) return { success: false, error: 'Already syncing' }

    const item = libraryRepo.findById(itemId)
    if (!item || !item.galleryId) return { success: false, error: 'No nhentai ID' }

    syncingItems.add(itemId)
    const result = await spawnSyncWorker(itemId, item.galleryId, item.filePath)

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
      if (!item || !item.galleryId || syncingItems.has(ids[i])) {
        failed++
        continue
      }

      syncingItems.add(ids[i])
      const result = await spawnSyncWorker(ids[i], item.galleryId, item.filePath)

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
}
