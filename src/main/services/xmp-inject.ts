/**
 * Writing PDF metadata via Python + pikepdf.
 *
 * Building the XMP packet no longer happens here. The bytes come from
 * `resources/metadata-templates/pdf-xmp.template`, mapped from a `FileMetadata`
 * by `services/metadata/mappers.ts`. What is left is the part that has to be
 * code: shelling out to pikepdf, which is required because
 *
 * - pdf-lib cannot write custom XMP namespaces (calibre:series, pdfx:isbn)
 * - exiftool flattens nested rdf:Resource structures
 * - only pikepdf produces the exact byte format Kavita expects
 */

import { spawn } from 'child_process'
import { buildXmpXml, buildDocInfo } from './metadata/mappers'
import type { FileMetadata } from './metadata/file-metadata'

// ─── Pikepdf Invocation ──────────────────────────────────────────────────────

const PYTHON_SCRIPT = `
import sys, json, os
import pikepdf
from pikepdf import Pdf, Name, Stream

data = json.loads(sys.stdin.read())
pdf_path = data['pdfPath']
output_path = data.get('outputPath', pdf_path)

pdf = Pdf.open(pdf_path)

# Write docinfo fields alongside XMP (Kavita reads both)
pdf.docinfo['/Title'] = data.get('title', '')
pdf.docinfo['/Author'] = data.get('author', '')
pdf.docinfo['/Keywords'] = data.get('keywords', '')
pdf.docinfo['/Producer'] = data.get('producer', 'pikepdf 10.8.0')
pdf.docinfo['/Trapped'] = '/False'

# Nuke existing catalog Metadata reference
if Name.Metadata in pdf.Root:
    del pdf.Root[Name.Metadata]

xmp_bytes = data['xmp'].encode('utf-8')
stream = Stream(pdf, xmp_bytes)
stream[Name.Type] = Name.Metadata
stream[Name.Subtype] = Name.XML
pdf.Root[Name.Metadata] = pdf.make_indirect(stream)

# Save with traditional xref (disable object streams) so Info dict is readable
tmp = output_path + '.tmp'
pdf.save(tmp, compress_streams=False, object_stream_mode=0)
pdf.close()
os.replace(tmp, output_path)
print(json.dumps({'status': 'ok'}))
`.trim()

/**
 * Resolve the Python interpreter to use. `python3` does not exist on a stock
 * Windows install, so fall back through the usual names.
 */
function pythonCandidates(): string[] {
  const fromEnv = process.env.DOUJIN_PYTHON
  const base = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']
  return fromEnv ? [fromEnv, ...base] : base
}

interface PikepdfPayload {
  pdfPath: string
  outputPath?: string
  xmp: string
  title: string
  author: string
  keywords: string
  producer: string
}

function runPikepdf(payload: PikepdfPayload): Promise<{ success: boolean; error?: string }> {
  const candidates = pythonCandidates()

  const attempt = (index: number): Promise<{ success: boolean; error?: string }> =>
    new Promise((resolve) => {
      const exe = candidates[index]
      const proc = spawn(exe, ['-c', PYTHON_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] })

      let stdout = ''
      let stderr = ''
      let spawnFailed = false

      proc.stdout.on('data', (d: Buffer) => {
        stdout += d.toString()
      })
      proc.stderr.on('data', (d: Buffer) => {
        stderr += d.toString()
      })

      proc.on('error', (err) => {
        spawnFailed = true
        // Interpreter not found — try the next candidate name.
        if (index + 1 < candidates.length) {
          resolve(attempt(index + 1))
        } else {
          resolve({
            success: false,
            error: `Could not run Python (tried: ${candidates.join(', ')}). ${err.message}`
          })
        }
      })

      proc.on('close', (code) => {
        if (spawnFailed) return
        if (code === 0) {
          try {
            const result = JSON.parse(stdout)
            if (result.status === 'ok') {
              resolve({ success: true })
            } else {
              resolve({ success: false, error: result.message || 'Unknown pikepdf error' })
            }
          } catch {
            resolve({ success: true }) // Assume success if stdout is not JSON
          }
        } else {
          resolve({ success: false, error: stderr.trim() || `pikepdf exited with code ${code}` })
        }
      })

      try {
        proc.stdin.write(JSON.stringify(payload) + '\n')
        proc.stdin.end()
      } catch {
        /* handled by the error event */
      }
    })

  return attempt(0)
}

/**
 * Apply metadata to a PDF in place: docinfo nuked, XMP packet injected.
 *
 * The packet and the Info dictionary are both derived from the same
 * `FileMetadata`, so they cannot disagree about the title or the language.
 */
export function applyXmpWithPikepdf(
  pdfPath: string,
  metadata: FileMetadata
): Promise<{ success: boolean; error?: string }> {
  return runPikepdf({ pdfPath, xmp: buildXmpXml(metadata), ...buildDocInfo(metadata) })
}

/**
 * Check once whether Python + pikepdf are actually available, so the app can
 * warn instead of silently producing PDFs with no metadata.
 */
let pikepdfAvailable: { ok: boolean; detail: string } | null = null

export async function checkPikepdfAvailable(
  force = false
): Promise<{ ok: boolean; detail: string }> {
  if (pikepdfAvailable && !force) return pikepdfAvailable

  const candidates = pythonCandidates()

  const probe = (exe: string): Promise<{ ok: boolean; detail: string }> =>
    new Promise((resolve) => {
      const proc = spawn(exe, ['-c', 'import pikepdf; print(pikepdf.__version__)'], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let out = ''
      let err = ''
      proc.stdout.on('data', (d: Buffer) => {
        out += d.toString()
      })
      proc.stderr.on('data', (d: Buffer) => {
        err += d.toString()
      })
      proc.on('error', (e) => resolve({ ok: false, detail: e.message }))
      proc.on('close', (code) => {
        if (code === 0) resolve({ ok: true, detail: `${exe} / pikepdf ${out.trim()}` })
        else resolve({ ok: false, detail: err.trim() || `exit code ${code}` })
      })
    })

  let lastDetail = 'no interpreter found'
  for (const exe of candidates) {
    const result = await probe(exe)
    if (result.ok) {
      pikepdfAvailable = result
      return result
    }
    lastDetail = `${exe}: ${result.detail}`
  }

  pikepdfAvailable = {
    ok: false,
    detail: `Python/pikepdf not available (tried: ${candidates.join(', ')}). Last error — ${lastDetail}`
  }
  return pikepdfAvailable
}
