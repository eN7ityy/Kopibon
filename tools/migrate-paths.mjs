#!/usr/bin/env node
/**
 * Migrate the database to store relative paths.
 *
 *   node tools/migrate-paths.mjs [--dry-run]
 *
 * - Strips directory prefix from custom_cover_path / thumbnail_path
 * - Converts file_path from absolute to relative-to-library-root
 * - Converts conversion_queue.file_path the same way
 * - Sets sentinel rows so the app migration skips this work
 *
 * Backs up the database before making changes. Safe to re-run (sentinel
 * guards prevent double-migration).
 */
import { createRequire } from 'node:module'
import { existsSync, copyFileSync } from 'node:fs'
import { join, dirname, basename, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'))
const Database = require('better-sqlite3')

const dryRun = process.argv.includes('--dry-run')

const APP_DIR = process.env.KOPIBON_DATA_DIR || join(homedir(), '.config', 'kopibon')
const DB_PATH = join(APP_DIR, 'db.sqlite')

if (!existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH}`)
  process.exit(1)
}

// ── Backup ──────────────────────────────────────────────────────────────────
const backupPath = DB_PATH + '.bak'
if (!dryRun) {
  copyFileSync(DB_PATH, backupPath)
  console.log(`backup     ${backupPath}`)
}

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

const setting = (key) => {
  try {
    return db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? null
  } catch { return null }
}

const libraryRoot = (setting('libraryPath') || '').trim()
console.log(`database   ${DB_PATH}`)
console.log(`library    ${libraryRoot || '(not set)'}`)
console.log(`mode       ${dryRun ? 'DRY RUN' : 'migrate'}`)
console.log('')

// ── 1. Cover paths ─────────────────────────────────────────────────────────

const coverDone = db.prepare("SELECT value FROM app_settings WHERE key = '_migrated_cover_paths'").get()
if (coverDone) {
  console.log('cover paths already migrated, skipping')
} else {
  console.log('Migrating cover/thumbnail paths...')

  // Count before
  const before = db.prepare(
    "SELECT COUNT(*) AS n FROM library_item WHERE custom_cover_path LIKE '%/%' AND custom_cover_path IS NOT NULL"
  ).get()
  console.log(`  ${before.n} rows with absolute cover paths`)

  if (!dryRun) {
    // SQLite has no reverse() — extract basename in JS.
    for (const col of ['custom_cover_path', 'thumbnail_path']) {
      const rows = db.prepare(
        `SELECT id, ${col} FROM library_item WHERE ${col} IS NOT NULL AND ${col} LIKE '%/%'`
      ).all()
      const update = db.prepare(`UPDATE library_item SET ${col} = ? WHERE id = ?`)
      let changed = 0
      const tx = db.transaction(() => {
        for (const row of rows) {
          const val = row[col]
          const bn = basename(val)
          if (bn !== val) {
            update.run(bn, row.id)
            changed++
          }
        }
      })
      tx()
      console.log(`  ${col}: ${changed} rows updated`)
    }

    db.prepare(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('_migrated_cover_paths', '1', ?)"
    ).run(Date.now())
  } else {
    console.log('  (dry run — no changes)')
  }
}

// ── 2. file_path ────────────────────────────────────────────────────────────

const fileDone = db.prepare("SELECT value FROM app_settings WHERE key = '_migrated_file_paths'").get()
if (fileDone) {
  console.log('file_path already migrated, skipping')
} else if (!libraryRoot) {
  console.log('No library root set — cannot migrate file_path. Skipping.')
  console.log('  (The app migration will run when the library path is set.)')
} else {
  console.log(`\nMigrating file_path relative to ${libraryRoot}...`)

  // Count before
  const before = db.prepare(
    "SELECT COUNT(*) AS n FROM library_item WHERE file_path LIKE '/%'"
  ).get()
  console.log(`  ${before.n} rows with absolute file_path`)

  if (!dryRun) {
    const rows = db.prepare(
      'SELECT id, file_path FROM library_item WHERE file_path IS NOT NULL'
    ).all()

    const update = db.prepare('UPDATE library_item SET file_path = ? WHERE id = ?')
    let converted = 0
    let skipped = 0

    const tx = db.transaction(() => {
      for (const row of rows) {
        if (!isAbsolute(row.file_path)) { skipped++; continue }
        const rel = relative(libraryRoot, row.file_path)
        if (!rel.startsWith('..') && rel !== row.file_path) {
          update.run(rel, row.id)
          converted++
        } else {
          skipped++
        }
      }
    })
    tx()
    console.log(`  library_item: ${converted} converted, ${skipped} skipped (outside root or already relative)`)

    // Migrate conversion_queue
    for (const table of ['conversion_queue', 'scan_queue']) {
      const qRows = db.prepare(
        `SELECT id, file_path FROM ${table} WHERE file_path IS NOT NULL`
      ).all()

      if (qRows.length === 0) {
        console.log(`  ${table}: 0 rows, skipping`)
        continue
      }

      const qUpdate = db.prepare(`UPDATE ${table} SET file_path = ? WHERE id = ?`)
      let qConverted = 0
      let qSkipped = 0

      const qTx = db.transaction(() => {
        for (const row of qRows) {
          if (!isAbsolute(row.file_path)) { qSkipped++; continue }
          const rel = relative(libraryRoot, row.file_path)
          if (!rel.startsWith('..') && rel !== row.file_path) {
            qUpdate.run(rel, row.id)
            qConverted++
          } else {
            qSkipped++
          }
        }
      })
      qTx()
      console.log(`  ${table}: ${qConverted} converted, ${qSkipped} skipped`)
    }

    db.prepare(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('_migrated_file_paths', '1', ?)"
    ).run(Date.now())
  } else {
    console.log('  (dry run — no changes)')
  }
}

// ── Verify ──────────────────────────────────────────────────────────────────

console.log('\nVerification:')
const sample = db.prepare(
  'SELECT id, file_path, custom_cover_path FROM library_item LIMIT 3'
).all()
for (const row of sample) {
  console.log(`  id=${row.id}  file_path=${row.file_path}  cover=${row.custom_cover_path}`)
}

const remaining = db.prepare(
  "SELECT COUNT(*) AS n FROM library_item WHERE file_path LIKE '/%'"
).get()
console.log(`  Remaining absolute file_paths: ${remaining.n}`)

const remainingCovers = db.prepare(
  "SELECT COUNT(*) AS n FROM library_item WHERE custom_cover_path LIKE '%/%' AND custom_cover_path IS NOT NULL"
).get()
console.log(`  Remaining absolute cover paths: ${remainingCovers.n}`)

db.close()
console.log('\nDone.')
