import { PDFDocument } from 'pdf-lib'
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
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

  // Set keywords: tag names + nhentai:{id} token
  const tagNames = metadata.tags.map((t) => t.name)
  const keywordTokens = [...tagNames, `nhentai:${metadata.id}`]
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

  // Replace original with modified version
  const backupPath = pdfPath + '.bak'
  renameSync(pdfPath, backupPath)
  renameSync(tempPath, pdfPath)

  // Remove backup
  try {
    unlinkSync(backupPath)
  } catch {
    // Non-critical if cleanup fails
  }
}
