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
import { resolveLanguageName } from './xml-utils'
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

function convertMetadata(meta: GalleryMetadata, language: string | null): XmpMetadata {
  const tagNames = meta.tags.map((t) => t.name)
  const artistNames = meta.tags.filter((t) => t.type === 'artist').map((t) => t.name)
  const groupNames = meta.tags.filter((t) => t.type === 'group').map((t) => t.name)
  // Every language-type tag is a candidate. The first is commonly 'translated',
  // which is not a language — see resolveLanguageName(). The result is a
  // canonical name ('English'); xmp-inject converts it to an ISO code on write.
  const langCode =
    language || resolveLanguageName(meta.tags.filter((t) => t.type === 'language').map((t) => t.name))

  // Artist/group/publisher logic:
  // - No artist + group → group is artist AND publisher
  // - Artist + group → artist is creator, group is publisher
  // - Artist only → artist is creator
  // - Neither → 'Unknown'
  const hasArtist = artistNames.length > 0
  const hasGroup = groupNames.length > 0
  const publisher = hasGroup ? groupNames[0] : meta.publisher || null

  let creators: string[]
  if (hasArtist) {
    creators = artistNames
  } else if (hasGroup) {
    creators = groupNames
  } else {
    creators = ['Unknown']
  }

  return {
    title: meta.title.pretty,
    creators,
    tags: tagNames,
    nhentaiId: meta.id,
    language: langCode,
    publisher,
    date: meta.uploadDate
      ? new Date(meta.uploadDate * 1000).toISOString()
      : null,
    seriesName: meta.seriesName || null,
    seriesIndex: meta.seriesIndex != null ? meta.seriesIndex : null,
    description: meta.description || null
  }
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
        const xmpMeta = convertMetadata(
          cmd.metadata,
          null
        )
        const result = await applyXmpWithPikepdf(outputPath, xmpMeta)
        if (!result.success) {
          // Non-fatal: the PDF is usable, but Kavita will show no metadata for
          // it. Worth a warning rather than silence, because the symptom the
          // user sees is "the language/tags are missing" with nothing to
          // explain why.
          log.warn(`XMP injection failed, PDF has no embedded metadata: ${result.error}`, {
            language: xmpMeta.language
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
