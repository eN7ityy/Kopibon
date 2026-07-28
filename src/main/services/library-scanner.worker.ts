/**
 * Library Scanner Worker Thread
 *
 * Runs in a separate Node.js worker_thread, communicating with the main
 * process via postMessage. Opens its own better-sqlite3 connection
 * (WAL mode allows concurrent reads/writes with the main process).
 *
 * Message Protocol:
 *   Main → Worker: { type: 'start' | 'pause' | 'resume' | 'cancel', libraryRoot?: string }
 *   Worker → Main: { type: 'progress' | 'newItem' | 'complete' | 'error' | 'paused' | 'cancelled', ... }
 */

import { parentPort } from 'worker_threads'
import { readFileSync, statSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from 'fs'
import { readdir } from 'fs/promises'
import { join, relative, basename } from 'path'
import { execFile } from 'child_process'
import { tmpdir, homedir } from 'os'
import Database from 'better-sqlite3'
import { PDFDocument } from 'pdf-lib'

// ─── Types ───────────────────────────────────────────────────────────────────

type WorkerCommand =
  | { type: 'start'; libraryRoot: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cancel' }

type WorkerEvent =
  | { type: 'progress'; current: number; total: number; status: string }
  | { type: 'newItem'; item: { id: number; title: string; artist: string } }
  | { type: 'newItems'; items: Array<{ id: number; title: string; artist: string }> }
  | { type: 'complete'; result: { total: number; newItems: number; removedItems: number; errors: string[]; cancelled: boolean } }
  | { type: 'error'; message: string }
  | { type: 'paused' }
  | { type: 'cancelled' }

interface PdfMetadata {
  title: string | null
  authors: string[]
  tags: string[]
  galleryId: number | null
  creationDate: Date | null
  seriesName: string | null
  seriesIndex: number | null
  language: string | null
  publisher: string | null
  description: string | null
}

// ─── Constants ───────────────────────────────────────────────────────────────

const NHENTAI_ID_REGEX = /nhentai:(\d+)/i
const FILENAME_ID_REGEX = /\[nhentai-(\d+)\]/
const PROGRESS_INTERVAL = 1
const LOG_DIR = join(homedir(), '.config', 'doujin-downloader', 'logs')

// ─── State ───────────────────────────────────────────────────────────────────

let state: 'idle' | 'scanning' | 'paused' | 'cancelled' = 'idle'
let db: Database.Database | null = null
let currentLibraryRoot = ''
let resolvePause: (() => void) | null = null

// ─── Logging ─────────────────────────────────────────────────────────────────

let logPath: string | null = null

function initLog(): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
  // Include full timestamp with milliseconds to avoid collisions and survive crashes
  const iso = new Date().toISOString() // "2026-07-27T22:35:12.416Z"
  const safe = iso.replace(/:/g, '-').replace(/\./g, '-') // "2026-07-27T22-35-12-416Z"
  logPath = join(LOG_DIR, `scan-${safe}.log`)
  writeFileSync(logPath, `SCAN_LOG_START ${iso}\n`)
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  if (logPath) {
    try { appendFileSync(logPath, line) } catch { /* */ }
  }
}

// ─── Messaging ───────────────────────────────────────────────────────────────

function send(event: WorkerEvent): void {
  parentPort?.postMessage(event)
}

// ─── PDF Metadata ────────────────────────────────────────────────────────────

// ─── XMP Extraction ──────────────────────────────────────────────────────────

const XMP_SERIES_REGEX = /<calibre:series[^>]*>([^<]+)<\/calibre:series>/i
const XMP_SERIES_INDEX_REGEX = /<ns0:series_index[^>]*>([^<]+)<\/ns0:series_index>/i
const XMP_SERIES_INDEX_ALT_REGEX = /<calibreSI:series_index[^>]*>([^<]+)<\/calibreSI:series_index>/i
const XMP_LANGUAGE_REGEX = /<dc:language[^>]*>([^<]+)<\/dc:language>/i
const XMP_PUBLISHER_REGEX = /<dc:publisher[^>]*>[\s\S]*?<rdf:li[^>]*>([^<]*)<\/rdf:li>/i
const XMP_DESCRIPTION_REGEX = /<dc:description[^>]*>([\s\S]*?)<\/dc:description>/i

// XMP fields needed for pikepdf-processed files (no docinfo)
const XMP_TITLE_REGEX = /<dc:title[^>]*>[\s\S]*?<rdf:li[^>]*>([^<]+)<\/rdf:li>/i
const XMP_CREATOR_REGEX = /<dc:creator[^>]*>[\s\S]*?<rdf:li[^>]*>([^<]+)<\/rdf:li>/gi
const XMP_DATE_REGEX = /<dc:date[^>]*>([^<]+)<\/dc:date>/i
const XMP_ISBN_REGEX = /<pdfx:isbn[^>]*>(\d+)<\/pdfx:isbn>/i
/**
 * Extract XMP metadata from raw PDF buffer by searching for the XMP packet.
 * XMP metadata streams in PDF are typically stored uncompressed for compatibility.
 */
function extractXmpFromBuffer(buffer: Buffer): Record<string, string> {
  const result: Record<string, string> = {}
  try {
    const str = buffer.toString('utf-8')
    const xmpMatch = str.match(/<x:xmpmeta[^>]*>([\s\S]*?)<\/x:xmpmeta>/i)
    if (!xmpMatch) return result
    const xmp = xmpMatch[1]

    // calibre:series (F3)
    const seriesM = xmp.match(XMP_SERIES_REGEX)
    if (seriesM) result.seriesName = seriesM[1].trim()

    // series_index in calibre namespace (F2)
    const siM = xmp.match(XMP_SERIES_INDEX_REGEX)
    if (siM) result.seriesIndex = siM[1].trim()
    else {
      const siAlt = xmp.match(XMP_SERIES_INDEX_ALT_REGEX)
      if (siAlt) result.seriesIndex = siAlt[1].trim()
    }

    // dc:language (F4)
    const langM = xmp.match(XMP_LANGUAGE_REGEX)
    if (langM) result.language = langM[1].trim()

    // dc:publisher (F5)
    const pubM = xmp.match(XMP_PUBLISHER_REGEX)
    if (pubM) result.publisher = pubM[1].trim()

    // dc:description (F6)
    const descM = xmp.match(XMP_DESCRIPTION_REGEX)
    if (descM) result.description = descM[1].trim()

    // dc:title — fallback for pikepdf-processed files (no docinfo)
    const titleM = xmp.match(XMP_TITLE_REGEX)
    if (titleM) result.xmpTitle = titleM[1].trim()

    // dc:creator — fallback for pikepdf-processed files
    const creators: string[] = []
    let creatorM: RegExpExecArray | null
    while ((creatorM = XMP_CREATOR_REGEX.exec(xmp)) !== null) {
      creators.push(creatorM[1].trim())
    }
    if (creators.length > 0) result.xmpCreators = creators.join(', ')

    // dc:date — fallback for pikepdf-processed files
    const dateM = xmp.match(XMP_DATE_REGEX)
    if (dateM) result.xmpDate = dateM[1].trim()

    // pdfx:isbn — nhentai gallery ID fallback
    const isbnM = xmp.match(XMP_ISBN_REGEX)
    if (isbnM) result.xmpGalleryId = isbnM[1]
    XMP_CREATOR_REGEX.lastIndex = 0 // reset global regex
  } catch { /* XMP parse failure is non-fatal */ }
  return result
}

// ─── PDF Metadata ────────────────────────────────────────────────────────────

async function extractPdfMetadata(filePath: string): Promise<PdfMetadata> {
  const metadata: PdfMetadata = {
    title: null, authors: [], tags: [], galleryId: null, creationDate: null,
    seriesName: null, seriesIndex: null, language: null, publisher: null, description: null
  }
  let buffer: Buffer
  try { buffer = readFileSync(filePath) } catch { return metadata }
  let pdfDoc: PDFDocument
  try { pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true }) } catch { return metadata }

  // ── Docinfo fields ──────────────────────────────────────────────────
  try { metadata.title = pdfDoc.getTitle() || null } catch { /* */ }
  try { const a = pdfDoc.getAuthor(); if (a) metadata.authors = a.split(',').map(s => s.trim()).filter(Boolean) } catch { /* */ }
  try {
    const kw = pdfDoc.getKeywords()
    if (kw) {
      for (const t of kw.split(',').map(s => s.trim()).filter(Boolean)) {
        const m = t.match(NHENTAI_ID_REGEX)
        if (m) metadata.galleryId = parseInt(m[1], 10)
        else {
          // Extract extended metadata from /Keywords tokens
          const siMatch = t.match(/^series_index:(\d+(?:\.\d+)?)$/i)
          if (siMatch) { metadata.seriesIndex = parseFloat(siMatch[1]); continue }
          const csMatch = t.match(/^calibre_series:(.+)$/i)
          if (csMatch) { metadata.seriesName = csMatch[1].trim(); continue }
          const langMatch = t.match(/^language:(\w+)$/i)
          if (langMatch) { metadata.language = langMatch[1].toLowerCase(); continue }
          const pubMatch = t.match(/^publisher:(.+)$/i)
          if (pubMatch) { metadata.publisher = pubMatch[1].trim(); continue }
          metadata.tags.push(t)
        }
      }
    }
  } catch { /* */ }
  try { const d = pdfDoc.getCreationDate(); if (d) metadata.creationDate = d } catch { /* */ }

  // ── Docinfo Subject (legacy series fallback) ─────────────────────────
  try {
    const subject = pdfDoc.getSubject()
    if (subject && !metadata.seriesName) {
      metadata.seriesName = subject.trim() || null
    }
  } catch { /* */ }

  // ── XMP metadata (primary source for calibre fields) ─────────────────
  const xmp = extractXmpFromBuffer(buffer)

  // XMP series overrides docinfo Subject
  if (xmp.seriesName) metadata.seriesName = xmp.seriesName

  // XMP series_index overrides Keywords token
  if (xmp.seriesIndex) {
    const parsed = parseFloat(xmp.seriesIndex)
    if (!isNaN(parsed)) metadata.seriesIndex = parsed
  }

  // XMP fields (will also populate from Keywords tokens above)
  if (xmp.language && !metadata.language) metadata.language = xmp.language
  if (xmp.publisher && !metadata.publisher) metadata.publisher = xmp.publisher
  if (xmp.description) metadata.description = metadata.description || xmp.description

  // XMP fallbacks for pikepdf-processed files (no docinfo)
  if (!metadata.title && xmp.xmpTitle) metadata.title = xmp.xmpTitle
  if (metadata.authors.length === 0 && xmp.xmpCreators) {
    metadata.authors = xmp.xmpCreators.split(',').map(s => s.trim()).filter(Boolean)
  }
  if (!metadata.creationDate && xmp.xmpDate) {
    try { metadata.creationDate = new Date(xmp.xmpDate) } catch { /* */ }
  }
  if (!metadata.galleryId && xmp.xmpGalleryId) {
    metadata.galleryId = parseInt(xmp.xmpGalleryId, 10)
  }

  return metadata
}

