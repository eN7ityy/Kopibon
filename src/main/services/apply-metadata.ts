/**
 * applyMetadata — the format-aware write dispatcher.
 *
 * The single entry point for editing metadata on a file that already exists, so
 * that no caller can forget the format branch:
 *
 * - PDF: docinfo nuked and an XMP packet injected, via pikepdf
 * - CBZ: ComicInfo.xml rewritten inside the archive
 *
 * Both sides start from the same `FileMetadata` and go through the same two
 * mappers, so a CBZ and a PDF of the same gallery describe it identically.
 *
 * It takes a `FileMetadata` rather than a flat payload on purpose. The flat
 * shape it used to take had no room for parodies, categories or characters, so
 * every edit silently stripped them from the file — and it had no room for the
 * series either, so syncing a series member erased its Kavita grouping.
 */

import { applyXmpWithPikepdf } from './xmp-inject'
import { tempSiblingPath } from './temp-path'
import { buildComicInfoXml } from './metadata/mappers'
import type { FileMetadata } from './metadata/file-metadata'
import { open } from 'yauzl'
import * as yazl from 'yazl'
import { createWriteStream, renameSync, unlinkSync } from 'fs'

// ─── Artist/group/publisher logic ─────────────────────────────────────────────
// Kept here because callers outside the metadata pipeline use it to fill in a
// library row. The mapper applies the same rule via resolveWriters().

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
 * How many page images a CBZ holds.
 *
 * `library_item` has no page-count column, and only 63 of 4,635 rows can join
 * one from the cached gallery table — scanner-created gallery rows store zero.
 * The archive itself is the only source that answers for every file.
 *
 * Cheap: yauzl reads the central directory, so nothing is inflated.
 */
export async function countCbzPages(filePath: string): Promise<number> {
  const names = await listEntryNames(filePath)
  return names.filter(isImageEntry).length
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
async function rewriteComicInfoInCbz(filePath: string, meta: FileMetadata): Promise<void> {
  // Same 255-byte limit as the CBZ writer: the file that broke conversion
  // would have broken a metadata rewrite on sync for the same reason.
  const partPath = tempSiblingPath(filePath)

  try {
    // ── Pass 1: entry names, so PageCount reflects reality ──────────────────
    const names = await listEntryNames(filePath)
    const imageCount = names.filter(isImageEntry).length
    const ciXml = buildComicInfoXml({
      ...meta,
      // The caller cannot know this; derive it rather than trusting the payload.
      pageCount: imageCount > 0 ? imageCount : meta.pageCount
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
 * @param meta - Canonical metadata to write
 * @returns Promise resolving to success status
 */
export async function applyMetadata(
  filePath: string,
  format: string,
  meta: FileMetadata
): Promise<{ success: boolean; error?: string }> {
  if (format === 'cbz') {
    try {
      await rewriteComicInfoInCbz(filePath, meta)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }

  // Default: PDF path (pikepdf)
  return applyXmpWithPikepdf(filePath, meta)
}
