/**
 * CBZ Generator — build the archive.
 *
 * Creates a CBZ file (ZIP of images + ComicInfo.xml at root) with:
 * - ComicInfo.xml written as the first entry (§1.4)
 * - Images stored with store: true (no deflate — JPEGs don't compress) (§1.4)
 * - Zero-padded filenames (0001.jpg, 0002.jpg, …) for lexicographic ordering
 * - .part then rename discipline (§6)
 * - Optional quality/maxDimension transforms using sharp
 */

import * as yazl from 'yazl'
import { tempSiblingPath } from './temp-path'
import { createWriteStream, renameSync, statSync, mkdirSync, rmSync } from 'fs'
import { basename, join } from 'path'
import { buildComicInfoXml } from './metadata/mappers'
import type { FileMetadata } from './metadata/file-metadata'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CbzOptions {
  /** JPEG quality 1-95, or null to embed source images untouched. */
  quality: number | null
  /** Longest-edge cap in px, or null for no resizing. */
  maxDimension: number | null
  /**
   * Where to put re-encoded pages while building the archive.
   *
   * Only used when a transform is requested. Pages are written to disk rather
   * than held as buffers because a long book would otherwise mean hundreds of
   * megabytes resident at once. Callers should pass a directory under
   * `app.getPath('userData')`; without one, a sibling of the output is used,
   * which keeps the writes on the same filesystem as the result.
   */
  scratchDir?: string
}

// ─── Generator ───────────────────────────────────────────────────────────────

/**
 * Generate a CBZ file from a list of image paths.
 *
 * @param imagePaths - Paths to image files in page order
 * @param outputPath - Destination path (will get .part suffix during write)
 * @param metadata - Canonical file metadata; the page count is overridden
 * @param options - Quality/maxDimension options
 * @param onProgress - Optional progress callback
 * @returns The final output path
 */
export async function generateCbz(
  imagePaths: string[],
  outputPath: string,
  metadata: FileMetadata,
  options: CbzOptions,
  onProgress?: (current: number, total: number) => void
): Promise<string> {
  // Not `outputPath + '.part'`: a 251-byte name plus the suffix is 256, over
  // the 255-byte limit, and one real library file sat exactly there.
  const partPath = tempSiblingPath(outputPath)

  // Step 1: Build ComicInfo with accurate page count. Derived rather than
  // trusted: the caller counted something, we are about to write these pages.
  const ciXml = buildComicInfoXml({ ...metadata, pageCount: imagePaths.length })

  // Step 2: Re-encode pages, if asked.
  //
  // This was previously ignored: the options argument was `_options` and every
  // page was stored verbatim, so a CBZ built from a folder of images came out
  // exactly as large as the folder. Conversion from PDF deliberately wants that
  // (the pages are already compressed and copying them is lossless), but a
  // folder of source images usually does not.
  const wantsTransform = options.quality !== null || options.maxDimension !== null
  let entries = imagePaths
  let scratch: string | null = null

  if (wantsTransform && imagePaths.length > 0) {
    const sharp = (await import('sharp')).default
    scratch = options.scratchDir ?? `${outputPath}.pages`
    mkdirSync(scratch, { recursive: true })

    const transformed: string[] = []
    for (let i = 0; i < imagePaths.length; i++) {
      // Re-encoded pages are always JPEG, so the extension is fixed here rather
      // than inherited from the source.
      const dest = join(scratch, `${String(i + 1).padStart(4, '0')}.jpg`)
      let pipeline = sharp(imagePaths[i], { failOn: 'none' })
      if (options.maxDimension !== null) {
        // `inside` never upscales, so a page already smaller than the cap is
        // left at its own size instead of being blown up and re-compressed.
        pipeline = pipeline.resize(options.maxDimension, options.maxDimension, {
          fit: 'inside',
          withoutEnlargement: true
        })
      }
      await pipeline.jpeg({ quality: options.quality ?? 80, mozjpeg: true }).toFile(dest)
      transformed.push(dest)
      onProgress?.(i + 1, imagePaths.length)
    }
    entries = transformed
  }

  // Step 3: Write archive
  try {
    await new Promise<void>((resolve, reject) => {
      const zipfile = new yazl.ZipFile()
      const output = createWriteStream(partPath)
      zipfile.outputStream.pipe(output)

      // Add ComicInfo.xml first (§1.4 — lets streaming readers find metadata early)
      zipfile.addBuffer(Buffer.from(ciXml, 'utf-8'), 'ComicInfo.xml', { compress: false })

      // Add images with zero-padded names
      for (let i = 0; i < entries.length; i++) {
        const pageNum = i + 1
        const paddedName = String(pageNum).padStart(4, '0')
        const ext = (basename(entries[i]).split('.').pop() || 'jpg').toLowerCase()

        // Stored, not deflated: these are JPEG or PNG either way, and deflating
        // already-compressed data costs CPU for roughly nothing.
        zipfile.addFile(entries[i], `${paddedName}.${ext}`, { compress: false })

        // Progress was already reported per page during the transform pass.
        if (!wantsTransform) onProgress?.(pageNum, entries.length)
      }

      zipfile.end()

      output.on('finish', () => resolve())
      output.on('error', reject)
      zipfile.outputStream.on('error', reject)
    })
  } finally {
    // Re-encoded pages are disposable the moment they are inside the archive.
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true })
      } catch {
        /* leftover scratch is not worth failing a good archive over */
      }
    }
  }

  // Step 3: Verify output exists before rename
  try {
    statSync(partPath)
  } catch {
    throw new Error('Failed to create CBZ: output file not found after writing')
  }

  // Step 4: Atomic rename
  renameSync(partPath, outputPath)

  return outputPath
}
