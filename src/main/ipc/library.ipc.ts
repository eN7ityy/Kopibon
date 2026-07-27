import { ipcMain, BrowserWindow } from 'electron'
import { libraryRepo } from '../db/repositories/library.repo'
import { scanLibrary } from '../services/library-scanner'
import { setSeries, embedMetadata } from '../services/metadata-writer'
import { renameSync, mkdirSync, existsSync } from 'fs'
import { dirname, join, basename } from 'path'

let isScanning = false

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

  ipcMain.handle('library:count', async () => {
    try {
      const count = libraryRepo.count()
      return { success: true, data: count }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // ─── Scan ──────────────────────────────────────────────────────────

  ipcMain.handle('library:scan', async (event, libraryRoot: string) => {
    if (isScanning) {
      return { success: false, error: 'Scan already in progress' }
    }

    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) {
      return { success: false, error: 'No window found' }
    }

    isScanning = true

    // Run scan asynchronously, sending progress to the renderer
    scanLibrary(libraryRoot, (progress) => {
      win.webContents.send('library:scanProgress', progress)
    })
      .then((result) => {
        isScanning = false
        win.webContents.send('library:scanComplete', result)
      })
      .catch((error) => {
        isScanning = false
        win.webContents.send('library:scanError', String(error))
      })

    return { success: true, data: { scanning: true } }
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

  // ─── Series Assignment ─────────────────────────────────────────────

  ipcMain.handle('library:assignSeries', async (_event, ids: number[], seriesName: string) => {
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
          // 1. Embed series into PDF metadata
          try {
            await setSeries(item.filePath, seriesName)
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
                filePath: newPath
              })
            } catch (moveErr) {
              errors.push(`Failed to move file for item ${id}: ${String(moveErr)}`)
              libraryRepo.update(id, { seriesName })
            }
          } else {
            // Already in a subdirectory — just update DB
            libraryRepo.update(id, { seriesName })
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

      await embedMetadata(finalPdfPath, {
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
        seriesName: metadata.series
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
      libraryRepo.delete(id)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('library:updateMetadata', async (_event, id: number, metadata: Record<string, string | number | null>) => {
    try {
      libraryRepo.update(id, {
        customTitle: metadata.customTitle as string | undefined,
        customTags: metadata.customTags as string | undefined,
        customLanguage: metadata.customLanguage as string | undefined,
        customDate: metadata.customDate as string | undefined,
        seriesName: metadata.seriesName as string | undefined,
        primaryArtist: metadata.primaryArtist as string | undefined
      })
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}
