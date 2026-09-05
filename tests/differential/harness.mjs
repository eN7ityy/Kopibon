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
import { mkdtempSync, readFileSync, mkdirSync, rmSync } from 'fs'
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
export * from '${ROOT}/src/main/services/cbz-generator'
export * from '${ROOT}/src/main/services/apply-metadata'
export * from '${ROOT}/src/main/services/xmp-inject'
`

let mod = null

function bundle() {
  if (mod) return mod
  // Bundle INSIDE the repo so `require('yazl')` etc. resolve to the repo's
  // own node_modules (external modules stay unbundled).
  const outdir = join(ROOT, 'tests/differential/.harness-cache')
  mkdirSync(outdir, { recursive: true })
  // Per-process file: parallel differential tests bundle concurrently.
  const outfile = join(outdir, `bundle-${process.pid}.cjs`)
  process.on('exit', () => {
    try {
      rmSync(outfile, { force: true })
    } catch {
      /* best effort */
    }
  })
  buildSync({
    stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile,
    logLevel: 'silent',
    external: ['sharp', 'yazl', 'yauzl', 'electron'],
  })
  mod = require(outfile)
  return mod
}

/**
 * Freeze `new Date()` / `Date.now()` at `now` (epoch ms).
 *
 * The patch is process-permanent: each harness invocation is a one-shot
 * node process, and the async writer paths (applyMetadata's promise
 * executor) land *after* the synchronous call returns, so a scoped
 * freeze would miss them (and 1.x's addBuffer default stamps `new Date()`).
 */
function withFrozenNow(now, fn) {
  installFrozenNow(now)
  return fn()
}
let _frozen = false
function installFrozenNow(now) {
  if (_frozen) return
  _frozen = true
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

async function run(op, input) {
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
    case 'generateCbz': {
      // 1.x generateCbz on synthetic pages: pages arrive as base64; they are
      // written to a scratch dir with the injected mtime so the ZIP DOS/UT
      // stamps are deterministic (07-metadata-spec §9).
      const { mkdtempSync, writeFileSync, utimesSync, chmodSync, readFileSync, rmSync } = await import('fs')
      const dir = mkdtempSync(join(tmpdir(), 'kopibon-cbz-'))
      try {
        const paths = (input.pages ?? []).map((b64, i) => {
          const p = join(dir, `page-${i}.jpg`)
          writeFileSync(p, Buffer.from(b64, 'base64'))
          // addFile stats the source file; pin the mode so the cell is
          // umask-independent (0644, the S3 observed shape).
          chmodSync(p, 0o644)
          const t = new Date(input.mtime * 1000)
          utimesSync(p, t, t)
          return p
        })
        const out = join(dir, 'out.cbz')
        // yazl's addBuffer stamps `new Date()` when no mtime is given, so
        // freeze the clock for the whole write (07-metadata-spec §9).
        const bytes = withFrozenNow(input.mtime * 1000, () =>
          m.generateCbz(
            paths,
            out,
            m.makeFileMetadata(asMeta(input.meta)),
            { quality: null, maxDimension: null }
          )
        )
        await bytes
        return readFileSync(out).toString('base64')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    case 'applyMetadata': {
      // The 1.x dispatcher: cbz → ComicInfo rewrite, pdf → pikepdf.
      const { mkdtempSync, copyFileSync, rmSync, readFileSync, utimesSync } = await import('fs')
      const dir = mkdtempSync(join(tmpdir(), 'kopibon-apply-'))
      try {
        const target = join(dir, 'target' + (input.format === 'cbz' ? '.cbz' : '.pdf'))
        copyFileSync(input.file, target)
        // Fix the copied file's mtime so the rewritten entries' DOS/UT stamps
        // are deterministic; the rewrite itself stamps addBuffer with
        // `new Date()`, so freeze the clock for the cbz path too.
        const t = new Date(input.mtime * 1000)
        utimesSync(target, t, t)
        let result
        if (input.format === 'cbz') {
          result = await withFrozenNow(input.mtime * 1000, () =>
            m.applyMetadata(target, input.format, m.makeFileMetadata(asMeta(input.meta)))
          )
        } else {
          // The PDF path renders the XMP synchronously (before the pikepdf
          // spawn), so freezing the clock covers MetadataDate / dc:date.
          result = await withFrozenNow(input.now ?? input.mtime * 1000, () =>
            m.applyMetadata(target, input.format, m.makeFileMetadata(asMeta(input.meta)))
          )
        }
        return { apply: result, bytes: readFileSync(target).toString('base64') }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    case 'countCbzPages':
      return m.countCbzPages(input.file)
    case 'renderTemplateBatch':
      return Promise.all(
        input.cases.map(async (c) => {
          try {
            return { ok: true, value: m.renderTemplate(c.template, fromJson(c.context ?? {})) }
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) }
          }
        })
      )
    // Generic batch: run any list of ops in one process. Each item carries
    // {op, input}; errors travel in-band per item.
    case 'batch':
      return Promise.all(
        input.items.map(async (item) => {
          try {
            return { ok: true, value: await run(item.op, item.input) }
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) }
          }
        })
      )
    default:
      throw new Error(`harness: unknown op "${op}"`)
  }
}

async function main() {
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
    const value = await run(op, input)
    process.stdout.write(JSON.stringify({ ok: true, value }) + '\n')
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) + '\n'
    )
    process.exit(0) // errors travel in-band; a crash exit means a harness bug
  }
}

main()
