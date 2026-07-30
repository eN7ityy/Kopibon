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
import { type XmpMetadata } from './xmp-inject'
import { applyMetadata } from './apply-metadata'
import { renameSync, existsSync } from 'fs'
import { basename, dirname, join } from 'path'

interface ConvertCommand {
  type: 'convert'
  item: {
    id: number
    filePath: string
    /** 'pdf' | 'cbz' — defaults to 'pdf' for older callers. */
    format?: string
    metadata: XmpMetadata
  }
}

parentPort?.on('message', async (cmd: ConvertCommand) => {
  if (cmd.type !== 'convert') return

  const { id, filePath, metadata } = cmd.item
  const format = cmd.item.format || 'pdf'
  let newPath: string | undefined

  try {
    // Step 1: Apply metadata via the format-aware dispatcher
    const result = await applyMetadata(filePath, format, metadata)

    if (!result.success) {
      const why = result.error || 'metadata write failed'
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
    parentPort?.postMessage({
      type: 'done',
      itemId: id,
      success: false,
      error: String(err),
      log: `ERROR ${basename(filePath)}: ${String(err)}`
    })
  }
})
