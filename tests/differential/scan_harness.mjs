/**
 * Differential harness — SCAN side (dev tree only, never shipped).
 *
 * Runs the REAL library-scanner.worker.ts (bundled once with esbuild, D8:
 * src/ read-only) as an actual Node worker_thread, against a scratch DB
 * resolved from KOPIBON_DATA_DIR (the worker opens its own connection via
 * openWorkerConnection → connection.ts:500-507).
 *
 *   KOPIBON_DATA_DIR=<scratch> node tests/differential/scan_harness.mjs <input.json|->
 *
 * input: { libraryRoot, thumbnailDir, now?, noPdftoppm? }
 * output: { ok, value: { events, result } } — events are every worker
 * message in order; result is the 'complete' payload.
 *
 * `noPdftoppm: true` runs the worker with pdftoppm unavailable (PATH wiped).
 * Historical note: this was the plan §6 interim baseline ("PDF thumbnails
 * absent, as on a poppler-less 1.x install") until the rasteriser escalation
 * (Q-S4/F1) resolved with pdfium-render — SC-01 now compares with both
 * sides rasterising for real. The flag is kept for removal-guard trees
 * (CBZ-only, unaffected) and any future rasteriser-absent coverage.
 */

import { buildSync } from 'esbuild'
import { readFileSync, mkdirSync, rmSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { Worker } from 'worker_threads'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')

const WORKER_TS = join(ROOT, 'src/main/services/library-scanner.worker.ts')

function bundleWorker() {
  const outdir = join(ROOT, 'tests/differential/.harness-cache')
  mkdirSync(outdir, { recursive: true })
  const outfile = join(outdir, `scan-worker-${process.pid}.cjs`)
  process.on('exit', () => {
    try {
      rmSync(outfile, { force: true })
    } catch {
      /* best effort */
    }
  })
  buildSync({
    stdin: { contents: `require(${JSON.stringify(WORKER_TS)})`, resolveDir: ROOT, loader: 'js' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile,
    logLevel: 'silent',
    external: ['better-sqlite3', 'sharp', 'yauzl', 'pdf-lib', 'electron'],
  })
  return outfile
}

function runScanWorker(input) {
  const workerPath = bundleWorker()
  const env = { ...process.env }
  if (input.noPdftoppm) {
    // Keep node runnable but drop the repo of pdftoppm: a PATH whose bins
    // cannot include it. pdftoppm lives in /usr/bin on this machine.
    env.PATH = '/nonexistent'
  }
  return new Promise((resolvePromise) => {
    const worker = new Worker(workerPath, { env })
    const events = []
    const timeout = setTimeout(() => {
      events.push({ type: 'harness_timeout' })
      worker.terminate()
    }, 120_000)
    worker.on('message', (event) => {
      events.push(event)
      if (event.type === 'complete') {
        clearTimeout(timeout)
        resolvePromise({ events, result: event.result })
        worker.terminate()
      }
    })
    worker.on('error', (err) => {
      clearTimeout(timeout)
      resolvePromise({ events, result: { error: String(err) } })
    })
    worker.on('exit', (code) => {
      clearTimeout(timeout)
      resolvePromise({ events, result: events.find((e) => e.type === 'complete')?.result ?? { exitCode: code } })
    })
    worker.postMessage({
      type: 'start',
      libraryRoot: input.libraryRoot,
      thumbnailDir: input.thumbnailDir,
    })
  })
}

async function main() {
  const [inputFile] = process.argv.slice(2)
  const input = inputFile && inputFile !== '-'
    ? JSON.parse(readFileSync(inputFile, 'utf-8'))
    : JSON.parse(readFileSync(0, 'utf-8'))
  try {
    const value = await runScanWorker(input)
    process.stdout.write(JSON.stringify({ ok: true, value }) + '\n')
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) + '\n'
    )
  }
}

main()
