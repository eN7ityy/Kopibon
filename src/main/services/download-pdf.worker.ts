/**
 * Download PDF Worker Thread
 *
 * Offloads CPU-bound PDF generation (pdf-lib + sharp WebP conversion)
 * to a separate thread to keep the Electron main process responsive.
 * Same pattern as library-scanner.worker.ts.
 *
 * Message Protocol:
 *   Main → Worker: { type: 'generate', imagePaths: string[], outputPath: string, options: PdfOptions }
 *   Worker → Main: { type: 'progress', current: number, total: number }
 *                  { type: 'complete', outputPath: string }
 *                  { type: 'error', message: string }
 */

import { parentPort } from 'worker_threads'
import { generatePdf } from './pdf-generator'
import type { PdfOptions } from './pdf-generator'

interface GenerateCommand {
  type: 'generate'
  imagePaths: string[]
  outputPath: string
  options: PdfOptions
}

parentPort?.on('message', async (cmd: GenerateCommand) => {
  if (cmd.type !== 'generate') return

  try {
    const outputPath = await generatePdf(
      cmd.imagePaths,
      cmd.outputPath,
      cmd.options,
      (current, total) => {
        parentPort?.postMessage({ type: 'progress', current, total })
      }
    )
    parentPort?.postMessage({ type: 'complete', outputPath })
  } catch (err) {
    parentPort?.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
  }
})
