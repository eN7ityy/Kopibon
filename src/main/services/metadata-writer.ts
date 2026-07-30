import { PDFDocument } from 'pdf-lib'
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, renameSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GalleryMetadata {
  id: number
  title: {
    english: string
    japanese: string | null
    pretty: string
  }
  tags: Array<{
    id: number
    type: string
    name: string
  }>
  uploadDate: number
  numPages: number
  // Optional: series name if assigned
  seriesName?: string
  // Extended metadata (F2-F6)
  seriesIndex?: number
  language?: string
  publisher?: string
  description?: string
}

import { toIsoLanguage } from './xml-utils'

/**
 * Move a file from srcPath to destPath, handling cross-device moves.
 * Uses copyFileSync + unlinkSync to support /tmp → library directory.
 */
function moveFile(srcPath: string, destPath: string): void {
  try {
    copyFileSync(srcPath, destPath)
    try { unlinkSync(srcPath) } catch { /* source cleanup non-critical */ }
  } catch {
    // Fallback: try renameSync for same-filesystem case
    try {
      renameSync(srcPath, destPath)
    } catch (err) {
      // Last resort: read/write
      writeFileSync(destPath, readFileSync(srcPath))
      try { unlinkSync(srcPath) } catch { /* */ }
    }
  }
}

// ─── Metadata Writer ─────────────────────────────────────────────────────────

/**
 * Embed metadata into an existing PDF file.
 *
 * Uses the approach from the architecture plan: open PDF without
 * `allow_overwriting_input`, modify docinfo, save to temp file,
 * then move over the original.
 *
 * @param pdfPath - Full path to the PDF file to modify
 * @param metadata - Gallery metadata to embed
 */
export async function embedMetadata(
  pdfPath: string,
  metadata: GalleryMetadata
): Promise<void> {
  // Read the existing PDF
  const existingBytes = readFileSync(pdfPath)
  const pdfDoc = await PDFDocument.load(existingBytes, {
    // Do NOT set allow_overwriting_input — we save to temp file instead
  })

  // Set document title
  pdfDoc.setTitle(metadata.title.pretty)

  // Set author: comma-separated artist names
  const artistNames = metadata.tags
    .filter((t) => t.type === 'artist')
    .map((t) => t.name)
  if (artistNames.length > 0) {
    pdfDoc.setAuthor(artistNames.join(', '))
  }

  // Set keywords: tag names + nhentai:{id} token + extended metadata tokens
  const tagNames = metadata.tags.map((t) => t.name)
  const keywordTokens = [...tagNames, `nhentai:${metadata.id}`]

  // F2: series_index fallback token
  if (metadata.seriesIndex != null) {
    keywordTokens.push(`series_index:${metadata.seriesIndex}`)
  }
  // F3: calibre_series fallback token (written alongside XMP attempt)
  if (metadata.seriesName) {
    keywordTokens.push(`calibre_series:${metadata.seriesName}`)
  }
  // F4: language fallback token (use ISO 639-1 code when possible)
  if (metadata.language) {
    const isoCode = toIsoLanguage(metadata.language)
    keywordTokens.push(`language:${isoCode}`)
  }
  // F5: publisher fallback token
  if (metadata.publisher) {
    keywordTokens.push(`publisher:${metadata.publisher}`)
  }
  // F6: description fallback token
  if (metadata.description) {
    keywordTokens.push(`description:${metadata.description}`)
  }

  pdfDoc.setKeywords(keywordTokens)

  // Set creation date from upload date
  pdfDoc.setCreationDate(new Date(metadata.uploadDate * 1000))

  // Set subject (can contain series name if assigned)
  if (metadata.seriesName) {
    pdfDoc.setSubject(metadata.seriesName)
  }

  // Set producer
  pdfDoc.setProducer('Doujin-Downloader')

  // Save to temporary file
  const tempPath = join(tmpdir(), `pdf-meta-${randomUUID()}.pdf`)
  const modifiedBytes = await pdfDoc.save()
  writeFileSync(tempPath, modifiedBytes)

  // Move temp file over original (handles cross-device)
  moveFile(tempPath, pdfPath)
}

/**
 * Set the series name on an existing PDF.
 *
 * Writes to /Subject (dc:subject in XMP) for backward compatibility
 * and adds calibre_series:{name} token to /Keywords as fallback.
 *
 * Note: pdf-lib cannot write custom XMP namespaces (calibre:series).
 * PDFs managed by Calibre will have calibre:series in XMP which the
 * scanner reads as the primary source. For app-written PDFs, readers
 * should use /Keywords calibre_series: token or /Subject.
 *
 * @param pdfPath - Full path to the PDF file to modify
 * @param seriesName - Series name to embed (empty string to clear)
 */
export async function setSeries(
  pdfPath: string,
  seriesName: string
): Promise<void> {
  const existingBytes = readFileSync(pdfPath)
  const pdfDoc = await PDFDocument.load(existingBytes)

  pdfDoc.setSubject(seriesName || '')

  // Update Keywords: preserve existing tokens, add/update calibre_series
  const existingKw = pdfDoc.getKeywords() || ''
  const tokens = existingKw.split(',').map(s => s.trim()).filter(Boolean)
  const filtered = tokens.filter(t => !t.startsWith('calibre_series:'))
  if (seriesName) {
    filtered.push(`calibre_series:${seriesName}`)
  }
  pdfDoc.setKeywords(filtered)

  pdfDoc.setProducer('Doujin-Downloader')

  // Save to temporary file, then move over original
  const tempPath = join(tmpdir(), `pdf-series-${randomUUID()}.pdf`)
  const modifiedBytes = await pdfDoc.save()
  writeFileSync(tempPath, modifiedBytes)

  // Move temp file over original (handles cross-device)
  moveFile(tempPath, pdfPath)
}
