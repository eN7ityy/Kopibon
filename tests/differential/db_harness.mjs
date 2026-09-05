/**
 * Differential harness — DB side (dev tree only, never shipped).
 * docs/rust-port/08-subsystem-plans/05 §8: opens a **byte copy** of the
 * production DB with better-sqlite3 (the 1.x engine, readonly for read
 * parity) and prints one JSON envelope per op, same protocol as
 * harness.mjs:
 *
 *   node tests/differential/db_harness.mjs <op> <input.json|->
 *
 * Ops: findPaginated | findAllIds | autocompleteArtists | autocompleteSeries
 * Never writes: the copy stays pristine (the live production DB is never
 * opened by any test, 10-test-plan §8 rule 2).
 */

import Database from 'better-sqlite3'
import { readFileSync } from 'fs'

const DB_COPY = 'testdata/db/production-copy.sqlite'

function open() {
  const db = new Database(DB_COPY, { readonly: true })
  return db
}

function rowToPlain(rows) {
  // better-sqlite3 rows are plain objects already; normalise key order for
  // a stable comparison shape.
  return rows.map((r) => Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k] ?? null])))
}

function run(op, input) {
  const db = open()
  try {
    switch (op) {
      case 'findPaginated': {
        const where = buildWhere(input.params ?? {})
        const sort = {
          title: 'custom_title COLLATE NOCASE ASC',
          artist: 'primary_artist COLLATE NOCASE ASC',
          added: 'added_at DESC',
        }[input.sortField ?? 'added']
        const total = db
          .prepare(`SELECT COUNT(*) AS c FROM library_item ${where.sql}`)
          .get(...where.params).c
        const items = db
          .prepare(
            `SELECT * FROM library_item ${where.sql} ORDER BY ${sort} LIMIT ? OFFSET ?`
          )
          .all(...where.params, input.limit ?? 20, input.offset ?? 0)
        return { items: rowToPlain(items), total }
      }
      case 'findAllIds': {
        const where = buildWhere(input.params ?? {})
        const rows = db
          .prepare(`SELECT id, format FROM library_item ${where.sql} ORDER BY id ASC`)
          .all(...where.params)
        return rows
      }
      case 'autocompleteArtists': {
        return db
          .prepare(
            'SELECT artist_name, COUNT(*) AS count FROM library_item_artist WHERE artist_name LIKE ? GROUP BY artist_name ORDER BY count DESC LIMIT 10'
          )
          .all(`%${input.query}%`)
          .map((r) => r.artist_name)
      }
      case 'autocompleteSeries': {
        return db
          .prepare(
            "SELECT DISTINCT series_name FROM library_item WHERE series_name LIKE ? AND series_name != '' AND series_name IS NOT NULL ORDER BY series_name COLLATE NOCASE ASC LIMIT 10"
          )
          .all(`%${input.query}%`)
          .map((r) => r.series_name)
      }
      default:
        throw new Error(`db_harness: unknown op "${op}"`)
    }
  } finally {
    db.close()
  }
}

/** buildLibraryFilter port (library.repo.ts:46-98) — the JS reference. */
function buildWhere(params) {
  const conds = []
  const paramsOut = []
  const esc = (v) => v.replace(/[\\%_]/g, (c) => `\\${c}`)

  if (params.searchQuery && params.searchQuery.trim()) {
    const pattern = `%${esc(params.searchQuery.trim())}%`
    const columns = [
      'custom_title', 'primary_artist', 'series_name',
      'custom_tags', 'publisher', 'language', 'description',
    ]
    const ors = columns.map((c) => `${c} LIKE ? ESCAPE '\\' COLLATE NOCASE`)
    ors.push(`CAST(gallery_id AS TEXT) LIKE ? ESCAPE '\\'`)
    conds.push(`(${ors.join(' OR ')})`)
    for (let i = 0; i < ors.length; i++) paramsOut.push(pattern)
  }
  if (params.artistFilters?.length) {
    conds.push(`primary_artist IN (${params.artistFilters.map(() => '?').join(', ')})`)
    paramsOut.push(...params.artistFilters)
  }
  if (params.seriesFilters?.length) {
    conds.push(`series_name IN (${params.seriesFilters.map(() => '?').join(', ')})`)
    paramsOut.push(...params.seriesFilters)
  }
  if (params.tagFilters?.length) {
    const ors = params.tagFilters.map(
      (t) => `custom_tags LIKE ? ESCAPE '\\' COLLATE NOCASE`
    )
    conds.push(`(${ors.join(' OR ')})`)
    paramsOut.push(...params.tagFilters.map((t) => `%${esc(t)}%`))
  }
  if (params.showUnmatchedOnly) {
    conds.push(`(gallery_id IS NULL OR gallery_id = 0)`)
  }
  return { sql: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params: paramsOut }
}

async function main() {
  const [op, inputFile] = process.argv.slice(2)
  if (!op) {
    console.error('usage: node db_harness.mjs <op> <input.json|->')
    process.exit(2)
  }
  const input = inputFile && inputFile !== '-'
    ? JSON.parse(readFileSync(inputFile, 'utf-8'))
    : JSON.parse(readFileSync(0, 'utf-8'))
  try {
    const value = run(op, input)
    process.stdout.write(JSON.stringify({ ok: true, value }) + '\n')
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) + '\n'
    )
  }
}

main()