function extractIdFromFilename(filePath: string): number | null {
  const m = basename(filePath).match(FILENAME_ID_REGEX)
  return m ? parseInt(m[1], 10) : null
}

// ─── Thumbnail Generation ────────────────────────────────────────────────────

async function generateThumbnail(pdfPath: string): Promise<string | null> {
  const thumbDir = join(tmpdir(), 'doujin-downloader-thumbs')
  if (!existsSync(thumbDir)) {
    try { mkdirSync(thumbDir, { recursive: true }) } catch { return null }
  }
  const hash = pdfPath.split('').reduce((acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0, 0).toString(16)
  const thumbPath = join(thumbDir, `${hash}.jpg`)
  if (existsSync(thumbPath)) return thumbPath

  try {
    await new Promise<void>((resolve, reject) => {
      execFile('pdftoppm', [
        '-f', '1', '-l', '1', '-singlefile', '-jpeg', '-scale-to', '300',
        pdfPath, thumbPath.replace('.jpg', '')
      ], { timeout: 5000 }, (err) => { if (err) reject(err); else resolve() })
    })
    const possible = [thumbPath, thumbPath.replace('.jpg', '-1.jpg')]
    for (const p of possible) {
      if (existsSync(p)) {
        if (p !== thumbPath) {
          const { renameSync } = await import('fs')
          try { renameSync(p, thumbPath) } catch { return p }
        }
        return thumbPath
      }
    }
  } catch { /* pdftoppm unavailable */ }
  return null
}

// ─── Directory Walking ───────────────────────────────────────────────────────

async function walkPdfs(dir: string): Promise<string[]> {
  const results: string[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.name === '_Unsorted' || entry.name === '_migration_staging') continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...(await walkPdfs(fullPath)))
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
        results.push(fullPath)
      }
    }
  } catch { /* */ }
  return results
}

