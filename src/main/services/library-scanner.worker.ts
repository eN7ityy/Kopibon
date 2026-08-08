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
import type { Dirent } from 'fs'
import { join, relative, basename } from 'path'
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { homedir } from 'os'
import Database from 'better-sqlite3'
import { PDFDocument } from 'pdf-lib'

// ─── Types ───────────────────────────────────────────────────────────────────

type WorkerCommand =
  | { type: 'start'; libraryRoot: string; thumbnailDir?: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cancel' }

type WorkerEvent =
  | { type: 'progress'; current: number; total: number; status: string }
  | { type: 'newItem'; item: { id: number; title: string; artist: string } }
  | { type: 'newItems'; items: Array<{ id: number; title: string; artist: string }> }
  | {
      type: 'complete'
      result: {
        total: number
        newItems: number
        removedItems: number
        errors: string[]
        cancelled: boolean
        /** Set when the removal pass was skipped for safety; shown to the user. */
        removalSkippedReason?: string | null
      }
    }
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
// The main process sets KOPIBON_DATA_DIR to app.getPath('userData') and workers
// inherit it; without it the homedir fallback would diverge from Electron's
// userData on Windows (AppData vs .config).
const DATA_DIR = process.env.KOPIBON_DATA_DIR || join(homedir(), '.config', 'kopibon')
const LOG_DIR = join(DATA_DIR, 'logs')

// ─── State ───────────────────────────────────────────────────────────────────

let state: 'idle' | 'scanning' | 'paused' | 'cancelled' = 'idle'
let db: Database.Database | null = null
let currentLibraryRoot = ''
let resolvePause: (() => void) | null = null
/*
 * Supplied by the main process (userData/thumbnails).
 *
 * The fallback used to be tmpdir, which is where this went wrong: on a machine
 * where /tmp is a tmpfs, every cached thumbnail vanished on reboot while the
 * database still held valid-looking paths to them. A fallback must not be
 * volatile — it now matches the log directory convention above.
 */
let currentThumbnailDir = join(DATA_DIR, 'thumbnails')

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

// calibre:series comes in two shapes: the canonical pikepdf/Kavita form with
// rdf:parseType="Resource" wrapping an <rdf:value>, and a legacy flat form.
// Try the nested form first — the flat pattern cannot match it at all.
const XMP_SERIES_NESTED_REGEX =
  /<calibre:series[^>]*>[\s\S]*?<rdf:value[^>]*>([^<]+)<\/rdf:value>/i
const XMP_SERIES_REGEX = /<calibre:series[^>]*>([^<]+)<\/calibre:series>/i
const XMP_SERIES_INDEX_REGEX = /<ns0:series_index[^>]*>([^<]+)<\/ns0:series_index>/i
const XMP_SERIES_INDEX_ALT_REGEX = /<calibreSI:series_index[^>]*>([^<]+)<\/calibreSI:series_index>/i
// dc:language is an rdf:Bag (calibre/Kavita form); take the first rdf:li.
// The flat form is kept as a fallback for files written by other tools.
const XMP_LANGUAGE_BAG_REGEX =
  /<dc:language[^>]*>[\s\S]*?<rdf:li[^>]*>([^<]+)<\/rdf:li>/i
const XMP_LANGUAGE_REGEX = /<dc:language[^>]*>([^<\s][^<]*)<\/dc:language>/i
const XMP_PUBLISHER_REGEX = /<dc:publisher[^>]*>[\s\S]*?<rdf:li[^>]*>([^<]*)<\/rdf:li>/i
// dc:description is written as <rdf:Alt><rdf:li xml:lang="x-default">text.
// Matching the outer element captured the whole rdf wrapper as the "text",
// which then got re-embedded on the next metadata edit and nested further
// every time. Prefer the inner rdf:li, fall back to a plain text child.
const XMP_DESCRIPTION_ALT_REGEX =
  /<dc:description[^>]*>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/i
const XMP_DESCRIPTION_REGEX = /<dc:description[^>]*>([^<]*)<\/dc:description>/i

// XMP fields needed for pikepdf-processed files (no docinfo)
const XMP_TITLE_REGEX = /<dc:title[^>]*>[\s\S]*?<rdf:li[^>]*>([^<]+)<\/rdf:li>/i
const XMP_CREATOR_REGEX = /<dc:creator[^>]*>[\s\S]*?<rdf:li[^>]*>([^<]+)<\/rdf:li>/gi
const XMP_DATE_REGEX = /<dc:date[^>]*>([^<]+)<\/dc:date>/i
const XMP_ISBN_REGEX = /<pdfx:isbn[^>]*>(\d+)<\/pdfx:isbn>/i
/**
 * Decode XML character entities.
 *
 * The XMP packet is read with regexes rather than a real parser, so entities
 * arrive verbatim — a correctly-escaped title like "A &amp; B" would otherwise
 * be stored in the DB with the entity still in it.
 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&') // must come last
}

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

    // Every value below comes out of XML, so entities must be decoded.
    const text = (raw: string): string => decodeXmlEntities(raw.trim())

    // calibre:series (F3) — nested <rdf:value> form first, then legacy flat
    const seriesNested = xmp.match(XMP_SERIES_NESTED_REGEX)
    if (seriesNested) {
      result.seriesName = text(seriesNested[1])
    } else {
      const seriesM = xmp.match(XMP_SERIES_REGEX)
      if (seriesM) result.seriesName = text(seriesM[1])
    }

    // series_index in calibre namespace (F2)
    const siM = xmp.match(XMP_SERIES_INDEX_REGEX)
    if (siM) result.seriesIndex = siM[1].trim()
    else {
      const siAlt = xmp.match(XMP_SERIES_INDEX_ALT_REGEX)
      if (siAlt) result.seriesIndex = siAlt[1].trim()
    }

    // dc:language (F4) — rdf:Bag form first, then flat text child
    const langBag = xmp.match(XMP_LANGUAGE_BAG_REGEX)
    if (langBag) {
      result.language = text(langBag[1])
    } else {
      const langM = xmp.match(XMP_LANGUAGE_REGEX)
      if (langM) result.language = text(langM[1])
    }

    // dc:publisher (F5)
    const pubM = xmp.match(XMP_PUBLISHER_REGEX)
    if (pubM) result.publisher = text(pubM[1])

    // dc:description (F6) — rdf:Alt form first, then plain text child
    const descAlt = xmp.match(XMP_DESCRIPTION_ALT_REGEX)
    if (descAlt) {
      result.description = text(descAlt[1])
    } else {
      const descM = xmp.match(XMP_DESCRIPTION_REGEX)
      if (descM) result.description = text(descM[1])
    }

    // dc:title — fallback for pikepdf-processed files (no docinfo)
    const titleM = xmp.match(XMP_TITLE_REGEX)
    if (titleM) result.xmpTitle = text(titleM[1])

    // dc:creator — fallback for pikepdf-processed files
    const creators: string[] = []
    let creatorM: RegExpExecArray | null
    while ((creatorM = XMP_CREATOR_REGEX.exec(xmp)) !== null) {
      creators.push(text(creatorM[1]))
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

// ─── CBZ Metadata ────────────────────────────────────────────────────────────

/**
 * Extract metadata from a ComicInfo.xml inside a CBZ archive.
 *
 * Uses yauzl to stream the single entry without loading the whole archive
 * into memory. Returns the same PdfMetadata shape so processFile() can
 * dispatch on extension with no downstream changes.
 */
async function extractCbzMetadata(filePath: string): Promise<PdfMetadata> {
  const metadata: PdfMetadata = {
    title: null, authors: [], tags: [], galleryId: null, creationDate: null,
    seriesName: null, seriesIndex: null, language: null, publisher: null, description: null
  }

  try {
    const { open } = await import('yauzl')
    const { parseComicInfoXml } = await import('./comicinfo')

    const xml = await new Promise<string>((resolve, reject) => {
      open(filePath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err)
        if (!zipfile) return reject(new Error('Failed to open zip'))

        let found = false
        zipfile.readEntry()

        zipfile.on('entry', (entry) => {
          // ComicInfo.xml at the root — first entry per §1.4
          if (entry.fileName === 'ComicInfo.xml') {
            found = true
            const chunks: Buffer[] = []
            zipfile.openReadStream(entry, (openErr, readStream) => {
              if (openErr) return reject(openErr)
              if (!readStream) return reject(new Error('No read stream'))
              readStream.on('data', (chunk: Buffer) => chunks.push(chunk))
              readStream.on('end', () => {
                const xmlStr = Buffer.concat(chunks).toString('utf-8')
                resolve(xmlStr)
              })
              readStream.on('error', reject)
            })
          } else {
            zipfile.readEntry()
          }
        })

        zipfile.on('end', () => {
          if (!found) resolve('')
        })

        zipfile.on('error', reject)
      })
    })

    if (!xml) return metadata

    const parsed = parseComicInfoXml(xml)

    metadata.title = parsed.title || null
    metadata.authors = parsed.writers || []
    metadata.tags = [...(parsed.genres || []), ...(parsed.tags || [])]
    // §4.3 always writes Series (falls back to title). On read, treat Series==Title
    // as "no real series" to avoid fabricating phantom one-item series on rescan.
    metadata.seriesName =
      parsed.series && parsed.title && parsed.series !== parsed.title
        ? parsed.series
        : null
    metadata.seriesIndex = parsed.volume ?? null
    metadata.language = parsed.languageIso || null
    metadata.publisher = parsed.publisher || null
    metadata.description = parsed.summary || null

    // Gallery ID recovery — §2.1.6 precedence: Web > Notes > filename
    if (parsed.webUrl) {
      const webMatch = parsed.webUrl.match(/nhentai\.net\/g\/(\d+)/)
      if (webMatch) metadata.galleryId = parseInt(webMatch[1], 10)
    }
    if (!metadata.galleryId && parsed.notes) {
      const notesMatch = parsed.notes.match(/nhentai gallery (\d+)/i)
      if (notesMatch) metadata.galleryId = parseInt(notesMatch[1], 10)
    }
    // filename fallback is handled by the caller (extractIdFromFilename)

    return metadata
  } catch {
    return metadata
  }
}

