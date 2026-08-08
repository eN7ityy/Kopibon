#!/usr/bin/env node
/**
 * Rebuild every library thumbnail.
 *
 *   node tools/regenerate-thumbnails.mjs [options]
 *
 * Options
 *   --skip-existing     Leave covers that already exist. Use this to fill gaps
 *                       rather than to re-render at a new size.
 *   --concurrency=N     Files in flight. Default 4.
 *   --limit=N           Stop after N items. Useful for a trial run.
 *   --dry-run           Report what would happen, write nothing.
 *   --db=PATH           Database location. Defaults to the app's.
 *   --out=PATH          Thumbnail directory. Defaults to the configured one,
 *                       then to the app's default.
 *
 * Close the app first. It holds the database in WAL mode, and a scan running at
 * the same time would fight this for the same rows.
 *
 * Safe to interrupt: each item is written to a temporary file and moved into
 * place, so Ctrl-C can never leave a half-written cover behind. Re-running
 * simply carries on.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The project's own dependencies, so this uses the same sharp the app does.
const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'))
const Database = require('better-sqlite3')
const sharp = require('sharp')
const yauzl = require('yauzl')

// ─── Must match library-scanner.worker.ts ────────────────────────────────────

const THUMB_WIDTH = 600
const THUMB_HEIGHT = 800
const THUMB_QUALITY = 82

// Honour the same env var the app sets, so the tool reads the same database
// when run on a machine (or against a userData dir) that does not match the
// homedir convention — e.g. Windows, where the app lives under %APPDATA%.
const APP_DIR = process.env.KOPIBON_DATA_DIR || join(homedir(), '.config', 'kopibon')

// ─── Arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const options = {
  skipExisting: flag('skip-existing'),
  dryRun: flag('dry-run'),
  concurrency: Math.max(1, Number(value('concurrency', 4)) || 4),
  limit: Number(value('limit', 0)) || 0,
  dbPath: value('db', join(APP_DIR, 'db.sqlite')),
  outDir: value('out', null)
}

if (flag('help') || flag('h')) {
  console.log(
    [
      'Rebuild every library thumbnail.',
      '',
      '  --skip-existing   leave covers that already exist',
      '  --concurrency=N   files in flight (default 4)',
      '  --limit=N         stop after N items',
      '  --dry-run         report only, write nothing',
      '  --db=PATH         database location',
      '  --out=PATH        thumbnail directory'
    ].join('\n')
  )
  process.exit(0)
}

// ─── Database ────────────────────────────────────────────────────────────────

if (!existsSync(options.dbPath)) {
  console.error(`No database at ${options.dbPath}`)
  console.error('Pass --db=PATH if it lives somewhere else.')
  process.exit(1)
}

const db = new Database(options.dbPath)
// The app uses WAL; matching it avoids a mode switch on a database it may reopen.
db.pragma('journal_mode = WAL')

const setting = (key) => {
  try {
    return db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? null
  } catch {
    return null
  }
}

// Same precedence the app uses: the setting wins, then the default location.
const outDir =
  options.outDir || (setting('thumbnailPath') || '').trim() || join(APP_DIR, 'thumbnails')

if (outDir.startsWith('/tmp/')) {
  console.warn(`WARNING: ${outDir} is under /tmp, which is cleared on reboot.`)
  console.warn('         Every cover will disappear again. Set a thumbnail path in Settings.\n')
}

if (!options.dryRun) mkdirSync(outDir, { recursive: true })

const rows = db
  .prepare(
    `SELECT id, file_path, format
       FROM library_item
      WHERE file_path IS NOT NULL AND file_path != ''
      ORDER BY id`
  )
  .all()

const items = options.limit ? rows.slice(0, options.limit) : rows

console.log(`database   ${options.dbPath}`)
console.log(`thumbnails ${outDir}`)
console.log(`size       ${THUMB_WIDTH}x${THUMB_HEIGHT} JPEG q${THUMB_QUALITY}`)
console.log(`items      ${items.length}${options.limit ? ` (limited from ${rows.length})` : ''}`)
console.log(
  `mode       ${options.dryRun ? 'DRY RUN' : options.skipExisting ? 'fill gaps' : 'rebuild all'}`
)
console.log('')

// ─── Generation ──────────────────────────────────────────────────────────────

const thumbPathFor = (filePath) =>
  join(outDir, `${createHash('sha1').update(filePath).digest('hex').slice(0, 16)}.jpg`)

/** First image entry in a CBZ, skipping the metadata file. */
function firstCbzImage(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('could not open archive'))
      zip.readEntry()
      zip.on('entry', (entry) => {
        if (entry.fileName === 'ComicInfo.xml') return zip.readEntry()
        const chunks = []
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return reject(streamErr ?? new Error('no stream'))
          stream.on('data', (c) => chunks.push(c))
          stream.on('end', () => resolve(Buffer.concat(chunks)))
          stream.on('error', reject)
        })
      })
      zip.on('end', () => resolve(null))
      zip.on('error', reject)
    })
  })
}

