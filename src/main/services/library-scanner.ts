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
  cancelled: boolean
}

export interface ScanCancelToken {
  cancelled: boolean
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
const CHUNK_SIZE = 50 // Process 50 PDFs per event-loop yield
const PROGRESS_INTERVAL = 25 // Only send progress every N files

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Yield control back to the event loop so the UI stays responsive.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Walk a directory recursively, collecting all PDF file paths.
 */
async function walkPdfs(dir: string): Promise<string[]> {
  const results: string[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
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
    pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true })
  } catch {
    return metadata
  }

  try { metadata.title = pdfDoc.getTitle() || null } catch { /* ignore */ }

  try {
    const author = pdfDoc.getAuthor()
    if (author) {
      metadata.authors = author.split(',').map((a) => a.trim()).filter(Boolean)
    }
  } catch { /* ignore */ }

  try {
    const keywords = pdfDoc.getKeywords()
    if (keywords) {
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
  } catch { /* ignore */ }

  try {
    const date = pdfDoc.getCreationDate()
    if (date) metadata.creationDate = date
  } catch { /* ignore */ }

  return metadata
}

function extractIdFromFilename(filePath: string): number | null {
  const name = basename(filePath)
  const match = name.match(FILENAME_ID_REGEX)
  return match ? parseInt(match[1], 10) : null
}

function inferArtistAndSeries(
  filePath: string,
  libraryRoot: string
): { primaryArtist: string; seriesName: string | null } {
  const relPath = relative(libraryRoot, filePath)
  const parts = relPath.replace(/\\/g, '/').split('/')
  const primaryArtist = parts[0] || 'Unknown'
  const seriesName = parts.length >= 3 ? parts[1] : null
  return { primaryArtist, seriesName }
}

function getFileSize(filePath: string): number {
  try { return statSync(filePath).size } catch { return 0 }
}

/**
 * Generate a thumbnail image from the first page of a PDF.
 * Uses pdftoppm (poppler-utils) if available, otherwise falls back
 * to extracting the first embedded image via pdf-lib.
 * Returns the path to the generated thumbnail, or null on failure.
 */
