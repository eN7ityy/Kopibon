import { sql, eq, asc } from 'drizzle-orm'
import { getDatabase } from '../connection'
import { blockedValue } from '../schema'
import type { InferSelectModel } from 'drizzle-orm'
import type { BlockedEntry, BlockedMode, BlockedType } from '../../services/search-query'

export type BlockedValue = InferSelectModel<typeof blockedValue>

const VALID_TYPES: readonly BlockedType[] = [
  'tag',
  'artist',
  'group',
  'parody',
  'character',
  'language',
  'text'
]

const VALID_MODES: readonly BlockedMode[] = ['exclude', 'dim']

/** Reject anything not in the known sets, so a bad row cannot reach the query builder. */
function isValidType(type: string): type is BlockedType {
  return (VALID_TYPES as readonly string[]).includes(type)
}

function isValidMode(mode: string): mode is BlockedMode {
  return (VALID_MODES as readonly string[]).includes(mode)
}

export const blockedRepo = {
  list(): BlockedValue[] {
    const db = getDatabase()
    return db
      .select()
      .from(blockedValue)
      .orderBy(asc(blockedValue.type), asc(blockedValue.value))
      .all()
  },

  /**
   * The rows as the query builder wants them.
   *
   * Rows with an unrecognised type or mode are dropped rather than passed
   * through: a stale value would otherwise become a malformed query term, which
   * fails silently by returning the wrong galleries.
   */
  entries(): BlockedEntry[] {
    return this.list()
      .filter((row) => isValidType(row.type) && isValidMode(row.mode))
      .map((row) => ({
        type: row.type as BlockedType,
        value: row.value,
        mode: row.mode as BlockedMode
      }))
  },

  /**
   * Add one entry, or update its mode if the same type+value already exists.
   *
   * Re-adding an existing value with a different mode is the natural way to
   * change your mind about it, so that is treated as an update rather than a
   * duplicate-key failure.
   */
  add(type: string, value: string, mode: string): BlockedValue | null {
    const trimmed = value.trim()
    if (!trimmed || !isValidType(type) || !isValidMode(mode)) return null

    const db = getDatabase()
    db.run(
      sql`INSERT INTO blocked_value (type, value, mode, created_at)
          VALUES (${type}, ${trimmed}, ${mode}, ${Date.now()})
          ON CONFLICT (type, value COLLATE NOCASE) DO UPDATE SET mode = ${mode}`
    )

    return (
      db
        .select()
        .from(blockedValue)
        .where(
          sql`${blockedValue.type} = ${type} AND ${blockedValue.value} = ${trimmed} COLLATE NOCASE`
        )
        .get() ?? null
    )
  },

  /** Add many at once, returning how many were stored. */
  addMany(entries: Array<{ type: string; value: string; mode: string }>): number {
    let added = 0
    for (const entry of entries) {
      if (this.add(entry.type, entry.value, entry.mode)) added++
    }
    return added
  },

  setMode(id: number, mode: string): void {
    if (!isValidMode(mode)) return
    const db = getDatabase()
    db.update(blockedValue).set({ mode }).where(eq(blockedValue.id, id)).run()
  },

  remove(id: number): void {
    const db = getDatabase()
    db.delete(blockedValue).where(eq(blockedValue.id, id)).run()
  },

  clear(): void {
    const db = getDatabase()
    db.delete(blockedValue).run()
  }
}
