/**
 * Sync Worker Thread
 *
 * Fetches latest metadata from nhentai API for a gallery and
 * regenerates the file's metadata (XMP for PDF, ComicInfo for CBZ).
 *
 * Message Protocol:
 *   Main -> Worker: { type: 'sync', itemId, nhentaiId, filePath, apiKey, format }
 *   Worker -> Main: { type: 'complete', itemId, success }
 *                  { type: 'error', itemId, message }
 */

import { parentPort } from 'worker_threads'
import { applyXmpWithPikepdf, type XmpMetadata } from './xmp-inject'
import { applyMetadata, type MetadataPayload } from './apply-metadata'
import { resolveLanguageName } from './xml-utils'

interface SyncCommand {
  type: 'sync'
  itemId: number
  nhentaiId: number
  filePath: string
  apiKey?: string
  format?: string
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
        await new Promise((r) => setTimeout(r, retryAfter * 1000 + Math.random() * 1000))
        continue
      }

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
      }

      return await resp.json()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
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
    const gallery = await fetchGallery(cmd.nhentaiId, cmd.apiKey)

    const title = gallery.title?.pretty || gallery.title?.english || `Gallery #${cmd.nhentaiId}`
    const tags = gallery.tags || []
    const artistTags = tags.filter((t: any) => t.type === 'artist').map((t: any) => t.name)
    const groupTags = tags.filter((t: any) => t.type === 'group').map((t: any) => t.name)
    const allTags = tags.map((t: any) => t.name)
    // All language-type tags are candidates, in order. Taking only the first
    // picks 'translated' — an nhentai language-*type* tag that is not a
    // language — for most galleries, and this value is both embedded in the file
    // and stored in library_item.language below.
    const language = resolveLanguageName(
      (tags as { type: string; name: string }[])
        .filter((t) => t.type === 'language')
        .map((t) => t.name)
    )

    const hasArtist = artistTags.length > 0
    const hasGroup = groupTags.length > 0
    const publisher = hasGroup ? groupTags[0] : null

    let creators: string[]
    if (hasArtist) {
      creators = artistTags
    } else if (hasGroup) {
      creators = groupTags
    } else {
      creators = ['Unknown']
    }

    const date = gallery.upload_date
      ? new Date(gallery.upload_date * 1000).toISOString()
      : null

    const format = cmd.format || 'pdf'

    if (format === 'cbz') {
      const meta: MetadataPayload = { title, creators, tags: allTags, nhentaiId: cmd.nhentaiId, language, publisher, date }
      const result = await applyMetadata(cmd.filePath, 'cbz', meta)

      if (!result.success) {
        parentPort?.postMessage({ type: 'error', itemId: cmd.itemId, message: result.error || 'ComicInfo rewrite failed' })
        return
      }
    } else {
      const meta: XmpMetadata = { title, creators, tags: allTags, nhentaiId: cmd.nhentaiId, language, publisher, date }
      const result = await applyXmpWithPikepdf(cmd.filePath, meta)

      if (!result.success) {
        parentPort?.postMessage({ type: 'error', itemId: cmd.itemId, message: result.error || 'pikepdf failed' })
        return
      }
    }

    parentPort?.postMessage({
      type: 'complete',
      itemId: cmd.itemId,
      success: true,
      metadata: {
        title,
        primaryArtist: creators[0] || 'Unknown',
        tags: allTags.join(', '),
        language: language || null,
        publisher: publisher || null
      }
    })
  } catch (err) {
    parentPort?.postMessage({
      type: 'error',
      itemId: cmd.itemId,
      message: err instanceof Error ? err.message : String(err)
    })
  }
})
