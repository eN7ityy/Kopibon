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

interface ApplyCommand {
  type: 'apply'
  pdfPath: string
  metadata: XmpMetadata
}

parentPort?.on('message', async (cmd: ApplyCommand) => {
  if (cmd.type !== 'apply') {
    parentPort?.postMessage({ type: 'error', message: `Unknown command: ${(cmd as any).type}` })
    return
  }

  try {
    const result = await applyXmpWithPikepdf(cmd.pdfPath, cmd.metadata)
    if (result.success) {
      parentPort?.postMessage({ type: 'complete' })
    } else {
      parentPort?.postMessage({ type: 'error', message: result.error || 'pikepdf failed' })
    }
  } catch (err) {
    parentPort?.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
  }
})
