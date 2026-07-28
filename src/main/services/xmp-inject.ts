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

  const nhentaiId = metadata.nhentaiId || ''
  const description = metadata.description || ''
  const publisher = metadata.publisher || ''
  const date = metadata.date || new Date().toISOString()
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, '.000000+00:00')

  let seriesBlock = ''
  if (metadata.seriesName && metadata.seriesIndex != null) {
    const authorSort = metadata.creators[0]?.split(' ').reverse().join(' ') || 'unknown'
    seriesBlock = `
    <rdf:Description xmlns:calibreSI="http://calibre-ebook.com/xmp-namespace-series-index" xmlns:calibre="http://calibre-ebook.com/xmp-namespace" rdf:about="">
      <calibre:series rdf:parseType="Resource">
        <rdf:value>${escXml(metadata.seriesName)}</rdf:value>
        <calibreSI:series_index>${metadata.seriesIndex.toFixed(2)}</calibreSI:series_index>
      </calibre:series>
      <calibre:timestamp>${date}</calibre:timestamp>
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
      </dc:publisher>
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
pdf.docinfo['/Keywords'] = data.get('keywords', '') + (', publisher:' + data.get('publisher', '') if data.get('publisher', '') else '')
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
    proc.stdin.write(JSON.stringify({
      pdfPath,
      xmp,
      title: metadata.title,
      author: metadata.creators.join(', '),
      keywords: metadata.tags.join(', '),
      publisher: metadata.publisher || ''
    }) + '\n')
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

    proc.stdin.write(JSON.stringify({
      pdfPath,
      outputPath,
      xmp,
      title: metadata.title,
      author: metadata.creators.join(', '),
      keywords: metadata.tags.join(', '),
      publisher: metadata.publisher || ''
    }) + '\n')
    proc.stdin.end()
  })
}