// ─── Queue Management ────────────────────────────────────────────────────────

function populateQueue(filePaths: string[]): void {
  if (!db) return
  const stmt = db.prepare('INSERT OR IGNORE INTO scan_queue (file_path, status) VALUES (?, ?)')
  const tx = db.transaction(() => {
    for (const fp of filePaths) stmt.run(fp, 'pending')
  })
  tx()
  log(`QUEUE populated ${filePaths.length} paths`)
}

function resetPausedToPending(): void {
  if (!db) return
  db.prepare("UPDATE scan_queue SET status = 'pending' WHERE status = 'scanning'").run()
}

// ─── Incremental Check ───────────────────────────────────────────────────────

function shouldSkipFile(filePath: string): boolean {
  if (!db) return false
  let currentMtime: number
  let currentSize: number
  try {
    const stat = statSync(filePath)
    currentMtime = stat.mtimeMs
    currentSize = stat.size
  } catch { return false }

  const row = db.prepare(
    'SELECT file_mtime, file_size FROM library_item WHERE file_path = ?'
  ).get(filePath) as { file_mtime: number | null; file_size: number | null } | undefined

  if (row && row.file_mtime === currentMtime && row.file_size === currentSize) {
    return true
  }
  return false
}

// ─── DB Operations ───────────────────────────────────────────────────────────

