import { PDFDocument } from 'pdf-lib'
import { readFileSync, statSync, existsSync } from 'fs'
import { readdir } from 'fs/promises'
import { join, relative, basename } from 'path'
import { libraryRepo } from '../db/repositories/library.repo'
import type { NewLibraryItem } from '../db/repositories/library.repo'
import { galleryRepo } from '../db/repositories/gallery.repo'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScanProgress {
  current: number
  total: number
  status: string
}

export interface ScanResult {
  total: number
  newItems: number
  removedItems: number
  errors: string[]
}

interface PdfMetadata {
  title: string | null
  authors: string[]
  tags: string[]
  galleryId: number | null
  creationDate: Date | null
}

// ─── Constants ───────────────────────────────────────────────────────────────

const NHENTAI_ID_REGEX = /nhentai:(\d+)/i
const FILENAME_ID_REGEX = /\[nhentai-(\d+)\]/

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Walk a directory recursively, collecting all PDF file paths.
 */
async function walkPdfs(dir: string): Promise<string[]> {
  const results: string[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      // Skip hidden files/dirs, _Unsorted, _migration_staging, and non-PDF files
      if (entry.name.startsWith('.')) continue
      if (entry.name === '_Unsorted' || entry.name === '_migration_staging') continue

      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        const subResults = await walkPdfs(fullPath)
        results.push(...subResults)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
        results.push(fullPath)
      }
    }
  } catch {
    // Directory unreadable — skip
  }
  return results
}

/**
 * Extract metadata from a PDF file using pdf-lib.
 */
async function extractPdfMetadata(filePath: string): Promise<PdfMetadata> {
  const metadata: PdfMetadata = {
    title: null,
    authors: [],
    tags: [],
    galleryId: null,
    creationDate: null
  }

  let buffer: Buffer
  try {
    buffer = readFileSync(filePath)
  } catch {
    return metadata
  }

  let pdfDoc: PDFDocument
  try {
    pdfDoc = await PDFDocument.load(buffer, {
      // Don't use allow_overwriting_input — we only read
    })
  } catch {
    return metadata
  }

  // Title
  try {
    metadata.title = pdfDoc.getTitle() || null
  } catch {
    // ignore
  }

  // Author(s): comma-separated convention
  try {
    const author = pdfDoc.getAuthor()
    if (author) {
      metadata.authors = author
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean)
    }
  } catch {
    // ignore
  }

  // Keywords: extract nhentai:{id} token + remaining tokens as tags
  try {
    const keywords = pdfDoc.getKeywords()
    if (keywords) {
      // Keywords may be stored as comma-separated string
      const tokens = keywords.split(',').map((k) => k.trim()).filter(Boolean)
      for (const token of tokens) {
        const match = token.match(NHENTAI_ID_REGEX)
        if (match) {
          metadata.galleryId = parseInt(match[1], 10)
        } else {
          metadata.tags.push(token)
        }
      }
    }
  } catch {
    // ignore
  }

  // CreationDate
  try {
    const date = pdfDoc.getCreationDate()
    if (date) {
      metadata.creationDate = date
    }
  } catch {
    // ignore
  }

  return metadata
}

/**
 * Extract gallery ID from filename fallback: [nhentai-{id}]
 */
function extractIdFromFilename(filePath: string): number | null {
  const name = basename(filePath)
  const match = name.match(FILENAME_ID_REGEX)
  if (match) {
    return parseInt(match[1], 10)
  }
  return null
}

/**
 * Infer primary artist and series from the file path structure.
 * Structure: {libraryRoot}/{Artist}/{Series?}/{Filename}.pdf
 */
function inferArtistAndSeries(
  filePath: string,
  libraryRoot: string
): { primaryArtist: string; seriesName: string | null } {
  const relPath = relative(libraryRoot, filePath)
  const parts = relPath.replace(/\\/g, '/').split('/')

  // parts[0] = artist directory
  // parts[1] = series directory OR filename
  // parts[2] = filename (if series exists)

  const primaryArtist = parts[0] || 'Unknown'
  let seriesName: string | null = null

  if (parts.length >= 3) {
    // There's a subdirectory between artist and filename = series
    seriesName = parts[1]
  }

  return { primaryArtist, seriesName }
}

/**
 * Get file size in bytes.
 */
function getFileSize(filePath: string): number {
  try {
    return statSync(filePath).size
  } catch {
    return 0
  }
}

// ─── Main Scanner ────────────────────────────────────────────────────────────

