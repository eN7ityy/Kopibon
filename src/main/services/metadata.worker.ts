/**
 * Metadata Worker Thread
 *
 * Offloads CPU-bound PDF metadata rewriting (pikepdf nuke + inject)
 * to a separate thread so library metadata edits don't freeze the UI.
 *
 * Uses pikepdf (Python) to completely strip old metadata and inject
 * fresh XMP in the Dr Stein format that Kavita requires.
 *
 * Message Protocol:
 *   Main → Worker: { type: 'apply', pdfPath, metadata: XmpMetadata }
 *   Worker → Main: { type: 'complete' }
 *                  { type: 'error', message }
 */

import { parentPort } from 'worker_threads'
import { applyXmpWithPikepdf, type XmpMetadata } from './xmp-inject'
import { createWorkerLogger } from './worker-logger'

interface ApplyCommand {
  type: 'apply'
  pdfPath: string
  metadata: XmpMetadata
}

const log = createWorkerLogger('worker:metadata')

parentPort?.on('message', async (cmd: ApplyCommand) => {
  if (cmd.type !== 'apply') {
    parentPort?.postMessage({ type: 'error', message: `Unknown command: ${(cmd as any).type}` })
    return
  }

  try {
    const result = await applyXmpWithPikepdf(cmd.pdfPath, cmd.metadata)
    if (result.success) {
      log.debug(`Metadata written to ${cmd.pdfPath}`)
      parentPort?.postMessage({ type: 'complete' })
    } else {
      log.error(`Metadata write failed: ${result.error || 'unknown error'}`, {
        filePath: cmd.pdfPath
      })
      parentPort?.postMessage({ type: 'error', message: result.error || 'pikepdf failed' })
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    log.error(`Metadata write threw: ${e.message}`, { err: e, filePath: cmd.pdfPath })
    parentPort?.postMessage({ type: 'error', message: e.message })
  }
})
