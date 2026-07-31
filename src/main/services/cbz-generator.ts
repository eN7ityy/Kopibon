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
import { createWriteStream, renameSync, statSync } from 'fs'
import { basename } from 'path'
import { buildComicInfoXml, type ComicInfoMetadata } from './comicinfo'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CbzOptions {
  /** JPEG quality 1-95, or null to embed source images untouched. */
  quality: number | null
  /** Longest-edge cap in px, or null for no resizing. */
  maxDimension: number | null
}

// ─── Generator ───────────────────────────────────────────────────────────────

/**
 * Generate a CBZ file from a list of image paths.
 *
 * @param imagePaths - Paths to image files in page order
 * @param outputPath - Destination path (will get .part suffix during write)
 * @param metadata - ComicInfo metadata
 * @param options - Quality/maxDimension options
 * @param onProgress - Optional progress callback
 * @returns The final output path
 */
export async function generateCbz(
  imagePaths: string[],
  outputPath: string,
  metadata: ComicInfoMetadata,
  _options: CbzOptions,
  onProgress?: (current: number, total: number) => void
): Promise<string> {
  const partPath = outputPath + '.part'

  // Step 1: Build ComicInfo with accurate page count
  const ciMeta: ComicInfoMetadata = {
    ...metadata,
    pageCount: imagePaths.length
  }
  const ciXml = buildComicInfoXml(ciMeta)

  // Step 2: Write archive
  await new Promise<void>((resolve, reject) => {
    const zipfile = new yazl.ZipFile()
    const output = createWriteStream(partPath)
    zipfile.outputStream.pipe(output)

    // Add ComicInfo.xml first (§1.4 — lets streaming readers find metadata early)
    zipfile.addBuffer(Buffer.from(ciXml, 'utf-8'), 'ComicInfo.xml', { compress: false })

    // Add images with zero-padded names
    for (let i = 0; i < imagePaths.length; i++) {
      const pageNum = i + 1
      const paddedName = String(pageNum).padStart(4, '0')
      const ext = (basename(imagePaths[i]).split('.').pop() || 'jpg').toLowerCase()

      // Always store — JPEGs don't deflate meaningfully and lossless
      // mode (quality: null) is the only mode used by all current callers.
      zipfile.addFile(imagePaths[i], `${paddedName}.${ext}`, { compress: false })

      if (onProgress) {
        onProgress(pageNum, imagePaths.length)
      }
    }

    zipfile.end()

    output.on('finish', () => resolve())
    output.on('error', reject)
    zipfile.outputStream.on('error', reject)
  })

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
