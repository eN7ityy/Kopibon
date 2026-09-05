/**
 * Differential harness — REPO side (dev tree only, never shipped).
 *
 * The 1.x side of the grouped-view / series / startup-maintenance
 * comparisons is the REAL TypeScript source: library.repo.ts,
 * series.repo.ts, startup-maintenance.ts and series-grouping.ts, bundled
 * with the repo's own esbuild exactly like harness.mjs (D8: src/ is only
 * ever read).
 *
 * The DB these repos open is resolved from KOPIBON_DATA_DIR
 * (connection.ts:19-23) — the spawning test copies a fixture DB into a
 * scratch dir and sets that env var, so neither the live production DB nor
 * the real ~/.config/kopibon is ever touched (10-test-plan §8 rule 2).
 *
 *   KOPIBON_DATA_DIR=<scratch> node tests/differential/repo_harness.mjs <op> <input.json|->
 *
 * Ops that stamp wall-clock time accept `now` (epoch ms) and run under a
 * process-frozen Date, matching the FixedClock the Rust side passes.
 */

import { buildSync } from 'esbuild'
import { readFileSync, mkdirSync, rmSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')

const ENTRY = `
export * from '${ROOT}/src/main/db/repositories/library.repo'
export * from '${ROOT}/src/main/db/repositories/series.repo'
export * from '${ROOT}/src/main/db/repositories/settings.repo'
export * from '${ROOT}/src/main/db/repositories/sync.repo'
export * from '${ROOT}/src/main/services/startup-maintenance'
export * from '${ROOT}/src/main/services/series-grouping'
export * from '${ROOT}/src/main/db/connection'
export * from '${ROOT}/src/main/services/search-query'
`

let mod = null

function bundle() {
  if (mod) return mod
  const outdir = join(ROOT, 'tests/differential/.harness-cache')
  mkdirSync(outdir, { recursive: true })
  // Per-process file: parallel differential tests bundle concurrently.
  const outfile = join(outdir, `repo-bundle-${process.pid}.cjs`)
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
    // better-sqlite3 is a native addon — resolve from the repo's
    // node_modules at require time.
    external: ['better-sqlite3', 'electron'],
  })
  mod = require(outfile)
  return mod
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

function run(op, input) {
  const m = bundle()
  if (input.now !== undefined) installFrozenNow(input.now)
  switch (op) {
    // ─── series-grouping helpers (pure) ────────────────────────────────────
    case 'collatorCompareBatch': {
      // [a, b] pairs → compare signs — the collator parity probe. Same
      // options as series-grouping.ts:89 (titleCollator is module-private,
      // so the harness constructs the identical collator).
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
      return (input.pairs ?? []).map(([a, b]) => collator.compare(a, b))
    }
    case 'sortSeriesMembers':
      return m.sortSeriesMembers(input.members ?? [])
    case 'findVolumeGaps':
      return m.findVolumeGaps(input.indexes ?? [])
    case 'mergeSeriesFacts':
      return m.mergeSeriesFacts(input.members ?? [])
    case 'pickSeriesCover':
      return m.pickSeriesCover(input.members ?? [], {
        coverItemId: input.coverItemId ?? null,
        coverPath: input.coverPath ?? null,
      })
    case 'negationTerm':
      return m.negationTerm(input.entry)
    case 'queryHasField':
      return m.queryHasField(input.query, input.field)
    case 'buildSearchQuery':
      return m.buildSearchQuery(input.userQuery ?? '', input.defaults ?? {}, input.blocked ?? [])
    case 'matchDimEntries':
      return m.matchDimEntries(input.facts ?? {}, input.blocked ?? [])
    case 'isGroupableSeriesName':
      return m.isGroupableSeriesName(input.name ?? null)
    case 'normaliseSeriesName':
      return m.normaliseSeriesName(input.name ?? null)

    // ─── grouped view (read ops on the scratch copy) ───────────────────────
    case 'findPaginatedGrouped':
      return m.libraryRepo.findPaginatedGrouped({
        ...input.params,
        offset: input.offset ?? 0,
        limit: input.limit ?? 20,
        sortField: input.sortField,
        minMembers: input.minMembers,
      })
    case 'seriesFacts':
      return m.libraryRepo.seriesFacts(input.seriesId, input.params ?? {})
    case 'matchingMemberIds':
      return m.libraryRepo.matchingMemberIds(input.seriesId, input.params ?? {})

    // ─── write ops (mutate the scratch copy) ───────────────────────────────
    case 'backfillAll':
      return m.seriesRepo.backfillAll()
    case 'resolveFor':
      return m.seriesRepo.resolveFor(input.itemIds ?? [])
    case 'runStartupMaintenance':
      return m.runStartupMaintenance({
        completedRetentionDays: input.completedRetentionDays,
      })

    // ─── inspection / fixture seeding ─────────────────────────────────────
    case 'execSql': {
      // Test-fixture seeding: run the same statements the Rust test runs.
      const db = m.getRawDatabase()
      for (const stmt of input.statements ?? []) {
        db.prepare(stmt.sql).run(...(stmt.params ?? []))
      }
      return true
    }
    case 'dumpTables': {
      const db = m.getRawDatabase()
      const out = {}
      for (const t of input.tables ?? []) {
        out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()
      }
      return out
    }
    default:
      throw new Error(`repo_harness: unknown op "${op}"`)
  }
}

async function main() {
  const [op, inputFile] = process.argv.slice(2)
  if (!op) {
    console.error('usage: KOPIBON_DATA_DIR=<scratch> node repo_harness.mjs <op> <input.json|->')
    process.exit(2)
  }
  const input = inputFile && inputFile !== '-'
    ? JSON.parse(readFileSync(inputFile, 'utf-8'))
    : JSON.parse(readFileSync(0, 'utf-8'))
  try {
    const value = await run(op, input)
    process.stdout.write(JSON.stringify({ ok: true, value }) + '\n')
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) + '\n'
    )
  }
}

main()
