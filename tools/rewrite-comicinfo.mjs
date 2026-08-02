#!/usr/bin/env node
/**
 * Rewrite ComicInfo.xml in CBZ files so Kavita groups them into series.
 *
 *   node tools/rewrite-comicinfo.mjs <directory> [options]
 *
 * Options
 *   --dry-run   Report what would change, write nothing.
 *   --limit=N   Stop after N files. Useful for a trial run.
 *   --db=PATH   Database location. Defaults to the app's.
 *   --templates=PATH
 *               Metadata template directory. Defaults to the copy the app
 *               seeded under userData, so this writes exactly what the app
 *               writes — including any edits made to the templates.
 *
 * Why this exists
 * ---------------
 * Files were written with `Series` set to the file's own title and with nothing
 * numbering them. Kavita groups on Series and orders on Number, so every
 * instalment arrived as its own single-file series, and files carrying neither
 * Number nor Volume were filed as Specials.
 *
 * The database has the right answer — the scanner learned each series from the
 * folder layout — so this reconciles the files to it. The emitter is fixed for
 * everything written from now on; this is for what already exists.
 *
 * Files are matched to library rows by the `[nhentai-<id>]` in their name, so a
 * copy of the library can be corrected without touching the original.
 *
 * Safe to interrupt: each archive is rebuilt beside itself and moved into place,
 * so a kill can never leave a half-written CBZ.
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'))
const Database = require('better-sqlite3')

const argv = process.argv.slice(2)
const target = argv.find((a) => !a.startsWith('--'))
const dryRun = argv.includes('--dry-run')
const limitArg = argv.find((a) => a.startsWith('--limit='))
const limit = limitArg ? Number(limitArg.slice(8)) || 0 : 0
const dbArg = argv.find((a) => a.startsWith('--db='))
const dbPath = dbArg ? dbArg.slice(5) : join(homedir(), '.config', 'doujin-downloader', 'db.sqlite')

/*
 * Use the same templates the app uses.
 *
 * Otherwise this tool would rewrite thousands of files with the shipped
 * defaults, silently undoing whatever the user changed. The repository copy is
 * the fallback, which is what a checkout with no installed app has.
 */
const templateArg = argv.find((a) => a.startsWith('--templates='))
const userTemplates = join(homedir(), '.config', 'doujin-downloader', 'metadata-templates')
const templateDir = templateArg
  ? templateArg.slice(12)
  : existsSync(userTemplates)
    ? userTemplates
    : null
if (templateDir) process.env.DOUJIN_TEMPLATE_DIR = templateDir