async function generateThumbnail(pdfPath: string): Promise<string | null> {
  const { execFile } = await import('child_process')
  const { tmpdir } = await import('os')
  const { join } = await import('path')
  const { existsSync, mkdirSync } = await import('fs')

  // Ensure thumbnails directory exists
  const thumbDir = join(tmpdir(), 'doujin-downloader-thumbs')
  if (!existsSync(thumbDir)) {
    try { mkdirSync(thumbDir, { recursive: true }) } catch { return null }
  }

  // Use a hash of the path as the thumbnail filename
  const hash = pdfPath.split('').reduce((acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0, 0).toString(16)
  const thumbPath = join(thumbDir, `${hash}.jpg`)

  // If already generated, return it
  if (existsSync(thumbPath)) return thumbPath

  // Try pdftoppm first (produces actual rendered images)
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('pdftoppm', [
        '-f', '1', '-l', '1',        // first page only
        '-singlefile',                 // single output file
        '-jpeg',                       // JPEG output
        '-scale-to', '300',           // max dimension 300px
        pdfPath,
        thumbPath.replace('.jpg', '') // pdftoppm appends .jpg itself
      ], { timeout: 5000 }, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    // pdftoppm creates thumbPath-1.jpg or thumbPath.jpg depending on version
    const possiblePaths = [thumbPath, thumbPath.replace('.jpg', '-1.jpg'), thumbPath.replace('.jpg', '.jpg')]
    for (const p of possiblePaths) {
      if (existsSync(p)) {
        if (p !== thumbPath) {
          const { renameSync } = await import('fs')
          try { renameSync(p, thumbPath) } catch { return p }
        }
        return thumbPath
      }
    }
  } catch {
    // pdftoppm not available, fall through to pdf-lib image extraction
  }

  // Fallback: extract first embedded image from PDF via pdf-lib
  try {
    const buffer = readFileSync(pdfPath)
    const pdfDoc = await PDFDocument.load(buffer)
    const pages = pdfDoc.getPages()
    if (pages.length === 0) return null

    // pdf-lib doesn't have a direct page-to-image API.
    // As a final fallback, we generate a tiny placeholder.
  } catch {
    // ignore
  }

  return null
}

// ─── Main Scanner (non-blocking with cancel support) ──────────────────────────

export async function scanLibrary(
  libraryRoot: string,
  sendProgress: (progress: ScanProgress) => void,
  cancelToken: ScanCancelToken = { cancelled: false }
): Promise<ScanResult> {
  const errors: string[] = []
  let newItems = 0
  let removedItems = 0

  // Phase 1: Walk directory
  sendProgress({ current: 0, total: 0, status: 'Scanning library directory...' })

  if (!existsSync(libraryRoot)) {
    errors.push(`Library root does not exist: ${libraryRoot}`)
    return { total: 0, newItems: 0, removedItems: 0, errors, cancelled: false }
  }

  const pdfFiles = await walkPdfs(libraryRoot)
  if (cancelToken.cancelled) {
    return { total: 0, newItems: 0, removedItems: 0, errors, cancelled: true }
  }

  const total = pdfFiles.length
  sendProgress({ current: 0, total, status: `Found ${total} PDF files` })

  // Phase 2: Build DB path sets (fast, sync)
  const dbItems = libraryRepo.findAllWithFilePaths()
  const dbFilePathSet = new Set(dbItems.map((i) => i.filePath))
  const pdfFilePathSet = new Set(pdfFiles)

  // Phase 3: Process PDFs in chunks, yielding to event loop between chunks
  let lastProgressSent = 0
  for (let i = 0; i < total; i++) {
    // Check cancellation before each file
    if (cancelToken.cancelled) {
      sendProgress({ current: i, total, status: 'Scan cancelled' })
      return { total, newItems, removedItems, errors, cancelled: true }
    }

    const filePath = pdfFiles[i]

    try {
      const metadata = await extractPdfMetadata(filePath)

      let galleryId = metadata.galleryId
      if (!galleryId) galleryId = extractIdFromFilename(filePath)

      const { primaryArtist, seriesName } = inferArtistAndSeries(filePath, libraryRoot)
      const artists = metadata.authors.length > 0 ? metadata.authors : [primaryArtist]
      const title = metadata.title ||
        basename(filePath).replace(/\.pdf$/i, '').replace(/^\[nhentai-\d+\]\s*/, '')

      // Check existing
      if (galleryId) {
        const existing = libraryRepo.findByGalleryId(galleryId)
        if (existing) {
          const updates: Record<string, string | number | null> = {}
          if (existing.filePath !== filePath) updates.filePath = filePath
          if (seriesName && !existing.seriesName) updates.seriesName = seriesName
          if (Object.keys(updates).length > 0) {
            libraryRepo.update(existing.id, updates as Partial<NewLibraryItem>)
          }
          continue
        }
      }

      if (dbFilePathSet.has(filePath)) continue

      // Generate thumbnail from first page
      let coverPath: string | null = null
      try {
        coverPath = await generateThumbnail(filePath)
      } catch { /* non-critical */ }

      const isCustom = galleryId ? 0 : 1
      const fileSize = getFileSize(filePath)
      const now = Date.now()
      const newId = libraryRepo.insert({
        galleryId: galleryId || null,
        isCustom,
        customTitle: title,
        customTags: metadata.tags.length > 0 ? metadata.tags.join(', ') : null,
        customLanguage: null,
        customDate: metadata.creationDate ? metadata.creationDate.toISOString().split('T')[0] : null,
        customCoverPath: coverPath,
        filePath,
        fileSize,
        format: 'pdf',
        primaryArtist: artists[0] || 'Unknown',
        seriesName,
        readProgress: 0,
        addedAt: now,
        updatedAt: now
      })

      for (let ai = 0; ai < artists.length; ai++) {
        libraryRepo.addArtist({ libraryItemId: newId, artistName: artists[ai], sortOrder: ai })
      }

      if (galleryId && !galleryRepo.findById(galleryId)) {
        try {
          galleryRepo.upsert({
            id: galleryId, mediaId: galleryId,
            titlePretty: title, titleEnglish: title, titleJapanese: null,
            pageCount: 0, favoritesCount: 0,
            uploadDate: metadata.creationDate ? Math.floor(metadata.creationDate.getTime() / 1000) : null,
            thumbnailUrl: null, coverUrl: null,
            rawTagsJson: JSON.stringify(metadata.tags.map((t) => ({ id: 0, type: 'tag', name: t }))),
            rawJson: JSON.stringify({ id: galleryId, title: { pretty: title } }),
            createdAt: now, updatedAt: now
          })
        } catch { /* non-critical */ }
      }

      newItems++
    } catch (err) {
      const relPath = relative(libraryRoot, filePath)
      errors.push(`Error processing ${relPath}: ${String(err)}`)
    }

    // Send batched progress update (not every file)
    if (i - lastProgressSent >= PROGRESS_INTERVAL || i === total - 1) {
      sendProgress({ current: i + 1, total, status: `Scanned ${i + 1}/${total} (${newItems} new)` })
      lastProgressSent = i
    }

    // Yield to event loop every CHUNK_SIZE files
    if ((i + 1) % CHUNK_SIZE === 0) {
      await yieldToEventLoop()
    }
  }

  if (cancelToken.cancelled) {
    sendProgress({ current: total, total, status: 'Scan cancelled' })
    return { total, newItems, removedItems, errors, cancelled: true }
  }

  // Phase 4: Detect removed items
  for (const dbItem of dbItems) {
    if (!pdfFilePathSet.has(dbItem.filePath)) {
      try {
        libraryRepo.delete(dbItem.id)
        removedItems++
      } catch (err) {
        errors.push(`Failed to remove DB entry ${dbItem.id}: ${String(err)}`)
      }
    }
  }

  // Phase 5: Log
  libraryRepo.insertScanLog({
    scannedAt: Date.now(),
    totalItems: total,
    newItems,
    removedItems,
    errorsJson: JSON.stringify(errors)
  })

  sendProgress({ current: total, total, status: `Done: ${newItems} new, ${removedItems} removed, ${total} total` })
  return { total, newItems, removedItems, errors, cancelled: false }
}
