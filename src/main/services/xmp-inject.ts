/**
 * XMP Inject Utility — Dr Stein Format
 *
 * Generates Kavita-compatible XMP metadata in the Dr Stein (pikepdf) format
 * and applies it to PDFs via Python/pikepdf.
 *
 * The pikepdf approach is required because:
 * - pdf-lib cannot write custom XMP namespaces (calibre:series, pdfx:isbn)
 * - exiftool flattens nested rdf:Resource structures
 * - Only pikepdf produces the exact byte format Kavita expects
 */

import { spawn } from 'child_process'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface XmpMetadata {
  title: string
  creators: string[]
  tags: string[]
  nhentaiId?: number | null
  seriesName?: string | null
  seriesIndex?: number | null
  description?: string | null
  publisher?: string | null
  language?: string | null
  date?: string | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Characters that are illegal in XML 1.0 even when escaped. */
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g

/**
 * Escape text for inclusion in XML character data.
 *
 * This previously replaced each character with itself (`&` → `&`), which meant
 * any title containing an ampersand produced structurally invalid XMP. pikepdf
 * writes the packet as raw bytes without validating, so the damage only showed
 * up downstream in Kavita/Calibre/exiftool.
 */
function escXml(s: string): string {
  return s
    .replace(ILLEGAL_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Map human-readable language names to ISO 639-1 codes for dc:language. */
const LANGUAGE_TO_ISO: Record<string, string> = {
  english: 'en',
  japanese: 'ja',
  chinese: 'zh',
  korean: 'ko',
  french: 'fr',
  spanish: 'es',
  german: 'de',
  italian: 'it',
  portuguese: 'pt',
  russian: 'ru',
  other: 'ot'
}

function toIsoLanguage(lang: string | null | undefined): string | null {
  if (!lang) return null
  const lower = lang.toLowerCase().trim()
  if (!lower) return null
  if (/^[a-z]{2}$/.test(lower)) return lower
  return LANGUAGE_TO_ISO[lower] || lower
}

/**
 * Build the docinfo /Keywords token list.
 *
 * Kavita reads XMP, but our own library scanner also parses these tokens as a
 * fallback (and prefers them for language/series), so everything that matters
 * for a rescan-from-disk round trip is written here too.
 */
export function buildKeywordTokens(metadata: XmpMetadata): string[] {
  const tokens = [...metadata.tags]
  if (metadata.nhentaiId != null) tokens.push(`nhentai:${metadata.nhentaiId}`)
  if (metadata.seriesName) tokens.push(`calibre_series:${metadata.seriesName}`)
  if (metadata.seriesIndex != null) tokens.push(`series_index:${metadata.seriesIndex}`)
  // Human-readable here on purpose: the scanner reads this back into the UI,
  // while dc:language carries the ISO code that Kavita expects.
  if (metadata.language) tokens.push(`language:${metadata.language}`)
  if (metadata.publisher) tokens.push(`publisher:${metadata.publisher}`)
  return tokens
}

// ─── XMP Builder ─────────────────────────────────────────────────────────────

export function buildXmpXml(metadata: XmpMetadata): string {
  const creatorItems = metadata.creators
    .map((c) => `          <rdf:li>${escXml(c)}</rdf:li>`)
    .join('\n')
  const tagItems = metadata.tags
    .map((t) => `          <rdf:li>${escXml(t)}</rdf:li>`)
    .join('\n')

  const nhentaiId = metadata.nhentaiId || ''
  const description = metadata.description || ''
  const publisher = metadata.publisher || ''
  const date = metadata.date || new Date().toISOString()
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, '.000000+00:00')

  // dc:language must be an rdf:Bag of ISO 639-1 codes — this is the shape
  // calibre's `ebook-meta --language` produces and the only one Kavita reads
  // ("Kavita will only take the first" refers to the first rdf:li). A
  // plain-text <dc:language>en</dc:language> child is silently ignored.
  const isoLanguage = toIsoLanguage(metadata.language)
  const languageBlock = isoLanguage
    ? `
      <dc:language>
        <rdf:Bag>
          <rdf:li>${escXml(isoLanguage)}</rdf:li>
        </rdf:Bag>
      </dc:language>`
    : ''

  // Emit the calibre series block whenever there is a series name. The volume
  // number is optional — gating the whole block on it meant a series without
  // volumes was written nowhere in the file, so Kavita couldn't group it.
  let seriesBlock = ''
  if (metadata.seriesName) {
    const authorSort = metadata.creators[0]?.split(' ').reverse().join(' ') || 'unknown'
    const seriesIndexLine =
      metadata.seriesIndex != null
        ? `\n        <calibreSI:series_index>${metadata.seriesIndex.toFixed(2)}</calibreSI:series_index>`
        : ''
    seriesBlock = `
    <rdf:Description xmlns:calibreSI="http://calibre-ebook.com/xmp-namespace-series-index" xmlns:calibre="http://calibre-ebook.com/xmp-namespace" rdf:about="">
      <calibre:series rdf:parseType="Resource">
        <rdf:value>${escXml(metadata.seriesName)}</rdf:value>${seriesIndexLine}
      </calibre:series>
      <calibre:timestamp>${escXml(date)}</calibre:timestamp>
      <calibre:title_sort>${escXml(metadata.title)}</calibre:title_sort>
      <calibre:author_sort>${escXml(authorSort)}</calibre:author_sort>
    </rdf:Description>`
  }

  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" rdf:about="">
      <dc:title>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">${escXml(metadata.title)}</rdf:li>
        </rdf:Alt>
      </dc:title>
      <dc:description>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">${escXml(description)}</rdf:li>
        </rdf:Alt>
      </dc:description>
      <dc:creator>
        <rdf:Seq>
${creatorItems}
        </rdf:Seq>
      </dc:creator>
      <dc:subject>
        <rdf:Bag>
${tagItems}
        </rdf:Bag>
      </dc:subject>
      <dc:publisher>
        <rdf:Bag>${publisher ? `<rdf:li>${escXml(publisher)}</rdf:li>` : ''}</rdf:Bag>
      </dc:publisher>${languageBlock}
      <dc:date>
        <rdf:Seq>
          <rdf:li>${escXml(date)}</rdf:li>
        </rdf:Seq>
      </dc:date>
    <pdfx:isbn xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/">${nhentaiId}</pdfx:isbn><prism2:isbn xmlns:prism2="http://prismstandard.org/namespaces/basic/2.0/">${nhentaiId}</prism2:isbn><pdf:Producer xmlns:pdf="http://ns.adobe.com/pdf/1.3/">pikepdf 10.8.0</pdf:Producer></rdf:Description>
    <rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" rdf:about="">
      <xmp:MetadataDate>${now}</xmp:MetadataDate>
    </rdf:Description>${seriesBlock}
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
}

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
pdf.docinfo['/Producer'] = 'pikepdf 10.8.0'
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

function buildPayload(metadata: XmpMetadata, pdfPath: string, outputPath?: string): PikepdfPayload {
  return {
    pdfPath,
    ...(outputPath ? { outputPath } : {}),
    xmp: buildXmpXml(metadata),
    title: metadata.title,
    author: metadata.creators.join(', '),
    keywords: buildKeywordTokens(metadata).join(', ')
  }
}

/**
 * Apply XMP metadata to a PDF file using pikepdf.
 * The PDF is modified in-place (docinfo nuked, XMP injected).
 */
export function applyXmpWithPikepdf(
  pdfPath: string,
  metadata: XmpMetadata
): Promise<{ success: boolean; error?: string }> {
  return runPikepdf(buildPayload(metadata, pdfPath))
}

/**
 * Apply XMP metadata to a PDF file, saving to a new output path.
 */
export function applyXmpToNewFile(
  pdfPath: string,
  outputPath: string,
  metadata: XmpMetadata
): Promise<{ success: boolean; error?: string }> {
  return runPikepdf(buildPayload(metadata, pdfPath, outputPath))
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