/**
 * Generate a thumbnail for a CBZ file by extracting the first image entry
 * and resizing with sharp.
 */
/**
 * Regenerate a thumbnail for an existing row when the cached file is gone.
 *
 * The three "already exists" paths below all return early, before the
 * generation step that runs for new files — so a lost thumbnail was permanent:
 * rescanning could never bring it back. That is what left a converted library
 * with no covers, because the cached files had been written to /tmp and cleared.
 *
 * Cheap in the normal case: one indexed lookup and one existsSync per file, and
 * generation only when there is genuinely nothing there.
 */
async function repairThumbnail(rowId: number, filePath: string): Promise<void> {
  try {
    const row = db!
      .prepare('SELECT custom_cover_path FROM library_item WHERE id = ?')
      .get(rowId) as { custom_cover_path: string | null } | undefined
    if (row?.custom_cover_path && existsSync(row.custom_cover_path)) return

    const isCbz = filePath.toLowerCase().endsWith('.cbz')
    const made = isCbz ? await generateCbzThumbnail(filePath) : await generateThumbnail(filePath)
    if (!made) return

    // Both columns, kept in step: `custom_cover_path` is what the UI reads and
    // `thumbnail_path` is what this scanner writes, and they had drifted apart.
    db!
      .prepare('UPDATE library_item SET custom_cover_path = ?, thumbnail_path = ? WHERE id = ?')
      .run(made, made, rowId)
    log(`THUMBNAIL regenerated ${filePath}`)
  } catch {
    /* a missing cover is cosmetic; never fail a scan over it */
  }
}

