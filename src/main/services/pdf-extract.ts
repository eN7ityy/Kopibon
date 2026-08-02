/**
 * pdf-extract — Extract page images from PDF for CBZ conversion.
 *
 * §7.2 extraction rules:
 * - Expected page count from `pdfinfo`, NEVER from gallery.page_count (it's 0
 *   for 99% of library rows — scanner stubs)
 * - Extract with `pdfimages -all` (lossless: JPEG streams copied byte-for-byte,
 *   everything else → PNG). NEVER `-j` — it emits enormous PPMs for non-JPEG
 *   streams and 2 of 4 sampled real files had non-JPEG encodings (§C.1).
 * - Count guard: `pdfimages` emits per *embedded image*, not per page. If
 *   count ≠ expected, discard and fall back to `pdftoppm -jpeg -r 150`.
 * - Sort numerically on the trailing integer — `pdfimages` zero-pads to 3
 *   digits and that padding GROWS, so `-1000.jpg` sorts before `-999.jpg`
 *   under a lexicographic sort.
 */

import { execFile } from 'child_process'
import { readdir } from 'fs/promises'
import { join, basename, extname } from 'path'
import { rmSync } from 'fs'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExtractResult {
  /** Page image paths in page order. */
  imagePaths: string[]
  /** Expected page count from pdfinfo. */
  pageCount: number
  /** True when pdfimages provided a verified count match. */
  lossless: boolean
  /** The extraction method actually used. */
  method: 'pdfimages' | 'pdftoppm'
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Run a poppler binary.
 *
 * @param timeoutMs - Milliseconds before the child is killed. Pass 0 for no
 *   timeout, which is what extraction needs: the dry-run sample included a
 *   143-page / 193 MB file, and `pdftoppm` rendering that at 150 DPI exceeds any
 *   ceiling short enough to be useful as a hang detector. Only the version
 *   probes get a real timeout, where a hang genuinely means a broken binary.
 */
function execAsync(cmd: string, args: string[], timeoutMs = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(new Error(`${cmd}: ${err.message}`))
        return
      }
      resolve(stdout)
    })
  })
}

/**
 * Get the expected page count from `pdfinfo`.
 *
 * `pdfinfo` output includes a `Pages:` line. Never use gallery.page_count
 * from the database — it is 0 for all scanner-stub rows (§7.2, §C.2).
 */
export async function getPdfPageCount(pdfPath: string): Promise<number> {
  // Metadata read only — fast even on huge files, so a ceiling here is a real
  // hang detector rather than a false alarm on big input.
  const out = await execAsync('pdfinfo', [pdfPath], 60_000)
  const m = out.match(/^Pages:\s+(\d+)/m)
  if (!m) throw new Error(`pdfinfo: could not parse page count for ${pdfPath}`)
  return parseInt(m[1], 10)
}

/**
 * Extract the trailing page index from a poppler output filename.
 *
 * poppler names its output `prefix-000.jpg`, `prefix-001.jpg`, …,
 * `prefix-1000.jpg`. Lexicographic sort puts 1000 before 999, so the index has
 * to be parsed and compared numerically.
 *
 * The digits must NOT be matched with an optional leading `-`. The hyphen here
 * is poppler's separator, not a minus sign: `/(-?\d+)$/` reads `page-031` as
 * -31, which makes every key negative and silently reverses the entire book —
 * page 32 first, page 1 last. That shipped and produced backwards CBZs.
 */
export function numericSortKey(p: string): number {
  const name = basename(p, extname(p)) // strip extension
  const m = name.match(/(\d+)$/)
  return m ? parseInt(m[1], 10) : 0
}

/** Check that pdftoppm is available. */
async function probePdfToPpm(): Promise<void> {
  await execAsync('pdftoppm', ['-v'], 5_000)
}

/** Check that pdfimages is available. */
async function probePdfImages(): Promise<void> {
  await execAsync('pdfimages', ['-v'], 5_000)
}

