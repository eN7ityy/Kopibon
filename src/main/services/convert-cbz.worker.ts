/**
 * Convert CBZ Worker Thread
 *
 * Converts a single PDF → CBZ for a library item. The ordering is the safety
 * property — do not reorder steps 1–8.
 *
 * Message Protocol:
 *   Main → Worker: { type: 'convert', item: { id, filePath, metadata, options } }
 *   Worker → Main: { type: 'done', itemId, success, error?, log? }
 */

import { parentPort } from 'worker_threads'
import { statSync, existsSync, renameSync, unlinkSync, mkdirSync } from 'fs'
import { join, basename, extname } from 'path'
import { extractPdfImages } from './pdf-extract'
import { generateCbz } from './cbz-generator'
import { parseComicInfoXml, type ComicInfoMetadata } from './comicinfo'
import { resolveLanguageName } from './xml-utils'
import { open } from 'yauzl'
import { createWorkerLogger } from './worker-logger'

interface ConvertCommand {
  type: 'convert'
  item: {
    id: number
    filePath: string
    /** Full library info row */
    metadata: {
      customTitle?: string | null
      primaryArtist?: string | null
      seriesName?: string | null
      seriesIndex?: number | null
      customTags?: string | null
      customLanguage?: string | null
      publisher?: string | null
      description?: string | null
      galleryId?: number | null
      /** Only present for real gallery rows — omit date for stubs */
      uploadDate?: number | null
      /** Typed tags JSON — only usable for real gallery rows */
      rawTagsJson?: string | null
    }
    /** Conversion options */
    options: {
      keepOriginal: boolean
      libraryRoot: string
      /**
       * Where the source PDF is archived. Resolved in main from the setting, so
       * the worker never has to know the default layout.
       */
      originalsRoot: string
      userDataDir: string
      mangaDirection: 'Yes' | 'YesAndRightToLeft' | 'No'
      parodyAsCollection: boolean
    }
  }
}

// ─── Gallery row detection (§7.3) ────────────────────────────────────────────

interface TagLike {
  id?: number
  type: string
  name: string
}

function isRealGalleryRow(rawTagsJson: string | null | undefined): boolean {
  if (!rawTagsJson) return false
  try {
    const tags: TagLike[] = JSON.parse(rawTagsJson)
    if (!Array.isArray(tags) || tags.length === 0) return false
    const types = new Set(tags.map((t) => t.type))
    return !(types.size === 1 && types.has('tag'))
  } catch {
    return false
  }
}

// ─── Path safety ─────────────────────────────────────────────────────────────

/**
 * Reduce a database-supplied name to one safe path segment.
 *
 * Uses the same character class as the download path sanitiser
 * (`download-manager.ts`) so `_originals/{artist}/` matches the artist
 * directories the rest of the library already uses. Additionally collapses
 * leading dots, which that sanitiser does not need to handle because it never
 * builds a directory name: `..` survives the character filter untouched and
 * would walk out of `_originals/`.
 */
function safePathSegment(name: string | null | undefined): string {
  const cleaned = (name || '')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .substring(0, 180)
  return cleaned || 'Unknown'
}

// ─── Metadata builder for conversion (§7.3) ─────────────────────────────────

