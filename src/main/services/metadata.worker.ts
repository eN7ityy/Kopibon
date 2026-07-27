/**
 * Metadata Worker Thread
 *
 * Offloads CPU-bound PDF metadata rewriting (pdf-lib read/modify/write)
 * to a separate thread so library metadata edits don't freeze the UI.
 *
 * Message Protocol:
 *   Main → Worker: { type: 'embed', pdfPath, metadata: GalleryMetadata }
 *                  { type: 'setSeries', pdfPath, seriesName }
 *   Worker → Main: { type: 'complete' }
 *                  { type: 'error', message }
 */

import { parentPort } from 'worker_threads'
import { embedMetadata, setSeries } from './metadata-writer'
import type { GalleryMetadata } from './metadata-writer'

interface EmbedCommand {
  type: 'embed'
  pdfPath: string
  metadata: GalleryMetadata
}

interface SetSeriesCommand {
  type: 'setSeries'
  pdfPath: string
  seriesName: string
}

type WorkerCommand = EmbedCommand | SetSeriesCommand

parentPort?.on('message', async (cmd: WorkerCommand) => {
  try {
    switch (cmd.type) {
      case 'embed':
        await embedMetadata(cmd.pdfPath, cmd.metadata)
        break
      case 'setSeries':
        await setSeries(cmd.pdfPath, cmd.seriesName)
        break
      default:
        parentPort?.postMessage({ type: 'error', message: `Unknown command: ${(cmd as any).type}` })
        return
    }
    parentPort?.postMessage({ type: 'complete' })
  } catch (err) {
    parentPort?.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
  }
})
