/**
 * Convert Worker Thread
 *
 * Processes a single library item: re-applies its metadata, renames file.
 * Multiple instances run in parallel, coordinated by the main process
 * which assigns items from a shared queue.
 *
 * Metadata is written through applyMetadata(), which dispatches by format —
 * pikepdf for PDF, a ComicInfo.xml rewrite for CBZ. Calling pikepdf directly
 * here made "Convert Library Metadata" fail on every CBZ row.
 *
 * Message Protocol:
 *   Main → Worker: { type: 'convert', item: { id, filePath, format, metadata } }
 *   Worker → Main: { type: 'done', itemId, success, newPath?, error?, log? }
 */

import { parentPort } from 'worker_threads'
import { type MetadataPayload } from './metadata/file-metadata'
import { applyMetadata } from './apply-metadata'
import { renameSync, existsSync } from 'fs'
import { createWorkerLogger } from './worker-logger'
import { basename, dirname, join } from 'path'

interface ConvertCommand {
  type: 'convert'
  item: {
    id: number
    filePath: string
    /** 'pdf' | 'cbz' — defaults to 'pdf' for older callers. */
    format?: string
    metadata: MetadataPayload
  }
}

parentPort?.on('message', async (cmd: ConvertCommand) => {
  if (cmd.type !== 'convert') return

  const { id, filePath, metadata } = cmd.item
  const format = cmd.item.format || 'pdf'
  let newPath: string | undefined

  // The `log:` field on the messages below is a separate channel: the UI
  // collects those lines for the run's own log panel. This forwards the same
  // failures into the application log, where they survive the run and carry an
  // errorId the user can quote.
  const log = createWorkerLogger('worker:convert', String(id))

  try {
    // Step 1: Apply metadata via the format-aware dispatcher
    const result = await applyMetadata(filePath, format, metadata)

    if (!result.success) {
      const why = result.error || 'metadata write failed'
      log.error(`Metadata write failed for ${basename(filePath)}: ${why}`, { filePath, format })
      parentPort?.postMessage({
        type: 'done',
        itemId: id,
        success: false,
        error: why,
        log: `FAIL ${basename(filePath)}: ${why}`
      })
      return
    }

    // Step 2: Rename file if needed (move [nhentai-XXXXX] to end)
    if (metadata.nhentaiId != null) {
      const dir = dirname(filePath)
      const currentName = basename(filePath)
      const prefixPattern = new RegExp(`^\\[nhentai-${metadata.nhentaiId}\\]\\s*`)

      if (prefixPattern.test(currentName)) {
        // Preserve the real extension — this used to hardcode .pdf, which
        // would have renamed a .cbz into a .pdf.
        const extMatch = currentName.match(/\.[A-Za-z0-9]+$/)
        const ext = extMatch ? extMatch[0] : format === 'cbz' ? '.cbz' : '.pdf'
        const newName = currentName
          .replace(prefixPattern, '')
          .replace(/\.[A-Za-z0-9]+$/, '') + ` [nhentai-${metadata.nhentaiId}]${ext}`
        newPath = join(dir, newName)

        if (newPath !== filePath && existsSync(filePath)) {
          try {
            renameSync(filePath, newPath)
          } catch (renameErr) {
            // Metadata landed, so this is reported as a success; the file just
            // keeps its old name. Warn rather than error, but do not stay silent
            // — the user asked for the rename and did not get it.
            log.warn(`Metadata written but rename failed for ${basename(filePath)}: ${String(renameErr)}`, {
              filePath,
              intendedPath: newPath
            })
            parentPort?.postMessage({
              type: 'done',
              itemId: id,
              success: true,
              newPath: filePath,
              log: `OK ${basename(filePath)} (rename failed: ${String(renameErr)})`
            })
            return
          }
        }
      }
    }

    parentPort?.postMessage({
      type: 'done',
      itemId: id,
      success: true,
      newPath: newPath || filePath,
      log: `OK ${basename(newPath || filePath)}`
    })
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    log.error(`Convert failed for ${basename(filePath)}: ${e.message}`, { err: e, filePath })
    parentPort?.postMessage({
      type: 'done',
      itemId: id,
      success: false,
      error: String(err),
      log: `ERROR ${basename(filePath)}: ${String(err)}`
    })
  }
})