export async function scanLibrary(
  libraryRoot: string,
  sendProgress: (progress: ScanProgress) => void
): Promise<ScanResult> {
  const errors: string[] = []
  let newItems = 0
  let removedItems = 0

  // Phase 1: Walk directory to find all PDFs
  sendProgress({ current: 0, total: 0, status: 'Scanning library directory...' })

  if (!existsSync(libraryRoot)) {
    errors.push(`Library root does not exist: ${libraryRoot}`)
    return { total: 0, newItems: 0, removedItems: 0, errors }
  }

  const pdfFiles = await walkPdfs(libraryRoot)
  const total = pdfFiles.length

  sendProgress({ current: 0, total, status: `Found ${total} PDF files` })

  // Phase 2: Build set of file paths already in DB (for removed detection)
  const dbItems = libraryRepo.findAllWithFilePaths()
  const dbFilePathSet = new Set(dbItems.map((i) => i.filePath))
  const pdfFilePathSet = new Set(pdfFiles)

  // Phase 3: Process each PDF
  for (let i = 0; i < total; i++) {
    const filePath = pdfFiles[i]

    try {
      // Extract metadata from PDF
      const metadata = await extractPdfMetadata(filePath)

      // Determine gallery ID: metadata first, filename fallback
      let galleryId = metadata.galleryId
      if (!galleryId) {
        galleryId = extractIdFromFilename(filePath)
      }

      // Infer artist and series from path structure
      const { primaryArtist, seriesName } = inferArtistAndSeries(filePath, libraryRoot)

      // Use metadata authors if available, otherwise use inferred artist
      const artists =
        metadata.authors.length > 0 ? metadata.authors : [primaryArtist]

      // Determine title
      const title =
        metadata.title ||
        basename(filePath).replace(/\.pdf$/i, '').replace(/^\[nhentai-\d+\]\s*/, '')

      // Check if already in DB by gallery ID
      if (galleryId) {
        const existing = libraryRepo.findByGalleryId(galleryId)
        if (existing) {
          // Update file path if changed, series if set and not already set
          const updates: Record<string, string | number | null> = {}
          if (existing.filePath !== filePath) {
            updates.filePath = filePath
          }
          if (seriesName && !existing.seriesName) {
            updates.seriesName = seriesName
          }
          if (Object.keys(updates).length > 0) {
            libraryRepo.update(existing.id, updates as Partial<NewLibraryItem>)
          }
          sendProgress({ current: i + 1, total, status: `Skipped (known): ${basename(filePath)}` })
          continue
        }
      }

      // Check by file path in DB
      if (dbFilePathSet.has(filePath)) {
        sendProgress({ current: i + 1, total, status: `Skipped (already indexed): ${basename(filePath)}` })
        continue
      }

      // Determine if this is a custom (non-nhentai) item
      const isCustom = galleryId ? 0 : 1

      // Insert library item
      const fileSize = getFileSize(filePath)
      const now = Date.now()
      const newId = libraryRepo.insert({
        galleryId: galleryId || null,
        isCustom,
        customTitle: title,
        customTags: metadata.tags.length > 0 ? metadata.tags.join(', ') : null,
        customLanguage: null,
        customDate: metadata.creationDate
          ? metadata.creationDate.toISOString().split('T')[0]
          : null,
        customCoverPath: null,
        filePath,
        fileSize,
        format: 'pdf',
        primaryArtist: artists[0] || 'Unknown',
        seriesName,
        readProgress: 0,
        addedAt: now,
        updatedAt: now
      })

      // Insert artists
      for (let ai = 0; ai < artists.length; ai++) {
        libraryRepo.addArtist({
          libraryItemId: newId,
          artistName: artists[ai],
          sortOrder: ai
        })
      }

      // Cache gallery metadata if we have a gallery ID and it's not already cached
      if (galleryId) {
        const existingGallery = galleryRepo.findById(galleryId)
        if (!existingGallery) {
          // Create a minimal gallery stub if we have enough metadata
          // The full metadata can be fetched later when the user views it
          try {
            galleryRepo.upsert({
              id: galleryId,
              mediaId: galleryId,
              titlePretty: title,
              titleEnglish: title,
              titleJapanese: null,
              pageCount: 0,
              favoritesCount: 0,
              uploadDate: metadata.creationDate
                ? Math.floor(metadata.creationDate.getTime() / 1000)
                : null,
              thumbnailUrl: null,
              coverUrl: null,
              rawTagsJson: JSON.stringify(
                metadata.tags.map((t) => ({ id: 0, type: 'tag', name: t }))
              ),
              rawJson: JSON.stringify({ id: galleryId, title: { pretty: title } }),
              createdAt: now,
              updatedAt: now
            })
          } catch {
            // Non-critical; gallery cache can be populated later
          }
        }
      }

      newItems++
      sendProgress({
        current: i + 1,
        total,
        status: `+ ${basename(filePath)}`
      })
    } catch (err) {
      const relPath = relative(libraryRoot, filePath)
      const msg = `Error processing ${relPath}: ${String(err)}`
      errors.push(msg)
      sendProgress({ current: i + 1, total, status: `Error: ${basename(filePath)}` })
    }
  }

  // Phase 4: Detect removed items (in DB but not on disk)
  for (const dbItem of dbItems) {
    if (!pdfFilePathSet.has(dbItem.filePath)) {
      // File no longer on disk — remove from DB
      try {
        libraryRepo.delete(dbItem.id)
        removedItems++
      } catch (err) {
        errors.push(`Failed to remove DB entry ${dbItem.id}: ${String(err)}`)
      }
    }
  }

  // Phase 5: Log scan results
  libraryRepo.insertScanLog({
    scannedAt: Date.now(),
    totalItems: total,
    newItems,
    removedItems,
    errorsJson: JSON.stringify(errors)
  })

  sendProgress({
    current: total,
    total,
    status: `Done: ${newItems} new, ${removedItems} removed, ${total} total`
  })

  return { total, newItems, removedItems, errors }
}
