/**
 * Runtime dependency probe.
 *
 * This app shells out to two toolchains that are **not** bundled with it:
 *
 * - Python + `pikepdf`, which writes all PDF XMP metadata
 * - poppler's `pdfinfo` / `pdfimages` / `pdftoppm`, which produce PDF
 *   thumbnails and drive the entire PDF → CBZ conversion
 *
 * Without them the app still starts and still downloads, it just quietly stops
 * doing half of what the user expects: PDFs come out with no metadata and
 * conversion refuses. Previously the only signal was a `console.error` at
 * startup, which a packaged user never sees. This module exists so the same
 * probe can drive both the startup log and a visible panel in Settings.
 */

import { execFile } from 'child_process'
import { platform } from 'os'
import { checkPikepdfAvailable } from './xmp-inject'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ToolStatus {
  /** Stable id, used as a React key. */
  id: string
  /** Human name, e.g. "poppler (pdfimages)". */
  name: string
  ok: boolean
  /** Version string when found, or the reason it was not. */
  detail: string
  /** What stops working without it. */
  affects: string
  /**
   * False when the app is fully usable without it — nothing here is optional
   * today, but the field keeps the UI honest if that changes.
   */
  required: boolean
}

export interface ToolchainReport {
  ok: boolean
  tools: ToolStatus[]
  /** Copy-pasteable install command for the current platform. */
  installHint: string
}

// ─── Probes ──────────────────────────────────────────────────────────────────

/** Run `<binary> -v` and treat any successful spawn as "present". */
function probeBinary(binary: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFile(binary, ['-v'], { timeout: 5000 }, (err, stdout, stderr) => {
      // poppler tools print their version banner to stderr and some exit
      // non-zero for `-v`, so the spawn succeeding is the real signal. Only
      // ENOENT means genuinely absent.
      const text = `${stdout}${stderr}`.trim()
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ ok: false, detail: 'not found on PATH' })
        return
      }
      if (err && !text) {
        resolve({ ok: false, detail: err.message })
        return
      }
      resolve({ ok: true, detail: text.split('\n')[0] || 'present' })
    })
  })
}

/** Install command for the tools that are missing, for this OS. */
function installHint(missing: string[]): string {
  if (missing.length === 0) return ''
  const needsPoppler = missing.some((m) => m.startsWith('poppler'))
  const needsPikepdf = missing.includes('pikepdf')

  switch (platform()) {
    case 'linux': {
      const dnf = [needsPoppler && 'poppler-utils', needsPikepdf && 'python3-pikepdf']
        .filter(Boolean)
        .join(' ')
      return `sudo dnf install ${dnf}      # Debian/Ubuntu: sudo apt install ${dnf}`
    }
    case 'win32': {
      const parts: string[] = []
      if (needsPikepdf) parts.push('pip install pikepdf')
      if (needsPoppler) {
        parts.push('Install poppler for Windows and add its bin\\ folder to PATH')
      }
      return parts.join('  •  ')
    }
    default:
      return `Install: ${missing.join(', ')}`
  }
}

let cached: ToolchainReport | null = null

/**
 * Probe every external tool.
 *
 * Cached, because probing spawns four processes and both startup and the
 * Settings panel ask for it. Pass `force` after the user has installed
 * something and wants to re-check without restarting.
 */
export async function checkToolchain(force = false): Promise<ToolchainReport> {
  if (cached && !force) return cached

  const [pikepdf, pdfinfo, pdfimages, pdftoppm] = await Promise.all([
    checkPikepdfAvailable(force),
    probeBinary('pdfinfo'),
    probeBinary('pdfimages'),
    probeBinary('pdftoppm')
  ])

  const tools: ToolStatus[] = [
    {
      id: 'pikepdf',
      name: 'Python + pikepdf',
      ok: pikepdf.ok,
      detail: pikepdf.detail,
      affects: 'Metadata on PDF files. Without it, downloaded PDFs carry no title, artist or tags.',
      required: true
    },
    {
      id: 'poppler-pdfinfo',
      name: 'poppler — pdfinfo',
      ok: pdfinfo.ok,
      detail: pdfinfo.detail,
      affects: 'Page counts used to verify a PDF → CBZ conversion.',
      required: true
    },
    {
      id: 'poppler-pdfimages',
      name: 'poppler — pdfimages',
      ok: pdfimages.ok,
      detail: pdfimages.detail,
      affects: 'Lossless page extraction for PDF → CBZ conversion.',
      required: true
    },
    {
      id: 'poppler-pdftoppm',
      name: 'poppler — pdftoppm',
      ok: pdftoppm.ok,
      detail: pdftoppm.detail,
      affects: 'PDF thumbnails in the library, and the conversion fallback.',
      required: true
    }
  ]

  const missing = tools.filter((t) => !t.ok).map((t) => (t.id === 'pikepdf' ? 'pikepdf' : t.id))
  cached = {
    ok: missing.length === 0,
    tools,
    installHint: installHint(missing)
  }
  return cached
}
