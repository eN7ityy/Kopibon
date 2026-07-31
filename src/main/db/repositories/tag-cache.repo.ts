import { sql, inArray } from 'drizzle-orm'
import { getDatabase } from '../connection'
import { tagCache } from '../schema'
import type { InferSelectModel } from 'drizzle-orm'

export type CachedTag = InferSelectModel<typeof tagCache>

/**
 * Tag id → name, filled from `GET /api/v2/tags/ids`.
 *
 * Search results carry `tag_ids` and no names, so dim mode cannot tell whether a
 * result holds a blocked tag without this. Persisted because the endpoint is
 * rate limited (15/min) and tag ids are stable — once resolved, an id never
 * needs fetching again.
 */
export const tagCacheRepo = {
  /** Look up many ids at once, returning only the ones already known. */
  findByIds(ids: readonly number[]): CachedTag[] {
    if (ids.length === 0) return []
    const db = getDatabase()
    return db
      .select()
      .from(tagCache)
      .where(inArray(tagCache.id, [...ids]))
      .all()
  },

  /**
   * Which of these ids are not cached yet.
   *
   * The caller batches these into requests, so returning the gap rather than
   * making it work it out keeps the "don't refetch" rule in one place.
   */
  missingIds(ids: readonly number[]): number[] {
    if (ids.length === 0) return []
    const known = new Set(this.findByIds(ids).map((row) => row.id))
    // Deduplicate: a page of results repeats common tags many times over.
    return [...new Set(ids)].filter((id) => !known.has(id))
  },

  upsertMany(tags: ReadonlyArray<{ id: number; type: string; name: string }>): void {
    if (tags.length === 0) return
    const db = getDatabase()
    const now = Date.now()
    for (const tag of tags) {
      // Ignore anything without a usable id: id 0 is what this project's older
      // rows stored when the real id was unknown, and caching it would poison
      // every lookup for tag 0.
      if (!tag.id || !tag.name) continue
      db.run(
        sql`INSERT INTO tag_cache (id, type, name, updated_at)
            VALUES (${tag.id}, ${tag.type || 'tag'}, ${tag.name}, ${now})
            ON CONFLICT (id) DO UPDATE SET
              type = ${tag.type || 'tag'},
              name = ${tag.name},
              updated_at = ${now}`
      )
    }
  },

  count(): number {
    const db = getDatabase()
    const row = db
      .select({ n: sql<number>`count(*)` })
      .from(tagCache)
      .get()
    return row?.n ?? 0
  },

  clear(): void {
    const db = getDatabase()
    db.delete(tagCache).run()
  }
}