/**
 * Cover size.
 *
 * Was 300x400, which a card renders at up to ~260 CSS px and the detail panel at
 * ~460 — so on a HiDPI display the cover was being upscaled two to three times
 * and looked soft. Source pages are ~1280x1803, so the detail was always there.
 *
 * Measured over 40 real covers: 300x400 averages 30 KB (136 MB across this
 * library), 600x800 averages 98 KB (445 MB). Doubling the edge is the useful
 * step; 800x1067 costs 699 MB for detail nothing displays at.
 */
const THUMB_WIDTH = 600
const THUMB_HEIGHT = 800
const THUMB_QUALITY = 82

async function generateCbzThumbnail(filePath: string): Promise<string | null> {
  const thumbDir = currentThumbnailDir
  if (!existsSync(thumbDir)) {
    try { mkdirSync(thumbDir, { recursive: true }) } catch { return null }
  }
  const { createHash } = await import('crypto')
  const hash = createHash('sha1').update(filePath).digest('hex').slice(0, 16)
  const thumbPath = join(thumbDir, `${hash}.jpg`)
  if (existsSync(thumbPath)) return thumbPath

  try {
    const { open } = await import('yauzl')
    const sharp = (await import('sharp')).default

    const imageBuffer = await new Promise<Buffer | null>((resolve, reject) => {
      open(filePath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err)
        if (!zipfile) return reject(new Error('Failed to open zip'))

        zipfile.readEntry()

        zipfile.on('entry', (entry) => {
          if (entry.fileName === 'ComicInfo.xml') {
            // Skip metadata — look for first image
            zipfile.readEntry()
            return
          }
          // First non-ComicInfo entry — should be an image
          const chunks: Buffer[] = []
          zipfile.openReadStream(entry, (openErr, readStream) => {
            if (openErr) return reject(openErr)
            if (!readStream) return reject(new Error('No read stream'))
            readStream.on('data', (chunk: Buffer) => chunks.push(chunk))
            readStream.on('end', () => resolve(Buffer.concat(chunks)))
            readStream.on('error', reject)
          })
        })

        zipfile.on('end', () => resolve(null))
        zipfile.on('error', reject)
      })
    })

    if (!imageBuffer) return null

    await sharp(imageBuffer)
      .resize(THUMB_WIDTH, THUMB_HEIGHT, { fit: 'inside' })
      .jpeg({ quality: THUMB_QUALITY })
      .toFile(thumbPath)

    return thumbPath
  } catch {
    return null
  }
}

