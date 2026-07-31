import { getApiClient } from './api-client'
import { tagCacheRepo } from '../db/repositories/tag-cache.repo'
import { getLogger } from './logger'

const log = getLogger('tags')

/** The documented maximum for GET /tags/ids. */
const BATCH_SIZE = 100

/**
 * How many batches one resolve call will fetch.
 *
 * The endpoint is 15/min. A page of 25 search results can reference a few
 * hundred distinct tags, which on a cold cache is more batches than the limit
 * allows — so a single call is capped and the rest resolve on the next page or
 * the next search. Dim mode degrades to "not dimmed yet" in the meantime, which
 * is the safe direction: it shows you something you asked to de-emphasise rather
 * than hiding something you wanted.
 */
const MAX_BATCHES_PER_CALL = 3

export interface ResolvedTag {
  type: string
  name: string
}

/**
 * Resolve tag ids to types and names, cache first.
 *
 * Always returns whatever is known, even if the network fails — callers use this
 * to decide whether to mark a result, and an empty answer must mean "not known
 * yet" rather than an error to handle.
 */
export async function resolveTagNames(ids: readonly number[]): Promise<Map<number, ResolvedTag>> {
  const resolved = new Map<number, ResolvedTag>()
  const wanted = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0)
  if (wanted.length === 0) return resolved

  for (const row of tagCacheRepo.findByIds(wanted)) {
    resolved.set(row.id, { type: row.type, name: row.name })
  }

  const missing = wanted.filter((id) => !resolved.has(id))
  if (missing.length === 0) return resolved

  const batches: number[][] = []
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    batches.push(missing.slice(i, i + BATCH_SIZE))
  }

  const capped = batches.slice(0, MAX_BATCHES_PER_CALL)
  if (batches.length > capped.length) {
    log.debug(
      `Resolving ${capped.length} of ${batches.length} tag batches; ` +
        `${missing.length} ids missing from cache. The rest resolve on a later call.`
    )
  }

  const client = getApiClient()

  for (const batch of capped) {
    try {
      const tags = await client.getTagsByIds(batch)
      if (tags.length === 0) continue

      tagCacheRepo.upsertMany(tags.map((tag) => ({ id: tag.id, type: tag.type, name: tag.name })))
      for (const tag of tags) {
        if (tag.id > 0 && tag.name) resolved.set(tag.id, { type: tag.type, name: tag.name })
      }
    } catch (err) {
      // Rate limiting is the expected failure here. Stop rather than hammering
      // the remaining batches, and keep what already resolved.
      log.warn(`Tag resolution stopped after a failed batch: ${String(err)}`)
      break
    }
  }

  return resolved
}

/**
 * Tag names for a set of galleries, keyed by gallery id.
 *
 * Takes every gallery's ids in one pass so common tags are resolved once for the
 * whole page rather than per card.
 */
export async function resolveGalleryTags(
  galleries: ReadonlyArray<{ id: number; tag_ids?: number[] }>
): Promise<Map<number, ResolvedTag[]>> {
  const everyId = galleries.flatMap((gallery) => gallery.tag_ids ?? [])
  const lookup = await resolveTagNames(everyId)

  const byGallery = new Map<number, ResolvedTag[]>()
  for (const gallery of galleries) {
    const tags: ResolvedTag[] = []
    for (const tagId of gallery.tag_ids ?? []) {
      const hit = lookup.get(tagId)
      if (hit) tags.push(hit)
    }
    byGallery.set(gallery.id, tags)
  }
  return byGallery
}