// ─── Extraction ──────────────────────────────────────────────────────────────

/**
 * Minimal log sink, satisfied structurally by both the main-process `Logger` and
 * a `WorkerLogger`.
 *
 * This module is imported from both sides — `library.ipc.ts` runs in main,
 * `convert-cbz.worker.ts` in a worker — so it cannot import either logger
 * directly: the main one pulls in Electron's `app`, which is unavailable in a
 * worker, and a worker logger posts to a `parentPort` that is null in main.
 * Taking the sink as a parameter lets each caller supply the one that works
 * there.
 */
export interface ExtractLogger {
  warn(msg: string, fields?: Record<string, unknown>): void
}

/**
 * Extract page images from a PDF for CBZ conversion.
 *
 * @param pdfPath  Path to the source PDF
 * @param scratchDir  Directory for extracted images (created if missing, cleaned
 *                    on failure)
 * @param log  Optional sink for the fallback warnings. Worth passing: a silent
 *             fallback to pdftoppm is how an item ends up lossy, and that is
 *             the difference between keeping and deleting the source PDF.
 */
export async function extractPdfImages(
  pdfPath: string,
  scratchDir: string,
  log?: ExtractLogger
): Promise<ExtractResult> {
  // Probe both early so we fail with a clear message before disk work.
  await probePdfImages()
  await probePdfToPpm()

  const expectedPages = await getPdfPageCount(pdfPath)

  // ── Attempt 1: pdfimages -all (lossless) ────────────────────────────────
  const prefix = 'page'
  try {
    await execAsync('pdfimages', ['-all', pdfPath, join(scratchDir, prefix)])

    // Must be sorted numerically — pdfimages zero-padding grows.
    const extracted = (await readdir(scratchDir))
      .filter((f) => f.startsWith(prefix))
      .map((f) => join(scratchDir, f))
      .sort((a, b) => numericSortKey(a) - numericSortKey(b))

    if (extracted.length === expectedPages) {
      return {
        imagePaths: extracted,
        pageCount: expectedPages,
        lossless: true,
        method: 'pdfimages'
      }
    }

    // Count mismatch — fall through to pdftoppm
    log?.warn(
      `Count mismatch for ${basename(pdfPath)}: pdfimages produced ${extracted.length} image(s) ` +
        `but pdfinfo reports ${expectedPages} page(s). Falling back to pdftoppm (lossy), ` +
        `so this item will not be a lossless copy.`,
      { extracted: extracted.length, expectedPages }
    )

    // Clean extraction debris before fallback
    rmSync(scratchDir, { recursive: true, force: true })
  } catch (err) {
    log?.warn(
      `pdfimages failed for ${basename(pdfPath)}, falling back to pdftoppm (lossy): ${String(err)}`
    )
    // Clean any partial output
    rmSync(scratchDir, { recursive: true, force: true })
  }

  // ── Attempt 2: pdftoppm -jpeg -r 150 (guaranteed one per page) ──────────
  const { mkdirSync } = await import('fs')
  mkdirSync(scratchDir, { recursive: true })

  // pdftoppm outputs page-0001.jpg, page-0002.jpg, … (4-digit padding)
  await execAsync('pdftoppm', [
    '-jpeg', '-r', '150', pdfPath, join(scratchDir, prefix)
  ])

  const extracted = (await readdir(scratchDir))
    .filter((f) => f.startsWith(prefix))
    .map((f) => join(scratchDir, f))
    .sort((a, b) => numericSortKey(a) - numericSortKey(b))

  if (extracted.length === 0) {
    throw new Error('pdftoppm produced zero files')
  }
  if (extracted.length !== expectedPages) {
    throw new Error(
      `pdftoppm produced ${extracted.length} files but expected ${expectedPages} pages`
    )
  }

  return {
    imagePaths: extracted,
    pageCount: expectedPages,
    lossless: false,
    method: 'pdftoppm'
  }
}