// ─── Thumbnail Generation ────────────────────────────────────────────────────

async function generateThumbnail(pdfPath: string): Promise<string | null> {
  const thumbDir = currentThumbnailDir
  if (!existsSync(thumbDir)) {
    try { mkdirSync(thumbDir, { recursive: true }) } catch { return null }
  }
  // Content-addressed by full path. A 32-bit hash collides often enough at
  // library scale to show the wrong cover, so use a real digest.
  const hash = createHash('sha1').update(pdfPath).digest('hex').slice(0, 16)
  const thumbPath = join(thumbDir, `${hash}.jpg`)
  if (existsSync(thumbPath)) return thumbPath

  try {
    await new Promise<void>((resolve, reject) => {
      execFile('pdftoppm', [
        // -scale-to sets the longest edge, so this matches `fit: 'inside'`
        // above for a portrait page. At 300 it yielded ~212x300, which is why
        // PDF covers looked worse than CBZ ones.
        '-f', '1', '-l', '1', '-singlefile', '-jpeg', '-scale-to', String(THUMB_HEIGHT),
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

interface WalkResult {
  files: string[]
  /** Directories that could not be read. Non-empty means the walk is partial. */
  failedDirs: Array<{ dir: string; error: string }>
}

/**
 * Recursively collect PDF and CBZ paths under `dir`.
 *
 * Read failures are reported rather than swallowed. A partial walk used to be
 * indistinguishable from a complete one, and the removal pass then deleted
 * every library row whose file "wasn't found" — so one unreadable directory on
 * a network share silently dropped rows from the database.
 */
async function walkLibraryFiles(dir: string): Promise<WalkResult> {
  const files: string[] = []
  const failedDirs: Array<{ dir: string; error: string }> = []

  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    failedDirs.push({ dir, error: err instanceof Error ? err.message : String(err) })
    return { files, failedDirs }
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    // Exclude special directories — _originals holds archived originals (§1.3)
    if (entry.name === '_Unsorted' || entry.name === '_migration_staging' || entry.name === '_originals') continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await walkLibraryFiles(fullPath)
      files.push(...nested.files)
      failedDirs.push(...nested.failedDirs)
    } else if (entry.isFile()) {
      const lower = entry.name.toLowerCase()
      if (lower.endsWith('.pdf') || lower.endsWith('.cbz')) {
        files.push(fullPath)
      }
    }
  }

  return { files, failedDirs }
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

/**
 * Requeue anything left incomplete by a previous run.
 *
 * 'scanning' rows are from a scan that stopped mid-item. 'failed' rows were
 * previously left alone forever: populateQueue uses INSERT OR IGNORE and the
 * work query only selects pending/scanning, so a file that errored once was
 * invisible to every later scan. Pressing Rescan should retry it.
 */
function requeueIncompleteItems(): number {
  if (!db) return 0
  const result = db
    .prepare("UPDATE scan_queue SET status = 'pending' WHERE status IN ('scanning', 'failed')")
    .run()
  return result.changes
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
    // Dispatch by file extension — PDF or CBZ
    const isCbz = filePath.toLowerCase().endsWith('.cbz')
    const format = isCbz ? 'cbz' : 'pdf'
    const metadata = isCbz ? await extractCbzMetadata(filePath) : await extractPdfMetadata(filePath)

    let galleryId = metadata.galleryId
    if (!galleryId) galleryId = extractIdFromFilename(filePath)

    const relPath = relative(currentLibraryRoot, filePath)
    const parts = relPath.replace(/\\/g, '/').split('/')
    const primaryArtist = parts[0] || 'Unknown'
    // Prefer XMP/Keywords series name over directory-derived
    const dirSeriesName = parts.length >= 3 ? parts[1] : null
    const seriesName = metadata.seriesName || dirSeriesName
    const artists = metadata.authors.length > 0 ? metadata.authors : [primaryArtist]
    const extRe = isCbz ? /\.cbz$/i : /\.pdf$/i
    const title = metadata.title || basename(filePath).replace(extRe, '').replace(/^\[nhentai-\d+\]\s*/, '')
    const isCustom = galleryId ? 0 : 1

    let statInfo: { mtimeMs: number; size: number }
    try { statInfo = statSync(filePath) } catch { statInfo = { mtimeMs: Date.now(), size: 0 } }

    // Check if already exists by gallery ID or file path
    if (galleryId) {
      const row = db!.prepare('SELECT id, file_path, file_mtime, file_size FROM library_item WHERE gallery_id = ?').get(galleryId) as any
      if (row) {
        log(`SKIP (exists by gallery #${galleryId}) ${filePath}`)
        updateLibraryItemMtime(row.id, filePath, statInfo.mtimeMs, statInfo.size)
        await repairThumbnail(row.id, filePath)
        markQueueItem(filePath, 'completed')
        return { status: 'skipped' }
      }
    }

    const rowByPath = db!.prepare('SELECT id FROM library_item WHERE file_path = ?').get(filePath) as any
    if (rowByPath) {
      log(`SKIP (exists by path) ${filePath}`)
      updateLibraryItemMtime(rowByPath.id, filePath, statInfo.mtimeMs, statInfo.size)
      await repairThumbnail(rowByPath.id, filePath)
      markQueueItem(filePath, 'completed')
      return { status: 'skipped' }
    }

    // Generate thumbnail — PDF uses pdftoppm, CBZ uses sharp
    let thumbnailPath: string | null = null
    if (!db!.prepare('SELECT thumbnail_path FROM library_item WHERE file_path = ?').get(filePath)) {
      try {
        thumbnailPath = isCbz ? await generateCbzThumbnail(filePath) : await generateThumbnail(filePath)
      } catch { /* */ }
    }

    const now = Date.now()
    const newId = insertLibraryItem({
      galleryId: galleryId || null, isCustom,
      customTitle: title,
      customTags: metadata.tags.length > 0 ? metadata.tags.join(', ') : null,
      customLanguage: metadata.language || null,
      customDate: metadata.creationDate ? metadata.creationDate.toISOString().split('T')[0] : null,
      customCoverPath: thumbnailPath, filePath, fileSize: statInfo.size, format,
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

  const walk = await walkLibraryFiles(currentLibraryRoot)
  const discoveredFiles = walk.files
  // Sort by modification time (newest first) so recent downloads are scanned first
  discoveredFiles.sort((a, b) => {
    try { return statSync(b).mtimeMs - statSync(a).mtimeMs } catch { return 0 }
  })
  log(`DISCOVERY found ${discoveredFiles.length} files`)
  for (const failure of walk.failedDirs) {
    log(`DISCOVERY_ERROR ${failure.dir}: ${failure.error}`)
  }

  // Phase 2: Populate queue
  populateQueue(discoveredFiles)
  const requeued = requeueIncompleteItems()
  if (requeued > 0) log(`QUEUE requeued ${requeued} incomplete/failed item(s)`)

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
  //
  // Deleting rows because a file "wasn't discovered" is only safe if discovery
  // was actually complete. Two guards decide that, and either one skips the
  // removal pass entirely rather than risking the library metadata.
  let removedItems = 0
  let removalSkippedReason: string | null = null

  if (walk.failedDirs.length > 0) {
    const sample = walk.failedDirs
      .slice(0, 3)
      .map((f) => f.dir)
      .join(', ')
    removalSkippedReason =
      `${walk.failedDirs.length} directory/directories could not be read ` +
      `(${sample}${walk.failedDirs.length > 3 ? ', …' : ''}), so files may exist that this ` +
      `scan did not see. Skipped removing missing items to avoid deleting metadata.`
  } else {
    // Backstop for a readable-but-wrong root (e.g. an empty mountpoint where
    // the share failed to mount): a sudden collapse in discovered files is far
    // more likely to be an environment problem than a real mass deletion.
    const lastLog = db
      .prepare('SELECT total_items FROM library_scan_log ORDER BY scanned_at DESC LIMIT 1')
      .get() as { total_items: number } | undefined
    const previousTotal = lastLog?.total_items ?? 0
    if (previousTotal >= 50 && discoveredFiles.length < previousTotal * 0.8) {
      removalSkippedReason =
        `Discovered ${discoveredFiles.length} files but the last scan saw ${previousTotal} ` +
        `(a drop of over 20%). Skipped removing missing items — check that the library ` +
        `path is correct and fully mounted, then rescan.`
    }
  }

  if (removalSkippedReason) {
    log(`REMOVAL_SKIPPED ${removalSkippedReason}`)
    errors.push(removalSkippedReason)
  }

  const allDbPaths = removalSkippedReason
    ? []
    : (db.prepare('SELECT id, file_path FROM library_item').all() as Array<{ id: number; file_path: string }>)
  const discoveredSet = new Set(discoveredFiles)
  const gone = allDbPaths.filter((dbItem) => !discoveredSet.has(dbItem.file_path))

  if (gone.length > 0) {
    // Nothing declares a foreign key, so artist rows must be removed by hand
    // or they linger as orphans and pollute the artist filter list.
    const delArtists = db.prepare('DELETE FROM library_item_artist WHERE library_item_id = ?')
    const delItem = db.prepare('DELETE FROM library_item WHERE id = ?')
    const removeAll = db.transaction((rows: Array<{ id: number }>) => {
      for (const row of rows) {
        delArtists.run(row.id)
        delItem.run(row.id)
      }
    })
    removeAll(gone)
    removedItems = gone.length
    log(`REMOVED ${removedItems} item(s) no longer on disk`)
  }

  // Phase 6: Log scan
  db.prepare(`INSERT INTO library_scan_log (scanned_at, total_items, new_items, removed_items, errors_json)
    VALUES (?, ?, ?, ?, ?)`).run(Date.now(), total, newItems, removedItems, JSON.stringify(errors))

  log(`SCAN_COMPLETE total=${total} new=${newItems} skipped=${skippedItems} removed=${removedItems} errors=${errors.length}`)

  state = 'idle'
  send({
    type: 'complete',
    result: { total, newItems, removedItems, errors, cancelled: false, removalSkippedReason }
  })
}

// ─── Worker Entry Point ──────────────────────────────────────────────────────

parentPort?.on('message', async (cmd: WorkerCommand) => {
  switch (cmd.type) {
    case 'start': {
      if (state === 'scanning') return
      state = 'scanning'
      currentLibraryRoot = cmd.libraryRoot
      if (cmd.thumbnailDir) currentThumbnailDir = cmd.thumbnailDir

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
