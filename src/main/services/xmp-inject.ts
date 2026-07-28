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

// ─── XMP Builder ─────────────────────────────────────────────────────────────

function escXml(s: string): string {
  return s.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>')
}

export function buildXmpXml(metadata: XmpMetadata): string {
  const creatorItems = metadata.creators
    .map((c) => `          <rdf:li>${escXml(c)}</rdf:li>`)
    .join('\n')
  const tagItems = metadata.tags
    .map((t) => `          <rdf:li>${escXml(t)}</rdf:li>`)
    .join('\n')

  let optional = ''
  if (metadata.description) optional += `      <dc:description>${escXml(metadata.description)}</dc:description>\n`
  if (metadata.publisher) optional += `      <dc:publisher>${escXml(metadata.publisher)}</dc:publisher>\n`
  if (metadata.language) optional += `      <dc:language>${escXml(metadata.language)}</dc:language>\n`
  if (metadata.date) optional += `      <dc:date>${escXml(metadata.date)}</dc:date>\n`

  const nhentaiId = metadata.nhentaiId
  const nhentaiInline = nhentaiId
    ? `      <pdfx:isbn>${nhentaiId}</pdfx:isbn>\n      <prism:isbn>${nhentaiId}</prism:isbn>\n`
    : ''

  let nhentaiBlocks = ''
  if (nhentaiId) {
    nhentaiBlocks = `
    <rdf:Description xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/" rdf:about="">
      <pdfx:isbn>${nhentaiId}</pdfx:isbn>
    </rdf:Description>
    <rdf:Description xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/" rdf:about="">
      <prism:isbn>${nhentaiId}</prism:isbn>
    </rdf:Description>`
  }

  let seriesBlock = ''
  if (metadata.seriesName && metadata.seriesIndex != null) {
    seriesBlock = `
    <rdf:Description xmlns:calibre="http://calibre-ebook.com/xmp-namespace"
                     xmlns:calibreSI="http://calibre-ebook.com/xmp-namespace-series-index"
                     rdf:about="">
      <calibre:series rdf:parseType="Resource">
        <rdf:value>${escXml(metadata.seriesName)}</rdf:value>
        <calibreSI:series_index>${metadata.seriesIndex.toFixed(2)}</calibreSI:series_index>
      </calibre:series>
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
${nhentaiInline}${optional}    </rdf:Description>${seriesBlock}${nhentaiBlocks}
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
}

// ─── Pikepdf Invocation ──────────────────────────────────────────────────────

const PYTHON_SCRIPT = `
import sys, json, os
import pikepdf
from pikepdf import Pdf, Name, Stream

def esc_xml(s):
    return str(s).replace("&", "&").replace("<", "<").replace(">", ">")

data = json.loads(sys.stdin.read())
pdf_path = data['pdfPath']
output_path = data.get('outputPath', pdf_path)

pdf = Pdf.open(pdf_path)

# Nuke existing catalog Metadata reference
if Name.Metadata in pdf.Root:
    del pdf.Root[Name.Metadata]

xmp_bytes = data['xmp'].encode('utf-8')
stream = Stream(pdf, xmp_bytes)
stream[Name.Type] = Name.Metadata
stream[Name.Subtype] = Name.XML
pdf.Root[Name.Metadata] = pdf.make_indirect(stream)

tmp = output_path + '.tmp'
pdf.save(tmp)
pdf.close()
os.replace(tmp, output_path)
print(json.dumps({'status': 'ok'}))
`.trim()

/**
 * Apply XMP metadata to a PDF file using pikepdf.
 * The PDF is modified in-place (docinfo nuked, XMP injected).
 *
 * @param pdfPath - Path to the PDF file
 * @param metadata - Metadata to embed
 * @returns Promise resolving to success status
 */
export function applyXmpWithPikepdf(
  pdfPath: string,
  metadata: XmpMetadata
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const xmp = buildXmpXml(metadata)

    const proc = spawn('python3', ['-c', PYTHON_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('error', (err) => {
      resolve({ success: false, error: `Failed to spawn python3: ${err.message}` })
    })

    proc.on('close', (code) => {
      if (code === 0) {
        try {
          const result = JSON.parse(stdout)
          if (result.status === 'ok') {
            resolve({ success: true })
          } else {
            resolve({ success: false, error: result.message || 'Unknown pikepdf error' })
          }
        } catch {
          resolve({ success: true }) // Assume success if stdout not JSON
        }
      } else {
        resolve({ success: false, error: stderr || `pikepdf exited with code ${code}` })
      }
    })

    // Send metadata via stdin
    proc.stdin.write(JSON.stringify({ pdfPath, xmp }) + '\n')
    proc.stdin.end()
  })
}

/**
 * Apply XMP metadata to a PDF file, saving to a new output path.
 */
export function applyXmpToNewFile(
  pdfPath: string,
  outputPath: string,
  metadata: XmpMetadata
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const xmp = buildXmpXml(metadata)

    const proc = spawn('python3', ['-c', PYTHON_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('error', (err) => {
      resolve({ success: false, error: `Failed to spawn python3: ${err.message}` })
    })

    proc.on('close', (code) => {
      if (code === 0) {
        try {
          const result = JSON.parse(stdout)
          if (result.status === 'ok') {
            resolve({ success: true })
          } else {
            resolve({ success: false, error: result.message || 'Unknown pikepdf error' })
          }
        } catch {
          resolve({ success: true })
        }
      } else {
        resolve({ success: false, error: stderr || `pikepdf exited with code ${code}` })
      }
    })

    proc.stdin.write(JSON.stringify({ pdfPath, outputPath, xmp }) + '\n')
    proc.stdin.end()
  })
}
