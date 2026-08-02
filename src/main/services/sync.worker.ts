/**
 * Sync Worker Thread
 *
 * Fetches latest metadata from nhentai API for a gallery and
 * regenerates the file's metadata (XMP for PDF, ComicInfo for CBZ).
 *
 * Message Protocol:
 *   Main -> Worker: { type: 'sync', itemId, nhentaiId, filePath, apiKey, format,
 *                      seriesName, seriesIndex }
 *   Worker -> Main: { type: 'complete', itemId, success }
 *                  { type: 'error', itemId, message }
 */

import { parentPort } from 'worker_threads'
import { applyMetadata } from './apply-metadata'
import { fileMetadataFromGallery } from './metadata/file-metadata'
import { resolveLanguageName } from './xml-utils'
import { createWorkerLogger, type WorkerLogger } from './worker-logger'

interface SyncCommand {
  type: 'sync'
  itemId: number
  nhentaiId: number
  filePath: string
  apiKey?: string
  format?: string
  /**
   * The series this file belongs to, from the library row.
   *
   * Sent because nhentai has no concept of a series — it is the user's own
   * grouping, held only in our database. Without it a sync wrote Series as the
   * file's own title and no Number at all, so syncing a series member silently
   * dissolved it in Kavita and filed it as a Special.
   */
  seriesName?: string | null
  seriesIndex?: number | null
}

const MAX_RETRIES = 3

async function fetchGallery(id: number, apiKey: string | undefined, log: WorkerLogger): Promise<any> {
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
        // Rate limiting is the most common reason a sync appears to hang, and it
        // was previously invisible: `continue` doesn't count as an attempt, so
        // this can loop indefinitely with nothing on screen.
        log.warn(`Rate limited on gallery ${id}, waiting ${retryAfter}s`, { attempt })
        await new Promise((r) => setTimeout(r, retryAfter * 1000 + Math.random() * 1000))
        continue
      }

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
      }

      return await resp.json()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      // Each failed attempt is recorded, not just the last one. A 401 on attempt
      // 1 and a timeout on attempt 3 are very different problems, and the old
      // code reported only whichever came last.
      log.warn(`Fetch attempt ${attempt}/${MAX_RETRIES} failed for gallery ${id}: ${lastError.message}`)
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 2000 + attempt * 1000))
      }
    }
  }

  throw lastError || new Error(`Failed to fetch gallery ${id} after ${MAX_RETRIES} retries`)
}

parentPort?.on('message', async (cmd: SyncCommand) => {
  if (cmd.type !== 'sync') return

  const log = createWorkerLogger('worker:sync', String(cmd.nhentaiId))

  try {
    log.info(`Syncing metadata for gallery ${cmd.nhentaiId} (item ${cmd.itemId})`)
    const gallery = await fetchGallery(cmd.nhentaiId, cmd.apiKey, log)

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

    const format = cmd.format || 'pdf'

    /*
     * Built from the API gallery, so the typed tags survive: parodies and
     * categories become Genres, characters become Characters. The flat payload
     * this used to build had none of those fields, so every sync stripped them.
     *
     * The series comes from our own database — nhentai does not have one.
     */
    const meta = fileMetadataFromGallery(
      {
        id: cmd.nhentaiId,
        title: gallery.title || { english: title, japanese: null, pretty: title },
        tags,
        uploadDate: gallery.upload_date ?? 0,
        numPages: gallery.num_pages ?? 0
      },
      {
        title,
        seriesName: cmd.seriesName ?? null,
        seriesIndex: cmd.seriesIndex ?? null,
        format
      }
    )

    // One call for both formats: applyMetadata already branches on format, and
    // building the payload twice is how the two sides used to drift apart.
    const result = await applyMetadata(cmd.filePath, format, meta)

    if (!result.success) {
      const what = format === 'cbz' ? 'ComicInfo rewrite' : 'XMP write'
      log.error(`${what} failed: ${result.error || 'unknown error'}`, {
        filePath: cmd.filePath
      })
      parentPort?.postMessage({
        type: 'error',
        itemId: cmd.itemId,
        message: result.error || `${what} failed`
      })
      return
    }

    log.info(`Sync complete for gallery ${cmd.nhentaiId}`, {
      format,
      language: language || 'unresolved',
      tagCount: allTags.length
    })

    parentPort?.postMessage({
      type: 'complete',
      itemId: cmd.itemId,
      success: true,
      /**
       * The typed tags, alongside the flat list.
       *
       * `customTags` throws the types away, so a synced item had no way to show
       * genre or parody separately — the detail panel could only ever render one
       * undifferentiated tag list. The download path already persists these;
       * sync now does too, which is what lets an existing library be backfilled
       * with "Sync with Nhentai".
       */
      rawTags: (tags as Array<{ id?: number; type: string; name: string }>).map((t) => ({
        id: t.id ?? 0,
        type: t.type,
        name: t.name
      })),
      /**
       * The whole API response, so the cached row can be brought up to the
       * standard of a freshly downloaded one.
       *
       * Sync used to post back the tags alone, and main wrote only those — so
       * every other field the request had already paid for was discarded: the
       * Japanese title, the favourites count, the cover and thumbnail paths,
       * the media id. Measured on this library, 837 rows had been enriched by
       * a sync and were still missing all of it.
       */
      gallery,
      metadata: {
        title,
        primaryArtist: creators[0] || 'Unknown',
        tags: allTags.join(', '),
        language: language || null,
        publisher: publisher || null
      }
    })
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    log.error(`Sync failed for gallery ${cmd.nhentaiId}: ${e.message}`, { err: e })
    parentPort?.postMessage({ type: 'error', itemId: cmd.itemId, message: e.message })
  }
})
