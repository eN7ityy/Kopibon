/**
 * Sync Worker Thread
 *
 * Fetches latest metadata from nhentai API for a gallery and
 * regenerates the PDF's XMP metadata with up-to-date fields.
 *
 * Message Protocol:
 *   Main → Worker: { type: 'sync', itemId, nhentaiId, filePath, apiKey }
 *   Worker → Main: { type: 'complete', itemId, success }
 *                  { type: 'error', itemId, message }
 */

import { parentPort } from 'worker_threads'
import { applyXmpWithPikepdf, type XmpMetadata } from './xmp-inject'

interface SyncCommand {
  type: 'sync'
  itemId: number
  nhentaiId: number
  filePath: string
  apiKey?: string
}

const MAX_RETRIES = 3

async function fetchGallery(id: number, apiKey?: string): Promise<any> {
  let lastError: Error | null = null
  const headers: Record<string, string> = {
    'User-Agent': 'DoujinDownloader/1.0 (eN7ityy)'
  }
  if (apiKey) headers['Authorization'] = `Key ${apiKey}`

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(`https://nhentai.net/api/v2/galleries/${id}`, { headers })

      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get('Retry-After') || '5', 10)
        // Wait for specified delay + jitter
        await new Promise((r) => setTimeout(r, retryAfter * 1000 + Math.random() * 1000))
        continue
      }

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
      }

      return await resp.json()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      // Wait before retry
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 2000 + attempt * 1000))
      }
    }
  }

  throw lastError || new Error(`Failed to fetch gallery ${id} after ${MAX_RETRIES} retries`)
}

parentPort?.on('message', async (cmd: SyncCommand) => {
  if (cmd.type !== 'sync') return

  try {
    // Fetch gallery metadata from nhentai API
    const gallery = await fetchGallery(cmd.nhentaiId, cmd.apiKey)

    // Extract fields
    const title = gallery.title?.pretty || gallery.title?.english || `Gallery #${cmd.nhentaiId}`
    const tags = gallery.tags || []
    const artistTags = tags.filter((t: any) => t.type === 'artist').map((t: any) => t.name)
    const allTags = tags.map((t: any) => t.name)
    const langTag = tags.find((t: any) => t.type === 'language')
    const language = langTag?.name || null

    // Build XMP metadata
    const meta: XmpMetadata = {
      title,
      creators: artistTags.length > 0 ? artistTags : ['Unknown'],
      tags: allTags,
      nhentaiId: cmd.nhentaiId,
      language,
      date: gallery.upload_date
        ? new Date(gallery.upload_date * 1000).toISOString()
        : null
    }

    // Apply XMP to PDF
    const result = await applyXmpWithPikepdf(cmd.filePath, meta)

    if (result.success) {
      parentPort?.postMessage({ type: 'complete', itemId: cmd.itemId, success: true })
    } else {
      parentPort?.postMessage({
        type: 'error',
        itemId: cmd.itemId,
        message: result.error || 'pikepdf failed'
      })
    }
  } catch (err) {
    parentPort?.postMessage({
      type: 'error',
      itemId: cmd.itemId,
      message: err instanceof Error ? err.message : String(err)
    })
  }
})
