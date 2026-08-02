/**
 * applyMetadata — Format-aware metadata dispatcher.
 *
 * Routes metadata writes to the correct handler based on the item's format:
 * - PDF: uses pikepdf (via metadata.worker.ts / xmp-inject.ts)
 * - CBZ: rewrites ComicInfo.xml inside the archive (§7.4)
 *
 * This is the single entry point for all metadata write operations so that
 * no caller can forget the format branch (§2.2).
 */

import { applyXmpWithPikepdf, type XmpMetadata } from './xmp-inject'
import { tempSiblingPath } from './temp-path'
import { buildComicInfoXml, type ComicInfoMetadata } from './comicinfo'
import { open } from 'yauzl'
import * as yazl from 'yazl'
import { createWriteStream, renameSync, unlinkSync } from 'fs'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MetadataPayload {
  title: string
  creators: string[]
  tags: string[]
  nhentaiId?: number | null
  seriesName?: string | null
  seriesIndex?: number | null
  description?: string | null
  publisher?: string | null
  language?: string | null
  date?: string | null
}

// ─── Artist/group/publisher logic ─────────────────────────────────────────────
// Reused in download-pdf.worker.ts and sync.worker.ts — extracted here
// so there is a single source of truth (§4.5).

export function resolveCreatorsAndPublisher(
  artistNames: string[],
  groupNames: string[],
  metaPublisher?: string | null
): { creators: string[]; publisher: string | null } {
  const hasArtist = artistNames.length > 0
  const hasGroup = groupNames.length > 0
  const publisher = hasGroup ? groupNames[0] : metaPublisher || null

  let creators: string[]
  if (hasArtist) {
    creators = artistNames
  } else if (hasGroup) {
    creators = groupNames
  } else {
    creators = ['Unknown']
  }

  return { creators, publisher }
}

// ─── ComicInfoMetadata builder ───────────────────────────────────────────────

/** Return a valid Date or undefined — rejects Invalid Date and zero-length strings. */
function validateDate(dateStr: string | null | undefined): Date | undefined {
  if (!dateStr) return undefined
  const d = new Date(dateStr)
  return Number.isFinite(d.getTime()) ? d : undefined
}

function buildComicInfoMeta(payload: MetadataPayload): ComicInfoMetadata {
  return {
    title: payload.title,
    series: payload.seriesName || payload.title, // §4.3 — always write Series
    volume: payload.seriesIndex ?? undefined,
    summary: payload.description || undefined,
    writers: payload.creators,
    publisher: payload.publisher || undefined,
    genres: [], // nhentai category tags — not typically available via this path
    tags: payload.tags,
    characters: [],
    webUrl: payload.nhentaiId ? `https://nhentai.net/g/${payload.nhentaiId}` : undefined,
    notes: payload.nhentaiId
      ? `Tagged by Doujin Downloader — nhentai gallery ${payload.nhentaiId}`
      : undefined,
    // Placeholder only. The CBZ rewriter derives the real count from the
    // archive's own entries, so no caller has to supply it.
    pageCount: 0,
    languageIso: payload.language || undefined,
    releaseDate: validateDate(payload.date),
    ageRating: 'Adults Only 18+',
    manga: 'YesAndRightToLeft',
    seriesGroup: undefined
  }
}

// ─── ComicInfo Rewrite (§7.4) ────────────────────────────────────────────────

/** Entries that are page images (i.e. everything except the metadata file). */
const isImageEntry = (name: string): boolean =>
  name !== 'ComicInfo.xml' && /\.(jpe?g|png|gif|bmp|webp|avif|jxl)$/i.test(name)

/**
 * List the entry names in a CBZ without inflating any of them.
 *
 * yauzl reads the central directory, so this is cheap even on a large archive.
 * Needed as a first pass so we know the page count before writing ComicInfo.xml
 * — which must be the *first* entry in the output.
 */
function listEntryNames(filePath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    open(filePath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err)
      if (!zip) return reject(new Error('Failed to open archive'))
      const names: string[] = []
      zip.readEntry()
      zip.on('entry', (entry) => {
        names.push(entry.fileName)
        zip.readEntry()
      })
      zip.on('end', () => resolve(names))
      zip.on('error', reject)
    })
  })
}