function buildConversionMetadata(
  item: ConvertCommand['item'],
  pageCount: number,
  mangaDirection: 'Yes' | 'YesAndRightToLeft' | 'No',
  parodyAsCollection: boolean
): ComicInfoMetadata {
  const meta = item.metadata
  const title = meta.customTitle || `Gallery #${meta.galleryId || item.id}`

  // Series: use the assigned series if one exists; otherwise title fallback
  const hasRealSeries = !!(meta.seriesName && meta.seriesName !== title)
  const series = meta.seriesName || title

  // Writers (§4.5 — reuse resolveCreatorsAndPublisher)
  const writers = meta.primaryArtist ? [meta.primaryArtist] : ['Unknown']

  // Tags: typed when real gallery row, otherwise flat customTags
  let tags: string[] = []
  let genres: string[] = []
  let characters: string[] = []
  let publisher: string | null = null
  let language: string | null = null
  let releaseDate: Date | undefined = undefined
  let seriesGroup: string | undefined = undefined

  if (isRealGalleryRow(meta.rawTagsJson)) {
    const parsed: TagLike[] = JSON.parse(meta.rawTagsJson!)

    tags = parsed.filter((t) => t.type === 'tag').map((t) => t.name)
    genres = parsed.filter((t) => t.type === 'category').map((t) => t.name)
    characters = parsed.filter((t) => t.type === 'character').map((t) => t.name)

    const groupTag = parsed.find((t) => t.type === 'group')
    publisher = groupTag?.name || meta.publisher || null

    // Every language-type tag is a candidate, then the item's own column.
    // Taking only the first would pick 'translated' — see resolveLanguageName().
    language = resolveLanguageName([
      ...parsed.filter((t) => t.type === 'language').map((t) => t.name),
      meta.customLanguage
    ])

    // Release date ONLY for real gallery rows (§4.2, §C.2)
    if (meta.uploadDate != null) {
      const d = new Date(meta.uploadDate * 1000)
      if (Number.isFinite(d.getTime())) releaseDate = d
    }

    if (parodyAsCollection) {
      const parodyTag = parsed.find((t) => t.type === 'parody')
      if (parodyTag) seriesGroup = parodyTag.name
    }
  } else {
    // Scanner stub: flat tags only
    tags = meta.customTags
      ? meta.customTags.split(',').map((t) => t.trim()).filter(Boolean)
      : []
    language = meta.customLanguage || null
    publisher = meta.publisher || null
    // NO release date for stubs — upload_date is our own tooling's timestamp
    // and 4,321 rows read '2026-07' which would corrupt Kavita's series data
  }

  return {
    title,
    series,
    volume: hasRealSeries && meta.seriesIndex != null ? meta.seriesIndex : undefined,
    summary: meta.description || undefined,
    writers,
    publisher,
    genres,
    tags,
    characters,
    webUrl: meta.galleryId ? `https://nhentai.net/g/${meta.galleryId}` : undefined,
    notes: meta.galleryId
      ? `Tagged by Doujin Downloader — nhentai gallery ${meta.galleryId}`
      : undefined,
    pageCount,
    languageIso: language,
    releaseDate,
    ageRating: 'Adults Only 18+',
    manga: mangaDirection,
    seriesGroup
  }
}

// ─── CBZ Verification (§10.3) ───────────────────────────────────────────────

async function verifyCbz(outputPath: string, expectedPages: number): Promise<boolean> {
  try {
    const result = await new Promise<boolean>((resolve) => {
      open(outputPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return resolve(false)
        if (!zipfile) return resolve(false)

        let entryIndex = 0
        let imageCount = 0
        let comicInfoIsFirst = false
        let comicInfoParsed = false
        const imageNames: string[] = []

        zipfile.readEntry()
        zipfile.on('entry', (entry) => {
          if (entry.fileName === 'ComicInfo.xml') {
            if (entryIndex === 0) comicInfoIsFirst = true
            const chunks: Buffer[] = []
            zipfile.openReadStream(entry, (openErr, readStream) => {
              if (openErr || !readStream) { resolve(false); return }
              readStream.on('data', (chunk: Buffer) => chunks.push(chunk))
              readStream.on('end', () => {
                try {
                  const xml = Buffer.concat(chunks).toString('utf-8')
                  const parsed = parseComicInfoXml(xml)
                  if (!parsed.title) { resolve(false); return }
                  comicInfoParsed = true
                } catch { resolve(false); return }
                // ComicInfo.xml is NOT an image — do NOT increment imageCount
                entryIndex++
                zipfile.readEntry()
              })
              readStream.on('error', () => resolve(false))
            })
          } else if (!entry.fileName.endsWith('/') && /\.(jpe?g|png|gif|bmp|webp)$/i.test(entry.fileName)) {
            // Only count entries with names starting with the expected pattern
            // (rejects any stray entry mixed into the archive)
            imageNames.push(entry.fileName)
            imageCount++
            entryIndex++
            zipfile.readEntry()
          } else {
            entryIndex++
            zipfile.readEntry()
          }
        })

        zipfile.on('end', () => {
          const totalEntries = entryIndex
          if (!comicInfoIsFirst || !comicInfoParsed) { resolve(false); return }
          if (imageCount !== expectedPages) { resolve(false); return }
          if (totalEntries !== expectedPages + 1) { resolve(false); return }

          // Verify image names are zero-padded and in order
          for (let i = 0; i < imageNames.length; i++) {
            const expectedName = `${String(i + 1).padStart(4, '0')}${extname(imageNames[i]) || '.jpg'}`
            if (imageNames[i] !== expectedName) { resolve(false); return }
          }

          resolve(true)
        })

        zipfile.on('error', () => resolve(false))
      })
    })

    return result
  } catch {
    return false
  }
}

