/**
 * Differential harness — JS side (dev tree only, never shipped).
 *
 * docs/rust-port/08-subsystem-plans/01 §8, 10-test-plan §3: one op per
 * invocation, JSON in, one JSON line out:
 *
 *   node tests/differential/harness.mjs <op> <input.json>|-   →   {"ok":true,"value":…}
 *                                                    {ok:false,error:"<verbatim JS error string>"}
 *
 * The 1.x side of every comparison is the REAL TypeScript source
 * (`src/main/services/**`), bundled once per invocation with the repo's own
 * esbuild — the same modules the shipped build compiles, unmodified (D8:
 * src/ is only ever read). The bundled ops cover the template engine, the
 * mappers, xml-utils, the FileMetadata adapters and the filename rules.
 *
 * Volatile fields are injectable per 07-metadata-spec §9: the XMP ops take
 * `now` (epoch ms) and run under a patched Date so both sides write the same
 * instant. No other wall-clock read exists on either side.
 */

import { buildSync } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')

/** The real 1.x modules, re-exported verbatim. */
const ENTRY = `
export * from '${ROOT}/src/main/services/metadata/template-engine'
export * from '${ROOT}/src/main/services/metadata/templates'
export * from '${ROOT}/src/main/services/metadata/mappers'
export * from '${ROOT}/src/main/services/metadata/file-metadata'
export * from '${ROOT}/src/main/services/xml-utils'
export * from '${ROOT}/src/main/services/gallery-filename'
export * from '${ROOT}/src/main/services/temp-path'
`

let mod = null

function bundle() {
  if (mod) return mod
  const outdir = mkdtempSync(join(tmpdir(), 'kopibon-harness-'))
  const outfile = join(outdir, 'bundle.cjs')
  buildSync({
    stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile,
    logLevel: 'silent',
  })
  mod = require(outfile)
  rmSync(outdir, { recursive: true, force: true })
  return mod
}

/** Run `fn` with `new Date()` / `Date.now()` frozen at `now` (epoch ms). */
function withFrozenNow(now, fn) {
  const RealDate = Date
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now)
      else super(...args)
    }
    static now() {
      return now
    }
  }
  globalThis.Date = FrozenDate
  try {
    return fn()
  } finally {
    globalThis.Date = RealDate
  }
}

/** JSON values a template context can carry. Absent key = undefined. */
function fromJson(v) {
  if (v === null) return null
  if (Array.isArray(v)) return v.map(fromJson)
  return v
}

/** A FileMetadata as the 1.x mappers expect it: ISO strings → Date. */
function asMeta(raw) {
  const meta = fromJson(raw)
  if (meta && typeof meta.releaseDate === 'string') {
    meta.releaseDate = new Date(meta.releaseDate)
  }
  return meta
}

function run(op, input) {
  const m = bundle()
  switch (op) {
    case 'renderTemplate':
      return m.renderTemplate(input.template, fromJson(input.context ?? {}))
    // makeFileMetadata applies the DEFAULT_FILE_METADATA fill — the same
    // fill the Rust side gets from serde(default) on FileMetadata.
    case 'buildComicInfoXml':
      return m.buildComicInfoXml(m.makeFileMetadata(asMeta(input.meta)))
    case 'buildXmpXml':
      return withFrozenNow(input.now, () =>
        m.buildXmpXml(m.makeFileMetadata(asMeta(input.meta)))
      )
    case 'buildKeywordTokens':
      return m.buildKeywordTokens(m.makeFileMetadata(asMeta(input.meta)))
    case 'buildDocInfo':
      return m.buildDocInfo(m.makeFileMetadata(asMeta(input.meta)))
    case 'comicInfoContext':
    case 'xmpContext': {
      const filled = m.makeFileMetadata(asMeta(input.meta))
      const ctx =
        op === 'comicInfoContext'
          ? m.comicInfoContext(filled)
          : withFrozenNow(input.now, () => m.xmpContext(filled))
      // Sort keys for a stable comparison shape; values stay verbatim.
      return Object.fromEntries(Object.keys(ctx).sort().map((k) => [k, ctx[k] ?? null]))
    }
    case 'escapeXml':
      return m.escapeXml(input.s)
    case 'decodeXmlEntities':
      return m.decodeXmlEntities(input.s)
    case 'toIsoLanguage':
      return m.toIsoLanguage(input.lang)
    case 'resolveLanguageName':
      return m.resolveLanguageName(input.candidates)
    case 'makeFileMetadata':
      return m.makeFileMetadata(fromJson(input.meta ?? {}))
    case 'fileMetadataFromGallery':
      return m.fileMetadataFromGallery(fromJson(input.gallery), fromJson(input.over ?? {}))
    case 'fileMetadataFromLibraryItem':
      return m.fileMetadataFromLibraryItem(fromJson(input.row), fromJson(input.over ?? {}))
    case 'fileMetadataFromPayload':
      return m.fileMetadataFromPayload(fromJson(input.payload), fromJson(input.over ?? {}))
    case 'applyGalleryIdToFilename':
      return m.applyGalleryIdToFilename(input.fileName, input.galleryId ?? null)
    case 'truncateToBytes':
      return m.truncateToBytes(input.value, input.maxBytes)
    case 'tempSiblingPath':
      return m.tempSiblingPath(input.finalPath, input.suffix ?? '.part')
    case 'jsToString':
      return String(input.n)
    case 'jsToFixed':
      return input.n.toFixed(input.f)
    case 'renderTemplateBatch':
      return input.cases.map((c) => {
        try {
          return { ok: true, value: m.renderTemplate(c.template, fromJson(c.context ?? {})) }
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
      })
    // Generic batch: run any list of ops in one process. Each item carries
    // {op, input}; errors travel in-band per item.
    case 'batch':
      return input.items.map((item) => {
        try {
          return { ok: true, value: run(item.op, item.input) }
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
      })
    default:
      throw new Error(`harness: unknown op "${op}"`)
  }
}

function main() {
  const [op, inputFile] = process.argv.slice(2)
  if (!op) {
    console.error('usage: node harness.mjs <op> <input.json|->')
    process.exit(2)
  }
  let input = {}
  if (inputFile && inputFile !== '-') {
    input = JSON.parse(readFileSync(inputFile, 'utf-8'))
  } else if (inputFile === '-') {
    input = JSON.parse(readFileSync(0, 'utf-8'))
  }
  try {
    const value = run(op, input)
    process.stdout.write(JSON.stringify({ ok: true, value }) + '\n')
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) + '\n'
    )
    process.exit(0) // errors travel in-band; a crash exit means a harness bug
  }
}

main()
