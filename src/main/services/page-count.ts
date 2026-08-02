import { existsSync } from 'fs'
import { countCbzPages } from './apply-metadata'
import { getPdfPageCount } from './pdf-extract'

/**
 * How many pages a library file holds, whatever its format.
 *
 * One place, because the answer is needed at every point a file is written —
 * download, conversion, sync — and by the detail and series panels. Two
 * formats, two mechanisms:
 *
 *   cbz  image entries in the archive's central directory, nothing inflated
 *   pdf  `pdfinfo`, which reads the trailer rather than the document
 *
 * Both are metadata reads and cost around 25ms on a network mount. That is
 * cheap once and far too expensive on every render, which is why the result is
 * stored on the row rather than recomputed.
 *
 * Returns null rather than throwing. A page count is an enrichment: a missing
 * or unreadable file, or a PDF on a machine without poppler, should leave the
 * field blank, never fail the download or conversion that asked for it.
 */
export async function countPages(
  filePath: string,
  format: string | null | undefined
): Promise<number | null> {
  if (!filePath || !existsSync(filePath)) return null

  const kind =
    (format || '').toLowerCase() || (filePath.toLowerCase().endsWith('.pdf') ? 'pdf' : 'cbz')

  try {
    const pages = kind === 'pdf' ? await getPdfPageCount(filePath) : await countCbzPages(filePath)
    return Number.isFinite(pages) && pages > 0 ? pages : null
  } catch {
    return null
  }
}
