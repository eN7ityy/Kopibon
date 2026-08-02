/**
 * Download CBZ Worker Thread
 *
 * Offloads CPU-bound CBZ generation (yazl) and thumbnail generation to a
 * separate thread to keep the Electron main process responsive.
 *
 * Message Protocol:
 *   Main -> Worker: { type: 'generate', imagePaths, outputPath, metadata,
 *                     firstImagePath?, thumbnailDir?, galleryId? }
 *   Worker -> Main: { type: 'progress', current, total }
 *                  { type: 'complete', outputPath, thumbnailPath? }
 *                  { type: 'error', message }
 */

import { parentPort } from 'worker_threads'
import { generateCbz } from './cbz-generator'
import {
  fileMetadataFromGallery,
  makeFileMetadata,
  type FileMetadata,
  type GalleryMetadata,
  type MangaDirection
} from './metadata/file-metadata'
import { resolveLanguageValue } from './metadata/mappers'
import { createWorkerLogger } from './worker-logger'

interface GenerateCommand {
  type: 'generate'
  imagePaths: string[]
  outputPath: string
  metadata?: GalleryMetadata
  firstImagePath?: string
  thumbnailDir?: string
  galleryId?: number
  /**
   * Reading direction from the `cbzMangaDirection` setting. Sent by the caller
   * because a worker has no business opening its own settings connection — and
   * this was previously hardcoded, so the setting had no effect on downloads.
   */
  mangaDirection?: MangaDirection
}

parentPort?.on('message', async (cmd: GenerateCommand) => {
  if (cmd.type !== 'generate') return

  const log = createWorkerLogger(
    'worker:download-cbz',
    cmd.galleryId != null ? String(cmd.galleryId) : undefined
  )

  try {
    const pageCount = cmd.imagePaths.length
    log.info(`Building CBZ from ${pageCount} page(s) -> ${cmd.outputPath}`)

    // Step 1: Build ComicInfo metadata
    const mangaDirection = cmd.mangaDirection ?? 'YesAndRightToLeft'
    let ciMeta: FileMetadata

    if (cmd.metadata) {
      ciMeta = fileMetadataFromGallery(cmd.metadata, {
        pageCount,
        mangaDirection,
        format: 'cbz',
        // A freshly downloaded gallery's parody becomes its collection. The
        // conversion path gates this on `cbzParodyAsCollection`; downloads
        // never have, and changing that here would silently restructure
        // collections in Kavita.
        parodyAsCollection: true
      })
      // LanguageISO is the field Kavita silently ignores when it is wrong, so
      // record what was resolved. Unresolved means the gallery's language tags
      // were all non-languages (commonly just 'translated').
      log.debug(
        `ComicInfo: language=${resolveLanguageValue(ciMeta) ?? 'unresolved'} manga=${mangaDirection}`
      )
    } else {
      // Nothing but the pages themselves.
      ciMeta = makeFileMetadata({ pageCount, mangaDirection, format: 'cbz' })
    }

    // Step 2: Generate CBZ
    const outputPath = await generateCbz(
      cmd.imagePaths,
      cmd.outputPath,
      ciMeta,
      { quality: null, maxDimension: null },
      (current, total) => {
        parentPort?.postMessage({ type: 'progress', current, total })
      }
    )

    // No pikepdf step — ComicInfo is inside the archive

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
        log.warn('Thumbnail generation failed, entry will have no cover', {
          err: thumbErr instanceof Error ? thumbErr : new Error(String(thumbErr)),
          source: cmd.firstImagePath
        })
      }
    }

    log.info(`CBZ complete: ${outputPath}`)
    parentPort?.postMessage({ type: 'complete', outputPath, thumbnailPath })
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    log.error(`CBZ generation failed: ${e.message}`, { err: e })
    parentPort?.postMessage({ type: 'error', message: e.message })
  }
})
