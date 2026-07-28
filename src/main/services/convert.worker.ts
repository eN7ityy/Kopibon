/**
 * Convert Worker Thread
 *
 * Processes a single library item: applies pikepdf XMP, renames file.
 * Multiple instances run in parallel, coordinated by the main process
 * which assigns items from a shared queue.
 *
 * Message Protocol:
 *   Main → Worker: { type: 'convert', item: { id, filePath, metadata } }
 *   Worker → Main: { type: 'done', itemId, success, newPath?, error?, log? }
 */

import { parentPort } from 'worker_threads'
import { applyXmpWithPikepdf, type XmpMetadata } from './xmp-inject'
import { renameSync, existsSync } from 'fs'
import { basename, dirname, join } from 'path'

interface ConvertCommand {
  type: 'convert'
  item: {
    id: number
    filePath: string
    metadata: XmpMetadata
  }
}

parentPort?.on('message', async (cmd: ConvertCommand) => {
  if (cmd.type !== 'convert') return

  const { id, filePath, metadata } = cmd.item
  let newPath: string | undefined

  try {
    // Step 1: Apply XMP via pikepdf
    const result = await applyXmpWithPikepdf(filePath, metadata)

    if (!result.success) {
      parentPort?.postMessage({
        type: 'done',
        itemId: id,
        success: false,
        error: result.error || 'pikepdf failed',
        log: `FAIL ${basename(filePath)}: ${result.error || 'pikepdf failed'}`
      })
      return
    }

    // Step 2: Rename file if needed (move [nhentai-XXXXX] to end)
    if (metadata.nhentaiId) {
      const dir = dirname(filePath)
      const currentName = basename(filePath)
      const prefixPattern = new RegExp(`^\\[nhentai-${metadata.nhentaiId}\\]\\s*`)

      if (prefixPattern.test(currentName)) {
        const newName = currentName
          .replace(prefixPattern, '')
          .replace(/\.pdf$/, '') + ` [nhentai-${metadata.nhentaiId}].pdf`
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