function insertLibraryItem(data: {
  galleryId: number | null; isCustom: number; customTitle: string; customTags: string | null
  customLanguage: string | null; customDate: string | null; customCoverPath: string | null
  filePath: string; fileSize: number; format: string; primaryArtist: string
  seriesName: string | null; seriesIndex: number | null
  language: string | null; publisher: string | null; description: string | null
  thumbnailPath: string | null; fileMtime: number
  now: number
}): number {
  if (!db) return 0
  const result = db.prepare(`
    INSERT INTO library_item (gallery_id, is_custom, custom_title, custom_tags,
      custom_language, custom_date, custom_cover_path, file_path, file_size,
      format, primary_artist, series_name, series_index,
      thumbnail_path, file_mtime,
      read_progress, added_at, updated_at)
    VALUES (@gid, @ic, @ct, @ctg, @cl, @cd, @ccp, @fp, @fs, @fmt, @pa, @sn, @si, @tp, @fm, 0, @now, @now)
  `).run({
    gid: data.galleryId, ic: data.isCustom, ct: data.customTitle, ctg: data.customTags,
    cl: data.customLanguage, cd: data.customDate, ccp: data.customCoverPath,
    fp: data.filePath, fs: data.fileSize, fmt: data.format, pa: data.primaryArtist,
    sn: data.seriesName, si: data.seriesIndex, tp: data.thumbnailPath, fm: data.fileMtime, now: data.now
  })
  return Number(result.lastInsertRowid)
}

function updateLibraryItemMtime(id: number, filePath: string, fileMtime: number, fileSize: number): void {
  if (!db) return
  db.prepare('UPDATE library_item SET file_path = ?, file_mtime = ?, file_size = ?, updated_at = ? WHERE id = ?')
    .run(filePath, fileMtime, fileSize, Date.now(), id)
}