function pdftoppm(pdfPath, destNoExt) {
  return new Promise((resolve, reject) => {
    execFile(
      'pdftoppm',
      [
        '-f',
        '1',
        '-l',
        '1',
        '-singlefile',
        '-jpeg',
        '-scale-to',
        String(THUMB_HEIGHT),
        pdfPath,
        destNoExt
      ],
      { timeout: 30_000 },
      (err) => (err ? reject(err) : resolve())
    )
  })
}

/**
 * Build one cover.
 *
 * Written to a temporary name and moved into place, so an interrupted run never
 * leaves a truncated JPEG that later looks like a valid cached cover.
 */
async function buildThumbnail(item) {
  const dest = thumbPathFor(item.file_path)

  if (options.skipExisting && existsSync(dest)) return { status: 'skipped', dest }
  if (!existsSync(item.file_path)) return { status: 'missing-source' }
  if (options.dryRun) return { status: 'would-build', dest }

  const tmp = `${dest}.${process.pid}.tmp`
  const isCbz =
    (item.format || '').toLowerCase() === 'cbz' || item.file_path.toLowerCase().endsWith('.cbz')

  try {
    if (isCbz) {
      const buf = await firstCbzImage(item.file_path)
      if (!buf) return { status: 'no-pages' }
      await sharp(buf)
        .resize(THUMB_WIDTH, THUMB_HEIGHT, { fit: 'inside' })
        .jpeg({ quality: THUMB_QUALITY })
        .toFile(tmp)
    } else {
      // pdftoppm appends its own .jpg, so hand it the stem.
      const stem = tmp.replace(/\.jpg\.\d+\.tmp$/, `.${process.pid}.pdftmp`)
      await pdftoppm(item.file_path, stem)
      const produced = [`${stem}.jpg`, `${stem}-1.jpg`].find((p) => existsSync(p))
      if (!produced) return { status: 'failed', error: 'pdftoppm produced nothing' }
      renameSync(produced, tmp)
    }

    renameSync(tmp, dest)
    return { status: 'built', dest, bytes: statSync(dest).size }
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* leftover temp file is harmless */
    }
    return { status: 'failed', error: String(err?.message ?? err) }
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const updateRow = db.prepare(
  'UPDATE library_item SET custom_cover_path = ?, thumbnail_path = ? WHERE id = ?'
)

const counts = { built: 0, skipped: 0, failed: 0, missing: 0, noPages: 0 }
let bytes = 0
let done = 0
const failures = []
const startedAt = Date.now()

function report(force = false) {
  // Throttled so a fast run does not spend its time writing to the terminal.
  if (!force && done % 25 !== 0) return
  const elapsed = (Date.now() - startedAt) / 1000
  const rate = done / Math.max(elapsed, 0.001)
  const remaining = items.length - done
  const eta = rate > 0 ? remaining / rate : 0
  const pct = ((done / items.length) * 100).toFixed(1)
  const mb = (bytes / 1024 / 1024).toFixed(0)
  process.stdout.write(
    `\r${String(done).padStart(5)}/${items.length}  ${pct.padStart(5)}%  ` +
      `${rate.toFixed(1).padStart(5)}/s  eta ${fmtDuration(eta)}  ` +
      `built ${counts.built}  failed ${counts.failed}  ${mb} MB   `
  )
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`
}

let cancelled = false
process.on('SIGINT', () => {
  cancelled = true
  process.stdout.write('\n\nInterrupted — finishing files already in flight…\n')
})

/** A fixed pool, so a big library cannot open thousands of files at once. */
async function runPool() {
  let next = 0
  const workers = Array.from({ length: options.concurrency }, async () => {
    while (!cancelled) {
      const index = next++
      if (index >= items.length) return
      const item = items[index]
      const result = await buildThumbnail(item)

      switch (result.status) {
        case 'built':
          counts.built++
          bytes += result.bytes ?? 0
          if (!options.dryRun) updateRow.run(result.dest, result.dest, item.id)
          break
        case 'would-build':
          counts.built++
          break
        case 'skipped':
          counts.skipped++
          break
        case 'missing-source':
          counts.missing++
          failures.push(`${item.file_path} — file not found`)
          break
        case 'no-pages':
          counts.noPages++
          failures.push(`${item.file_path} — no image in archive`)
          break
        default:
          counts.failed++
          failures.push(`${item.file_path} — ${result.error}`)
      }

      done++
      report()
    }
  })
  await Promise.all(workers)
}

await runPool()
report(true)

const elapsed = (Date.now() - startedAt) / 1000
console.log('\n')
console.log(`built          ${counts.built}`)
if (counts.skipped) console.log(`already there  ${counts.skipped}`)
if (counts.missing) console.log(`source missing ${counts.missing}`)
if (counts.noPages) console.log(`no pages       ${counts.noPages}`)
if (counts.failed) console.log(`failed         ${counts.failed}`)
console.log(`size on disk   ${(bytes / 1024 / 1024).toFixed(0)} MB`)
console.log(`took           ${fmtDuration(elapsed)}`)

if (failures.length > 0) {
  console.log(`\nfirst ${Math.min(failures.length, 15)} problems:`)
  for (const line of failures.slice(0, 15)) console.log(`  ${line}`)
  if (failures.length > 15) console.log(`  … and ${failures.length - 15} more`)
}

if (options.dryRun) console.log('\nDry run — nothing was written.')

db.close()