if (!target || !existsSync(target)) {
  console.error('Usage: node tools/rewrite-comicinfo.mjs <directory> [--dry-run] [--db=PATH]')
  process.exit(1)
}
if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}`)
  process.exit(1)
}

/*
 * The app's own metadata writer, bundled from source on the fly.
 *
 * Not imported from `out/`: that bundle is an Electron entry point and starts
 * the app when required. Bundling the source instead means this tool writes
 * byte-for-byte what the app writes, with no second implementation to drift.
 */
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

async function loadApplyMetadata() {
  const { build } = require('esbuild')
  const out = join(projectRoot, '.rewrite-comicinfo.bundle.cjs')
  await build({
    entryPoints: [join(projectRoot, 'src/main/services/apply-metadata.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    external: ['electron', 'better-sqlite3', 'sharp'],
    logLevel: 'error'
  })
  const mod = require(out)
  try {
    rmSync(out, { force: true })
  } catch {
    /* leftover bundle is harmless */
  }
  return mod.applyMetadata
}

const applyMetadata = await loadApplyMetadata()

console.log(`Templates: ${templateDir || 'repository defaults'}`)

const db = new Database(dbPath, { readonly: true })

/** Every .cbz under a directory. */
function findCbz(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findCbz(full))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.cbz')) out.push(full)
  }
  return out
}

const found = findCbz(target)
const files = limit ? found.slice(0, limit) : found
console.log(`directory  ${target}`)
console.log(`database   ${dbPath}`)
console.log(`files      ${files.length}${limit ? ` (limited from ${found.length})` : ''}`)
console.log(`mode       ${dryRun ? 'DRY RUN' : 'rewriting'}`)
console.log('')

/*
 * Progress on one rewriting line.
 *
 * Rewriting an archive means reading it and writing it back, so a library of
 * these takes minutes rather than seconds and needs to visibly be alive. Skips
 * and failures print on their own lines above the counter, so nothing is lost
 * behind the carriage return.
 */
const startedAt = Date.now()
let processed = 0

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s'
  const m = Math.floor(seconds / 60)
  const sec = Math.round(seconds % 60)
  return m > 0 ? `${m}m${String(sec).padStart(2, '0')}s` : `${sec}s`
}

function note(line) {
  // Clears the counter first, so the note is not printed over it.
  process.stdout.write(`\r${' '.repeat(78)}\r${line}\n`)
}

function report() {
  const elapsed = (Date.now() - startedAt) / 1000
  const rate = processed / Math.max(elapsed, 0.001)
  const eta = rate > 0 ? (files.length - processed) / rate : 0
  const pct = ((processed / files.length) * 100).toFixed(1)
  process.stdout.write(
    `\r${String(processed).padStart(5)}/${files.length}  ${pct.padStart(5)}%  ` +
      `${rate.toFixed(1).padStart(4)}/s  eta ${fmtDuration(eta)}  ` +
      `rewritten ${rewritten}  skipped ${skipped}  failed ${failed}   `
  )
}

const byGallery = db.prepare('SELECT * FROM library_item WHERE gallery_id = ?')

/*
 * How many library items share a series name.
 *
 * This, not "does the name differ from the title", decides whether a file is
 * part of a series. A series is very often named after its first instalment —
 * "Seijo no Mita Yume" volume 1 is titled exactly that — and the name test
 * wrongly called those one-shots, leaving volume 1 unnumbered while volume 2
 * was numbered. Kavita then filed volume 1 as a Special.
 */
const membersOf = db.prepare(
  'SELECT COUNT(*) AS n FROM library_item WHERE series_name = ? COLLATE NOCASE'
)

let rewritten = 0
let skipped = 0
let failed = 0

for (const file of files) {
  processed++
  const id = basename(file).match(/\[nhentai-(\d+)\]/)?.[1]
  if (!id) {
    note(`  skip, no nhentai id: ${basename(file)}`)
    skipped++
    report()
    continue
  }

  const row = byGallery.get(Number(id))
  if (!row) {
    note(`  skip, not in library: ${basename(file)}`)
    skipped++
    report()
    continue
  }

  const series = (row.series_name || '').trim()
  const members = series ? membersOf.get(series).n : 0
  if (members < 2) {
    // A one-shot. Numbering it would give Kavita a one-chapter series per
    // file, which is the same mess from the other direction.
    skipped++
    report()
    continue
  }

  if (dryRun) {
    note(
      `  ${basename(file).slice(0, 60)}\n      Series="${series}"  Number=${row.series_index ?? '—'}`
    )
    rewritten++
    report()
    continue
  }

  const result = await applyMetadata(file, 'cbz', {
    title: row.custom_title || basename(file),
    creators: [row.primary_artist || 'Unknown'],
    tags: row.custom_tags
      ? row.custom_tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [],
    nhentaiId: row.gallery_id,
    seriesName: series,
    seriesIndex: row.series_index,
    language: row.custom_language || row.language,
    publisher: row.publisher,
    description: row.description
  })

  if (result.success) rewritten++
  else {
    note(`  FAILED ${basename(file)}: ${result.error}`)
    failed++
  }
  report()
}

console.log('\n')
console.log(`rewritten  ${rewritten}`)
if (skipped) console.log(`skipped    ${skipped}`)
if (failed) console.log(`failed     ${failed}`)
console.log(`took       ${fmtDuration((Date.now() - startedAt) / 1000)}`)
if (dryRun) console.log('\nDry run — nothing was written.')

db.close()