function insertArtist(libraryItemId: number, artistName: string, sortOrder: number): void {
  if (!db) return
  db.prepare('INSERT OR IGNORE INTO library_item_artist (library_item_id, artist_name, sort_order) VALUES (?, ?, ?)')
    .run(libraryItemId, artistName, sortOrder)
}

function upsertGalleryStub(galleryId: number, title: string, uploadDate: number | null, tags: string[]): void {
  if (!db) return
  const exists = db.prepare('SELECT id FROM gallery WHERE id = ?').get(galleryId)
  if (exists) return
  const now = Date.now()
  db.prepare(`INSERT INTO gallery (id, media_id, title_pretty, title_english, title_japanese,
    page_count, favorites_count, upload_date, thumbnail_url, cover_url, raw_tags_json, raw_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, 0, 0, ?, NULL, NULL, ?, ?, ?, ?)`).run(
    galleryId, galleryId, title, title,
    uploadDate, JSON.stringify(tags.map(t => ({ id: 0, type: 'tag', name: t }))),
    JSON.stringify({ id: galleryId, title: { pretty: title } }), now, now
  )
}

function markQueueItem(filePath: string, status: string, error?: string): void {
  if (!db) return
  db.prepare('UPDATE scan_queue SET status = ?, scanned_at = ?, error_message = ? WHERE file_path = ?')
    .run(status, Date.now(), error || null, filePath)
}

// ─── File Processing ─────────────────────────────────────────────────────────

async function processFile(filePath: string): Promise<{ status: 'new' | 'skipped' | 'error'; title?: string; artist?: string; id?: number }> {
  // Skip files modified in the last 5 seconds (still being written by concurrent downloads)
  try {
    const recentStat = statSync(filePath)
    if (Date.now() - recentStat.mtimeMs < 5_000) {
      log(`SKIP (recently modified) ${filePath}`)
      markQueueItem(filePath, 'completed')
      return { status: 'skipped' }
    }
  } catch { /* stat failure, continue to process */ }

  // Incremental skip
  if (shouldSkipFile(filePath)) {
    log(`SKIP (unchanged) ${filePath}`)
    markQueueItem(filePath, 'completed')
    return { status: 'skipped' }
  }

  try {
    const metadata = await extractPdfMetadata(filePath)

    let galleryId = metadata.galleryId
    if (!galleryId) galleryId = extractIdFromFilename(filePath)

    const relPath = relative(currentLibraryRoot, filePath)
    const parts = relPath.replace(/\\/g, '/').split('/')
    const primaryArtist = parts[0] || 'Unknown'
    // Prefer XMP/Keywords series name over directory-derived
    const dirSeriesName = parts.length >= 3 ? parts[1] : null
    const seriesName = metadata.seriesName || dirSeriesName
    const artists = metadata.authors.length > 0 ? metadata.authors : [primaryArtist]
    const title = metadata.title || basename(filePath).replace(/\.pdf$/i, '').replace(/^\[nhentai-\d+\]\s*/, '')
    const isCustom = galleryId ? 0 : 1

    let statInfo: { mtimeMs: number; size: number }
    try { statInfo = statSync(filePath) } catch { statInfo = { mtimeMs: Date.now(), size: 0 } }

    // Check if already exists by gallery ID or file path
    if (galleryId) {
      const row = db!.prepare('SELECT id, file_path, file_mtime, file_size FROM library_item WHERE gallery_id = ?').get(galleryId) as any
      if (row) {
        log(`SKIP (exists by gallery #${galleryId}) ${filePath}`)
        updateLibraryItemMtime(row.id, filePath, statInfo.mtimeMs, statInfo.size)
        markQueueItem(filePath, 'completed')
        return { status: 'skipped' }
      }
    }

    const rowByPath = db!.prepare('SELECT id FROM library_item WHERE file_path = ?').get(filePath) as any
    if (rowByPath) {
      log(`SKIP (exists by path) ${filePath}`)
      updateLibraryItemMtime(rowByPath.id, filePath, statInfo.mtimeMs, statInfo.size)
      markQueueItem(filePath, 'completed')
      return { status: 'skipped' }
    }

    // Generate thumbnail
    let thumbnailPath: string | null = null
    if (!db!.prepare('SELECT thumbnail_path FROM library_item WHERE file_path = ?').get(filePath)) {
      try { thumbnailPath = await generateThumbnail(filePath) } catch { /* */ }
    }

    const now = Date.now()
    const newId = insertLibraryItem({
      galleryId: galleryId || null, isCustom,
      customTitle: title,
      customTags: metadata.tags.length > 0 ? metadata.tags.join(', ') : null,
      customLanguage: metadata.language || null,
      customDate: metadata.creationDate ? metadata.creationDate.toISOString().split('T')[0] : null,
      customCoverPath: thumbnailPath, filePath, fileSize: statInfo.size, format: 'pdf',
      primaryArtist: artists[0] || 'Unknown', seriesName,
      seriesIndex: metadata.seriesIndex,
      language: metadata.language,
      publisher: metadata.publisher,
      description: metadata.description,
      thumbnailPath, fileMtime: statInfo.mtimeMs, now
    })

    for (let ai = 0; ai < artists.length; ai++) {
      insertArtist(newId, artists[ai], ai)
    }

    if (galleryId) {
      upsertGalleryStub(galleryId, title,
        metadata.creationDate ? Math.floor(metadata.creationDate.getTime() / 1000) : null,
        metadata.tags)
    }

    log(`NEW [${artists[0]}] "${title}" ${filePath}`)
    markQueueItem(filePath, 'completed')
    return { status: 'new', title, artist: artists[0], id: newId }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    log(`ERROR ${filePath}: ${errMsg}`)
    markQueueItem(filePath, 'failed', errMsg)
    return { status: 'error' }
  }
}

