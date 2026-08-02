/**
 * Download PDF Worker Thread
 *
 * Offloads CPU-bound PDF generation (pdf-lib + sharp WebP conversion),
 * metadata embedding (pikepdf XMP), and thumbnail generation to a
 * separate thread to keep the Electron main process responsive.
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
import { applyXmpWithPikepdf } from './xmp-inject'
import type { PdfOptions } from './pdf-generator'
import { fileMetadataFromGallery, type GalleryMetadata } from './metadata/file-metadata'
import { resolveLanguageValue } from './metadata/mappers'
import { createWorkerLogger } from './worker-logger'

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

  // jobId is the gallery number, so every record from one download can be
  // pulled out of the main log together.
  const log = createWorkerLogger(
    'worker:download-pdf',
    cmd.galleryId != null ? String(cmd.galleryId) : undefined
  )

  try {
    log.info(`Building PDF from ${cmd.imagePaths.length} page(s) -> ${cmd.outputPath}`)
    // Step 1: Generate PDF from images (pdf-lib)
    const outputPath = await generatePdf(
      cmd.imagePaths,
      cmd.outputPath,
      cmd.options,
      (current, total) => {
        parentPort?.postMessage({ type: 'progress', current, total })
      },
      log
    )

    // Step 2: Apply full XMP metadata via pikepdf (Dr Stein format)
    if (cmd.metadata) {
      try {
        const xmpMeta = fileMetadataFromGallery(cmd.metadata, {
          pageCount: cmd.imagePaths.length,
          format: 'pdf'
        })
        const result = await applyXmpWithPikepdf(outputPath, xmpMeta)
        if (!result.success) {
          // Non-fatal: the PDF is usable, but Kavita will show no metadata for
          // it. Worth a warning rather than silence, because the symptom the
          // user sees is "the language/tags are missing" with nothing to
          // explain why.
          log.warn(`XMP injection failed, PDF has no embedded metadata: ${result.error}`, {
            language: resolveLanguageValue(xmpMeta)
          })
        }
      } catch (metaErr) {
        log.error('XMP injection threw', {
          err: metaErr instanceof Error ? metaErr : new Error(String(metaErr))
        })
      }
    }

    // Step 3: Generate thumbnail
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
        // Also non-fatal, and also previously invisible: the entry just appears
        // in the library with no cover.
        log.warn('Thumbnail generation failed, entry will have no cover', {
          err: thumbErr instanceof Error ? thumbErr : new Error(String(thumbErr)),
          source: cmd.firstImagePath
        })
      }
    }

    log.info(`PDF complete: ${outputPath}`)
    parentPort?.postMessage({ type: 'complete', outputPath, thumbnailPath })
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    log.error(`PDF generation failed: ${e.message}`, { err: e })
    parentPort?.postMessage({ type: 'error', message: e.message })
  }
})
