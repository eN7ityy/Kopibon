#!/usr/bin/env node
/**
 * Rewrite ComicInfo.xml in CBZ files so Kavita groups them into series.
 *
 *   node tools/rewrite-comicinfo.mjs <directory> [options]
 *
 * Options
 *   --dry-run   Report what would change, write nothing.
 *   --db=PATH   Database location. Defaults to the app's.
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
const dbArg = argv.find((a) => a.startsWith('--db='))
const dbPath = dbArg ? dbArg.slice(5) : join(homedir(), '.config', 'doujin-downloader', 'db.sqlite')

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

const files = findCbz(target)
console.log(`directory  ${target}`)
console.log(`database   ${dbPath}`)
console.log(`files      ${files.length}`)
console.log(`mode       ${dryRun ? 'DRY RUN' : 'rewriting'}\n`)

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
  const id = basename(file).match(/\[nhentai-(\d+)\]/)?.[1]
  if (!id) {
    console.log(`  skip (no nhentai id): ${basename(file)}`)
    skipped++
    continue
  }

  const row = byGallery.get(Number(id))
  if (!row) {
    console.log(`  skip (not in library): ${basename(file)}`)
    skipped++
    continue
  }

  const series = (row.series_name || '').trim()
  const members = series ? membersOf.get(series).n : 0
  if (members < 2) {
    // A one-shot. Numbering it would give Kavita a one-chapter series per
    // file, which is the same mess from the other direction.
    console.log(`  skip (not in a series): ${basename(file)}`)
    skipped++
    continue
  }

  console.log(`  ${basename(file)}\n      Series="${series}"  Number=${row.series_index ?? '—'}`)
  if (dryRun) {
    rewritten++
    continue
  }

  const result = await applyMetadata(file, 'cbz', {
    title: row.custom_title || basename(file),
    creators: [row.primary_artist || 'Unknown'],
    tags: row.custom_tags ? row.custom_tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    nhentaiId: row.gallery_id,
    seriesName: series,
    seriesIndex: row.series_index,
    language: row.custom_language || row.language,
    publisher: row.publisher,
    description: row.description
  })

  if (result.success) rewritten++
  else {
    console.log(`      FAILED: ${result.error}`)
    failed++
  }
}

console.log(`\nrewritten  ${rewritten}`)
if (skipped) console.log(`skipped    ${skipped}`)
if (failed) console.log(`failed     ${failed}`)
if (dryRun) console.log('\nDry run — nothing was written.')

db.close()
