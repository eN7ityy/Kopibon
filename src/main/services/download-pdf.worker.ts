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
import { applyXmpWithPikepdf, type XmpMetadata } from './xmp-inject'
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

function convertMetadata(meta: GalleryMetadata, language: string | null): XmpMetadata {
  const tagNames = meta.tags.map((t) => t.name)
  const artistNames = meta.tags.filter((t) => t.type === 'artist').map((t) => t.name)
  const langTag = meta.tags.find((t) => t.type === 'language')
  const langCode = language || langTag?.name || null

  return {
    title: meta.title.pretty,
    creators: artistNames.length > 0 ? artistNames : ['Unknown'],
    tags: tagNames,
    nhentaiId: meta.id,
    language: langCode,
    date: meta.uploadDate
      ? new Date(meta.uploadDate * 1000).toISOString()
      : null,
    seriesName: meta.seriesName || null,
    seriesIndex: meta.seriesIndex != null ? meta.seriesIndex : null,
    description: meta.description || null,
    publisher: meta.publisher || null
  }
}

parentPort?.on('message', async (cmd: GenerateCommand) => {
  if (cmd.type !== 'generate') return

  try {
    // Step 1: Generate PDF from images (pdf-lib)
    const outputPath = await generatePdf(
      cmd.imagePaths,
      cmd.outputPath,
      cmd.options,
      (current, total) => {
        parentPort?.postMessage({ type: 'progress', current, total })
      }
    )

    // Step 2: Apply full XMP metadata via pikepdf (Dr Stein format)
    if (cmd.metadata) {
      try {
        const xmpMeta = convertMetadata(
          cmd.metadata,
          null
        )
        const result = await applyXmpWithPikepdf(outputPath, xmpMeta)
        if (!result.success) {
          console.error('[pdf-worker] Pikepdf XMP injection failed:', result.error)
        }
      } catch (metaErr) {
        console.error('[pdf-worker] Metadata injection error:', metaErr)
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