// ─── Main Scan Loop ──────────────────────────────────────────────────────────

async function runScan(): Promise<void> {
  if (!db) return

  // Phase 1: Discover PDFs
  send({ type: 'progress', current: 0, total: 0, status: 'Scanning library directory...' })
  log(`SCAN_START libraryRoot=${currentLibraryRoot}`)

  if (!existsSync(currentLibraryRoot)) {
    send({ type: 'error', message: `Library root does not exist: ${currentLibraryRoot}` })
    return
  }

  const pdfFiles = await walkPdfs(currentLibraryRoot)
  // Sort by modification time (newest first) so recent downloads are scanned first
  pdfFiles.sort((a, b) => {
    try { return statSync(b).mtimeMs - statSync(a).mtimeMs } catch { return 0 }
  })
  log(`DISCOVERY found ${pdfFiles.length} PDFs`)

  // Phase 2: Populate queue
  populateQueue(pdfFiles)
  resetPausedToPending()

  // Phase 3: Get pending items
  const queueItems = db.prepare(
    "SELECT file_path FROM scan_queue WHERE status = 'pending' OR status = 'scanning' ORDER BY priority DESC, id ASC"
  ).all() as Array<{ file_path: string }>

  const total = queueItems.length
  let processed = 0
  let newItems = 0
  let skippedItems = 0
  const errors: string[] = []

  send({ type: 'progress', current: 0, total, status: `Starting scan of ${total} items...` })

  // Phase 4: Process queue with batched newItem events
  let newItemBatch: Array<{ id: number; title: string; artist: string }> = []
  let lastBatchFlush = Date.now()
  const BATCH_SIZE = 25
  const BATCH_INTERVAL_MS = 500

  function flushNewItemBatch(): void {
    if (newItemBatch.length === 0) return
    send({ type: 'newItems', items: newItemBatch })
    newItemBatch = []
    lastBatchFlush = Date.now()
  }

  for (const item of queueItems) {
    // Check pause/cancel
    if (state === 'cancelled') {
      send({ type: 'cancelled' })
      log(`SCAN_CANCELLED processed=${processed} new=${newItems} skipped=${skippedItems}`)
      return
    }

    if (state === 'paused') {
      send({ type: 'paused' })
      log(`SCAN_PAUSED at ${processed}/${total}`)
      await new Promise<void>((resolve) => { resolvePause = resolve })
      resolvePause = null
      // Check if cancelled while paused (cast to avoid TS narrowing)
      if ((state as string) === 'cancelled') continue
      state = 'scanning'
      send({ type: 'progress', current: processed, total, status: 'Resuming scan...' })
      log(`SCAN_RESUMED at ${processed}/${total}`)
    }

    // Mark as scanning
    db.prepare("UPDATE scan_queue SET status = 'scanning' WHERE file_path = ?").run(item.file_path)

    const result = await processFile(item.file_path)

    if (result.status === 'new') {
      newItems++
      newItemBatch.push({ id: result.id!, title: result.title || 'Unknown', artist: result.artist || 'Unknown' })
      // Flush batch when it reaches size threshold or time interval
      if (newItemBatch.length >= BATCH_SIZE || Date.now() - lastBatchFlush >= BATCH_INTERVAL_MS) {
        flushNewItemBatch()
      }
    } else if (result.status === 'skipped') {
      skippedItems++
    } else {
      errors.push(`${item.file_path}: scan error`)
    }

    processed++

    // Batch progress
    if (processed % PROGRESS_INTERVAL === 0 || processed === total) {
      send({
        type: 'progress',
        current: processed, total,
        status: `Scanned ${processed}/${total} (${newItems} new, ${skippedItems} skipped)`
      })
    }
  }

  // Flush remaining new items
  flushNewItemBatch()

  // Phase 5: Detect removed items
  let removedItems = 0
  const allDbPaths = db.prepare('SELECT id, file_path FROM library_item').all() as Array<{ id: number; file_path: string }>
  const pdfSet = new Set(pdfFiles)
  for (const dbItem of allDbPaths) {
    if (!pdfSet.has(dbItem.file_path)) {
      db.prepare('DELETE FROM library_item WHERE id = ?').run(dbItem.id)
      removedItems++
    }
  }

  // Phase 6: Log scan
  db.prepare(`INSERT INTO library_scan_log (scanned_at, total_items, new_items, removed_items, errors_json)
    VALUES (?, ?, ?, ?, ?)`).run(Date.now(), total, newItems, removedItems, JSON.stringify(errors))

  log(`SCAN_COMPLETE total=${total} new=${newItems} skipped=${skippedItems} removed=${removedItems} errors=${errors.length}`)

  state = 'idle'
  send({
    type: 'complete',
    result: { total, newItems, removedItems, errors, cancelled: false }
  })
}

