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
import type { ComicInfoMetadata } from './comicinfo'
import type { GalleryMetadata } from './metadata-writer'
import { resolveLanguageName } from './xml-utils'
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
  mangaDirection?: 'Yes' | 'YesAndRightToLeft' | 'No'
}

/**
 * Build ComicInfoMetadata from a GalleryMetadata payload.
 *
 * Reuses the same artist/group/publisher logic as the PDF worker
 * but produces ComicInfo fields instead of XMP.
 */
function convertToComicInfoMeta(
  meta: GalleryMetadata,
  pageCount: number,
  mangaDirection: 'YesAndRightToLeft' | 'Yes' | 'No'
): ComicInfoMetadata {
  const artistNames = meta.tags.filter((t) => t.type === 'artist').map((t) => t.name)
  const groupNames = meta.tags.filter((t) => t.type === 'group').map((t) => t.name)
  // Every language-type tag is a candidate; the first is commonly 'translated'.
  // buildComicInfoXml converts the canonical name to an ISO code for the
  // LanguageISO field.
  const languageIso = resolveLanguageName(meta.tags.filter((t) => t.type === 'language').map((t) => t.name))
  const categoryTags = meta.tags.filter((t) => t.type === 'category').map((t) => t.name)
  const characterTags = meta.tags.filter((t) => t.type === 'character').map((t) => t.name)
  const tagTags = meta.tags.filter((t) => t.type === 'tag').map((t) => t.name)
  const parodyTags = meta.tags.filter((t) => t.type === 'parody').map((t) => t.name)

  // Artist/group/publisher logic (§4.5)
  const hasArtist = artistNames.length > 0
  const hasGroup = groupNames.length > 0
  const publisher = hasGroup ? groupNames[0] : meta.publisher || null

  let writers: string[]
  if (hasArtist) {
    writers = artistNames
  } else if (hasGroup) {
    writers = groupNames
  } else {
    writers = ['Unknown']
  }

  return {
    title: meta.title.pretty,
    series: meta.seriesName || meta.title.pretty, // §4.3 — always write Series
    volume: meta.seriesIndex ?? undefined,
    summary: meta.description || undefined,
    writers,
    publisher,
    genres: categoryTags,
    tags: tagTags,
    characters: characterTags,
    webUrl: `https://nhentai.net/g/${meta.id}`,
    notes: `Tagged by Doujin Downloader -- nhentai gallery ${meta.id}`,
    pageCount,
    languageIso,
    releaseDate: meta.uploadDate ? new Date(meta.uploadDate * 1000) : undefined,
    ageRating: 'Adults Only 18+',
    manga: mangaDirection,
    seriesGroup: parodyTags.length > 0 ? parodyTags[0] : undefined
  }
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
    let ciMeta: ComicInfoMetadata

    if (cmd.metadata) {
      ciMeta = convertToComicInfoMeta(cmd.metadata, pageCount, mangaDirection)
      // LanguageISO is the field Kavita silently ignores when it is wrong, so
      // record what was resolved. Unresolved means the gallery's language tags
      // were all non-languages (commonly just 'translated').
      log.debug(`ComicInfo: language=${ciMeta.languageIso ?? 'unresolved'} manga=${mangaDirection}`)
    } else {
      // Minimal metadata when no gallery data is available
      ciMeta = {
        title: 'Untitled',
        series: 'Untitled',
        writers: ['Unknown'],
        genres: [],
        tags: [],
        characters: [],
        pageCount,
        ageRating: 'Adults Only 18+',
        manga: mangaDirection
      }
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