// ─── Worker ─────────────────────────────────────────────────────────────────

parentPort?.on('message', async (cmd: ConvertCommand) => {
  if (cmd.type !== 'convert') return

  const { id, filePath, metadata: itemMeta, options } = cmd.item
  const logHead = basename(filePath)

  // As in convert.worker: the `log:` field feeds the run's own panel, this
  // reaches the application log.
  const log = createWorkerLogger('worker:convert-cbz', String(id))

  try {
    /*
     * Step 1: Verify the source PDF exists and format is pdf.
     *
     * Names the path. "Source file not found" on its own said nothing about
     * which file or where it was expected, and the case it reported turned out
     * to involve a path that existed by the time anyone looked — so the message
     * has to carry enough to tell a stale queue row from a genuinely missing
     * file, and to distinguish either from a network mount that blinked.
     */
    if (!existsSync(filePath)) {
      throw new Error(`Source file not found: ${filePath}`)
    }

    // Step 2: Extract images to userData scratch
    const scratchDir = join(options.userDataDir, 'convert-cbz', String(id))
    mkdirSync(scratchDir, { recursive: true })

    let extractResult
    try {
      extractResult = await extractPdfImages(filePath, scratchDir, log)
    } catch (extractErr) {
      // Clean scratch on extraction failure
      try { const { rmSync } = await import('fs'); rmSync(scratchDir, { recursive: true, force: true }) } catch { /* */ }
      throw new Error(`Extraction failed: ${String(extractErr)}`)
    }

    // Step 3: Build ComicInfo from best available metadata
    const ciMeta = buildConversionMetadata(
      cmd.item,
      extractResult.pageCount,
      options.mangaDirection,
      options.parodyAsCollection
    )

    // Step 4: Generate CBZ
    const outputPath = filePath.replace(/\.pdf$/i, '.cbz')
    // Ensure unique output path
    let finalOutput = outputPath
    let counter = 1
    while (existsSync(finalOutput)) {
      finalOutput = outputPath.replace(/\.cbz$/i, `-${counter}.cbz`)
      counter++
    }

    await generateCbz(
      extractResult.imagePaths,
      finalOutput,
      ciMeta,
      { quality: null, maxDimension: null }
    )

    log.info(
      `Extracted ${extractResult.pageCount} page(s) from ${logHead}` +
        ` via ${extractResult.method} (${extractResult.lossless ? 'lossless' : 'lossy'})`
    )

    // Step 5: VERIFY the output
    const verified = await verifyCbz(finalOutput, extractResult.pageCount)
    if (!verified) {
      // This is the check that rejected every valid archive once, so it is
      // logged with the page count it expected rather than just "failed".
      log.error(
        `Verification failed for ${basename(finalOutput)}, expected ${extractResult.pageCount} page(s); output discarded, PDF left in place`
      )
      // Remove the invalid output
      try { unlinkSync(finalOutput) } catch { /* */ }
      // Clean scratch
      try { const { rmSync } = await import('fs'); rmSync(scratchDir, { recursive: true, force: true }) } catch { /* */ }
      throw new Error('Verification failed — output CBZ did not pass integrity checks')
    }

    // Step 6: Only if verified — handle original.
    //
    // A lossy conversion's source is never deleted, whatever the setting says.
    // `pdfimages -all` copies image streams byte-for-byte, but the `pdftoppm`
    // fallback re-rasterises at 150 DPI, so for those items the PDF holds the
    // only full-quality copy of the pages. Such originals go to a separate
    // `_lossy` subtree so that a later "delete originals" sweep can spare them.
    const forcedKeep = !extractResult.lossless
    const keepOriginal = options.keepOriginal || forcedKeep
    let originalPath: string | null = null

    if (keepOriginal) {
      // Move PDF to _originals/{artist}/. The artist name comes from the
      // database and goes straight into a path, so it has to be reduced to a
      // single safe path segment first — a name containing '/' or '..' would
      // otherwise place the user's only remaining copy outside _originals.
      // The archive root is configurable, so it comes in rather than being built
      // from the library root. An empty value falls back to the old layout so a
      // conversion can never lose the source PDF over a missing setting.
      const archiveRoot = options.originalsRoot || join(options.libraryRoot, '_originals')
      const originalsDir = forcedKeep
        ? join(archiveRoot, '_lossy', safePathSegment(itemMeta?.primaryArtist))
        : join(archiveRoot, safePathSegment(itemMeta?.primaryArtist))
      mkdirSync(originalsDir, { recursive: true })

      // Never overwrite an archived original — re-converting an item whose name
      // collides would otherwise destroy the earlier copy.
      let dest = join(originalsDir, basename(filePath))
      let n = 1
      while (existsSync(dest)) {
        dest = join(originalsDir, basename(filePath).replace(/\.pdf$/i, `-${n}.pdf`))
        n++
      }
      renameSync(filePath, dest)
      originalPath = dest
      if (forcedKeep) {
        // The setting said delete, and the code overrode it. That disagreement
        // between what was asked and what happened needs to be on the record.
        log.warn(`Original kept despite the setting: conversion was lossy. Archived to ${dest}`)
      }
    } else {
      unlinkSync(filePath)
    }

    // Step 7: Purge scratch (always)
    try { const { rmSync } = await import('fs'); rmSync(scratchDir, { recursive: true, force: true }) } catch { /* */ }

    // Step 8: Report success with real file metadata
    const stat = statSync(finalOutput)
    const fileSize = stat.size
    const fileMtime = stat.mtimeMs
    parentPort?.postMessage({
      type: 'done',
      itemId: id,
      success: true,
      newPath: finalOutput,
      fileSize,
      fileMtime,
      lossless: extractResult.lossless,
      originalKept: keepOriginal,
      originalPath,
      /** Kept despite the setting because the conversion was not lossless. */
      forcedKeep,
      log:
        `OK ${logHead} → ${basename(finalOutput)} ` +
        `(${extractResult.method}, ${extractResult.lossless ? 'lossless' : 'lossy'}, ` +
        `original ${keepOriginal ? (forcedKeep ? 'kept — lossy, not deletable' : 'archived') : 'deleted'})`
    })
  } catch (err) {
    // On any failure: leave the PDF and DB row untouched
    // Clean scratch if it exists
    const scratchDir = join(options.userDataDir, 'convert-cbz', String(id))
    try { const { rmSync } = await import('fs'); rmSync(scratchDir, { recursive: true, force: true }) } catch { /* */ }

    const e = err instanceof Error ? err : new Error(String(err))
    log.error(`Conversion failed for ${logHead}: ${e.message}`, { err: e, filePath })

    parentPort?.postMessage({
      type: 'done',
      itemId: id,
      success: false,
      error: String(err),
      log: `FAIL ${logHead}: ${String(err)}`
    })
  }
})