// ─── Worker Entry Point ──────────────────────────────────────────────────────

parentPort?.on('message', async (cmd: WorkerCommand) => {
  switch (cmd.type) {
    case 'start': {
      if (state === 'scanning') return
      state = 'scanning'
      currentLibraryRoot = cmd.libraryRoot

      // Open DB connection
      const { openWorkerConnection } = await import('../db/connection')
      db = openWorkerConnection()

      initLog()
      runScan().catch((err) => {
        log(`SCAN_ERROR ${String(err)}`)
        send({ type: 'error', message: String(err) })
        state = 'idle'
        db?.close()
        db = null
      }).finally(() => {
        // Clean up completed queue items
        db?.prepare("DELETE FROM scan_queue WHERE status = 'completed'").run()
        db?.close()
        db = null
        state = 'idle'
      })
      break
    }

    case 'pause':
      if (state === 'scanning') state = 'paused'
      break

    case 'resume':
      if (state === 'paused') {
        state = 'scanning'
        if (resolvePause) {
          resolvePause()
          resolvePause = null
        }
      }
      break

    case 'cancel':
      state = 'cancelled'
      // Resolve the pause gate so the loop can check the cancelled flag
      if (resolvePause) {
        resolvePause()
        resolvePause = null
      }
      break
  }
})