/**
 * Rewrite ComicInfo.xml inside an existing CBZ.
 *
 * A ZIP entry cannot be replaced in place, so the archive is rebuilt:
 *
 *   1. Enumerate entries (cheap) to get an accurate page count.
 *   2. Write the new ComicInfo.xml FIRST, preserving the invariant that freshly
 *      generated archives hold (§1.4). Appending it last would leave edited
 *      files structurally different from generated ones.
 *   3. Copy every other entry across, one at a time, waiting for each source
 *      stream to drain before advancing yauzl. Advancing early (the previous
 *      implementation) can interleave reads and corrupt the output.
 *   4. Rename over the original only after a clean finish; remove the partial
 *      file on any failure.
 *
 * Images are STORED in our archives, so copying re-stores them without any
 * recompression.
 */
async function rewriteComicInfoInCbz(
  filePath: string,
  ciMeta: ComicInfoMetadata
): Promise<void> {
  // Same 255-byte limit as the CBZ writer: the file that broke conversion
  // would have broken a metadata rewrite on sync for the same reason.
  const partPath = tempSiblingPath(filePath)

  try {
    // ── Pass 1: entry names, so PageCount reflects reality ──────────────────
    const names = await listEntryNames(filePath)
    const imageCount = names.filter(isImageEntry).length
    const ciXml = buildComicInfoXml({
      ...ciMeta,
      // The caller cannot know this; derive it rather than trusting the payload.
      pageCount: imageCount > 0 ? imageCount : ciMeta.pageCount
    })

    // ── Pass 2: rebuild, ComicInfo first, entries copied sequentially ───────
    await new Promise<void>((resolve, reject) => {
      const zipfile = new yazl.ZipFile()
      const output = createWriteStream(partPath)
      let settled = false
      const fail = (e: unknown): void => {
        if (settled) return
        settled = true
        reject(e instanceof Error ? e : new Error(String(e)))
      }

      output.on('error', fail)
      output.on('finish', () => {
        if (!settled) {
          settled = true
          resolve()
        }
      })
      zipfile.outputStream.on('error', fail)
      zipfile.outputStream.pipe(output)

      // ComicInfo.xml first
      zipfile.addBuffer(Buffer.from(ciXml, 'utf-8'), 'ComicInfo.xml', { compress: false })

      open(filePath, { lazyEntries: true }, (err, sourceZip) => {
        if (err) return fail(err)
        if (!sourceZip) return fail(new Error('Failed to open archive'))

        sourceZip.on('error', fail)
        sourceZip.on('end', () => zipfile.end())

        sourceZip.on('entry', (entry) => {
          // Skip the old metadata file and any directory entries
          if (entry.fileName === 'ComicInfo.xml' || entry.fileName.endsWith('/')) {
            sourceZip.readEntry()
            return
          }

          sourceZip.openReadStream(entry, (openErr, readStream) => {
            if (openErr) return fail(openErr)
            if (!readStream) return fail(new Error('No read stream for ' + entry.fileName))

            readStream.on('error', fail)
            // Only advance once this entry has been fully consumed by yazl.
            readStream.on('end', () => sourceZip.readEntry())
            zipfile.addReadStream(readStream, entry.fileName, { compress: false })
          })
        })

        sourceZip.readEntry()
      })
    })

    renameSync(partPath, filePath)
  } catch (err) {
    // Never leave a partial archive behind — the scanner would ingest it.
    try {
      unlinkSync(partPath)
    } catch {
      /* nothing to clean up */
    }
    throw err
  }
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Apply metadata to a library item, dispatching by format.
 *
 * @param filePath - Path to the file
 * @param format - 'pdf' or 'cbz'
 * @param payload - Metadata to apply
 * @returns Promise resolving to success status
 */
export async function applyMetadata(
  filePath: string,
  format: string,
  payload: MetadataPayload
): Promise<{ success: boolean; error?: string }> {
  if (format === 'cbz') {
    try {
      const ciMeta = buildComicInfoMeta(payload)
      await rewriteComicInfoInCbz(filePath, ciMeta)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }

  // Default: PDF path (pikepdf)
  const xmpMeta: XmpMetadata = {
    title: payload.title,
    creators: payload.creators,
    tags: payload.tags,
    nhentaiId: payload.nhentaiId,
    seriesName: payload.seriesName,
    seriesIndex: payload.seriesIndex,
    description: payload.description,
    publisher: payload.publisher,
    language: payload.language,
    date: payload.date
  }

  return applyXmpWithPikepdf(filePath, xmpMeta)
}
