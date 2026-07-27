/**
 * Download PDF Worker Thread
 *
 * Offloads CPU-bound PDF generation (pdf-lib + sharp WebP conversion),
 * metadata embedding, and thumbnail generation to a separate thread to
 * keep the Electron main process responsive.
 *
 * Message Protocol:
 *   Main → Worker: { type: 'generate', imagePaths, outputPath, options,
 *                     metadata?, firstImagePath?, thumbnailDir?, galleryId? }
 *   Worker → Main: { type: 'progress', current, total }
 *                  { type: 'complete', outputPath, thumbnailPath? }
 *                  { type: 'error', message }
 */

import { parentPort } from 'worker_threads'
import { generatePdf } from './pdf-generator'
import { embedMetadata } from './metadata-writer'
import type { PdfOptions } from './pdf-generator'
import type { GalleryMetadata } from './metadata-writer'

interface GenerateCommand {
  type: 'generate'
  imagePaths: string[]
  outputPath: string
  options: PdfOptions
  metadata?: GalleryMetadata
  firstImagePath?: string
  thumbnailDir?: string
  galleryId?: number
}

parentPort?.on('message', async (cmd: GenerateCommand) => {
  if (cmd.type !== 'generate') return

  try {
    // Step 1: Generate PDF from images
    const outputPath = await generatePdf(
      cmd.imagePaths,
      cmd.outputPath,
      cmd.options,
      (current, total) => {
        parentPort?.postMessage({ type: 'progress', current, total })
      }
    )

    // Step 2: Embed metadata (if provided) — now in worker, not main thread
    if (cmd.metadata) {
      try {
        await embedMetadata(outputPath, cmd.metadata)
      } catch (metaErr) {
        // Non-fatal: metadata embedding failure shouldn't block completion
        console.error('[pdf-worker] Metadata embedding failed:', metaErr)
      }
    }

    // Step 3: Generate thumbnail (if first image + thumbnail dir provided) — now in worker
    let thumbnailPath: string | undefined
    if (cmd.firstImagePath && cmd.thumbnailDir && cmd.galleryId != null) {
      try {
        const { mkdirSync, existsSync } = await import('fs')
        const { join } = await import('path')
        const sharp = (await import('sharp')).default

        if (!existsSync(cmd.thumbnailDir)) {
          mkdirSync(cmd.thumbnailDir, { recursive: true })
        }
        const thumbPath = join(cmd.thumbnailDir, `${cmd.galleryId}.jpg`)
        await sharp(cmd.firstImagePath)
          .resize(300, 400, { fit: 'inside' })
          .jpeg({ quality: 80 })
          .toFile(thumbPath)
        thumbnailPath = thumbPath
      } catch (thumbErr) {
        // Non-critical: thumbnail generation can fail silently
        console.error('[pdf-worker] Thumbnail generation failed:', thumbErr)
      }
    }

    parentPort?.postMessage({ type: 'complete', outputPath, thumbnailPath })
  } catch (err) {
    parentPort?.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
  }
})
