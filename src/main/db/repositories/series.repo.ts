import { getSqlite } from '../connection'
import {
  DEFAULT_MIN_SERIES_MEMBERS,
  UNGROUPABLE_NAMES,
  isGroupableSeriesName,
  normaliseSeriesName
} from '../../services/series-grouping'

/**
 * Series groups and the link between them and library items.
 *
 * Written through raw better-sqlite3 rather than Drizzle because every
 * statement here matches series names case-insensitively, and Drizzle's `eq()`
 * cannot express `COLLATE NOCASE` on a comparison — silently giving 'Dolls' and
 * 'dolls' two groups, which is the exact failure the unique index exists to
 * prevent.
 */

export interface SeriesRow {
  id: number
  name: string
  sort_name: string | null
  cover_item_id: number | null
  cover_path: string | null
  is_manual: number
  created_at: number
  updated_at: number
}

/** What a resolve pass changed, so callers can report it. */
export interface ResolveResult {
  /** Series names touched, whether or not they formed a visible group. */
  names: string[]
  /** Items whose `series_id` changed. */
  linked: number
  /** Items whose name was unusable, so their link was cleared. */
  cleared: number
  /** Groups that now hold enough members to be shown. */
  visibleGroups: number
}

export const seriesRepo = {
  findById(id: number): SeriesRow | undefined {
    return getSqlite().prepare('SELECT * FROM series WHERE id = ?').get(id) as SeriesRow | undefined
  },

  findByName(name: string): SeriesRow | undefined {
    return getSqlite().prepare('SELECT * FROM series WHERE name = ? COLLATE NOCASE').get(name) as
      SeriesRow | undefined
  },

  /**
   * The group for a name, creating it if this is the first time it is seen.
   *
   * `INSERT OR IGNORE` then select, rather than checking first and inserting:
   * the scanner resolves series from a worker thread while the main process may
   * be doing the same, and a check-then-insert loses that race against the
   * unique index.
   */
  findOrCreate(name: string): SeriesRow {
    const trimmed = normaliseSeriesName(name)
    if (!trimmed) throw new Error('A series needs a name')

    const sqlite = getSqlite()
    sqlite
      .prepare('INSERT OR IGNORE INTO series (name, created_at, updated_at) VALUES (?, ?, ?)')
      .run(trimmed, Date.now(), Date.now())

    const row = this.findByName(trimmed)
    if (!row) throw new Error(`Could not create the series "${trimmed}"`)
    return row
  },

  /**
   * Link items to their group, and pull in everything else sharing the name.
   *
   * The second half is the point: assigning a series to one gallery is supposed
   * to find the others that already carry it. So this links by *name* across the
   * whole library rather than only the ids handed in — otherwise a group would
   * form one member at a time and only ever contain items touched since the
   * feature was switched on.
   *
   * Idempotent, and safe to call on items that have no series: those get their
   * link cleared, which is what makes removing a series from an item also remove
   * it from the group.
   */
  resolveFor(itemIds: readonly number[]): ResolveResult {
    if (itemIds.length === 0) {
      return { names: [], linked: 0, cleared: 0, visibleGroups: 0 }
    }

    const sqlite = getSqlite()
    const placeholders = itemIds.map(() => '?').join(',')
    const rows = sqlite
      .prepare(`SELECT id, series_name FROM library_item WHERE id IN (${placeholders})`)
      .all(...itemIds) as Array<{ id: number; series_name: string | null }>

    // Distinct names, keyed case-insensitively so one group is resolved once
    // even when the members spell it differently.
    const names = new Map<string, string>()
    const unusable: number[] = []
    for (const row of rows) {
      if (isGroupableSeriesName(row.series_name)) {
        const name = normaliseSeriesName(row.series_name)!
        if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name)
      } else {
        unusable.push(row.id)
      }
    }

    const linkByName = sqlite.prepare(
      `UPDATE library_item SET series_id = ?
        WHERE series_name = ? COLLATE NOCASE
          AND (series_id IS NULL OR series_id != ?)`
    )
    const clearOne = sqlite.prepare(
      'UPDATE library_item SET series_id = NULL WHERE id = ? AND series_id IS NOT NULL'
    )

    let linked = 0
    let cleared = 0

    const run = sqlite.transaction(() => {
      for (const name of names.values()) {
        const group = this.findOrCreate(name)
        linked += Number(linkByName.run(group.id, name, group.id).changes ?? 0)
      }
      for (const id of unusable) {
        cleared += Number(clearOne.run(id).changes ?? 0)
      }
    })
    run()

    return {
      names: [...names.values()],
      linked,
      cleared,
      visibleGroups: this.countVisibleFor([...names.values()])
    }
  },

  /** How many of these names hold enough members to be shown as a group. */
  countVisibleFor(names: readonly string[], min = DEFAULT_MIN_SERIES_MEMBERS): number {
    if (names.length === 0) return 0
    const placeholders = names.map(() => '? COLLATE NOCASE').join(',')
    const row = getSqlite()
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT li.series_id FROM library_item li
             JOIN series s ON s.id = li.series_id
            WHERE s.name IN (${placeholders})
            GROUP BY li.series_id HAVING COUNT(*) >= ?
         )`
      )
      .get(...names, min) as { n: number }
    return row?.n ?? 0
  },

  /**
   * Link every item in the library, for first enabling the feature.
   *
   * Runs as one transaction over a whole-table update rather than per item: on
   * 4,636 rows the per-item version took long enough to need a progress bar,
   * and this does not.
   */
  backfillAll(): ResolveResult {
    const sqlite = getSqlite()

    const distinct = sqlite
      .prepare(
        `SELECT DISTINCT series_name FROM library_item
          WHERE series_name IS NOT NULL AND trim(series_name) != ''`
      )
      .all() as Array<{ series_name: string }>

    const names = new Map<string, string>()
    for (const row of distinct) {
      if (!isGroupableSeriesName(row.series_name)) continue
      const name = normaliseSeriesName(row.series_name)!
      if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name)
    }

    const insert = sqlite.prepare(
      'INSERT OR IGNORE INTO series (name, created_at, updated_at) VALUES (?, ?, ?)'
    )
    let linked = 0
    let cleared = 0

    const run = sqlite.transaction(() => {
      const now = Date.now()
      for (const name of names.values()) insert.run(name, now, now)

      // One statement for the whole library. Items whose name is not groupable
      // resolve to NULL through the correlated subquery, which also cleans up
      // links left behind if the ignore-list ever grows.
      const result = sqlite
        .prepare(
          `UPDATE library_item
              SET series_id = (SELECT s.id FROM series s
                                WHERE s.name = library_item.series_name COLLATE NOCASE)
            WHERE series_id IS NOT (SELECT s.id FROM series s
                                     WHERE s.name = library_item.series_name COLLATE NOCASE)`
        )
        .run()
      linked = Number(result.changes ?? 0)

      cleared = Number(
        sqlite
          .prepare(
            `UPDATE library_item SET series_id = NULL
              WHERE series_id IS NOT NULL
                AND (series_name IS NULL OR trim(series_name) = '')`
          )
          .run().changes ?? 0
      )
    })
    run()

    return {
      names: [...names.values()],
      linked,
      cleared,
      visibleGroups: this.countVisible()
    }
  },

  /**
   * What enabling grouping would produce, without writing anything.
   *
   * Backs the confirmation dialog. Deliberately computed rather than estimated:
   * the honest numbers on this library are 239 groups over 798 galleries, and a
   * dialog claiming 2,732 would be describing a different feature.
   */
  previewBackfill(min = DEFAULT_MIN_SERIES_MEMBERS): { groups: number; galleries: number } {
    // The ignore-list is bound as parameters from the same array the runtime
    // check uses, so the preview cannot promise a number the backfill will not
    // deliver — and nothing from that list is interpolated into SQL.
    const ignored = UNGROUPABLE_NAMES.map(() => '?').join(',')
    const row = getSqlite()
      .prepare(
        `SELECT COUNT(*) AS groups, COALESCE(SUM(n), 0) AS galleries FROM (
           SELECT COUNT(*) AS n FROM library_item
            WHERE series_name IS NOT NULL AND trim(series_name) != ''
              AND lower(trim(series_name)) NOT IN (${ignored})
            GROUP BY series_name COLLATE NOCASE
           HAVING COUNT(*) >= ?
         )`
      )
      .get(...UNGROUPABLE_NAMES, min) as { groups: number; galleries: number }
    return { groups: row?.groups ?? 0, galleries: row?.galleries ?? 0 }
  },

  /** Groups currently holding enough members to be shown. */
  countVisible(min = DEFAULT_MIN_SERIES_MEMBERS): number {
    const row = getSqlite()
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT series_id FROM library_item WHERE series_id IS NOT NULL
            GROUP BY series_id HAVING COUNT(*) >= ?
         )`
      )
      .get(min) as { n: number }
    return row?.n ?? 0
  },

  /**
   * A group by name, but only if it is one the library would actually show.
   *
   * Backs the series link on a gallery's detail panel. Returns null for a name
   * that names only one item, so a one-shot whose `series_name` defaults to its
   * own title — 2,337 of them — does not sprout a link to a series of one.
   */
  findDisplayableByName(
    name: string,
    min = DEFAULT_MIN_SERIES_MEMBERS
  ): { id: number; name: string; totalCount: number } | null {
    const trimmed = normaliseSeriesName(name)
    if (!trimmed || !isGroupableSeriesName(trimmed)) return null

    const row = getSqlite()
      .prepare(
        `SELECT s.id AS id, s.name AS name, COUNT(li.id) AS total
           FROM series s
           JOIN library_item li ON li.series_id = s.id
          WHERE s.name = ? COLLATE NOCASE
          GROUP BY s.id
         HAVING COUNT(li.id) >= ?`
      )
      .get(trimmed, min) as { id: number; name: string; total: number } | undefined

    return row ? { id: row.id, name: row.name, totalCount: row.total } : null
  },

  /** Members of a group, unordered — callers sort with sortSeriesMembers. */
  memberIds(seriesId: number): number[] {
    const rows = getSqlite()
      .prepare('SELECT id FROM library_item WHERE series_id = ?')
      .all(seriesId) as Array<{ id: number }>
    return rows.map((r) => r.id)
  },

  /** Choose the cover, either a member's or an explicit image. */
  setCover(seriesId: number, cover: { itemId?: number | null; path?: string | null }): void {
    getSqlite()
      .prepare('UPDATE series SET cover_item_id = ?, cover_path = ?, updated_at = ? WHERE id = ?')
      .run(cover.itemId ?? null, normaliseSeriesName(cover.path), Date.now(), seriesId)
  },

  /** Set a display name that differs from the metadata name. */
  setSortName(seriesId: number, sortName: string | null): void {
    getSqlite()
      .prepare('UPDATE series SET sort_name = ?, updated_at = ?, is_manual = 1 WHERE id = ?')
      .run(normaliseSeriesName(sortName), Date.now(), seriesId)
  },

  /**
   * Unlink every member, leaving the items alone.
   *
   * Only the grouping is removed — `series_name` stays on each item, so nothing
   * is rewritten on disk and re-enabling grouping restores the same group. The
   * row itself survives so a chosen cover is not lost.
   */
  dissolve(seriesId: number): number {
    const result = getSqlite()
      .prepare('UPDATE library_item SET series_id = NULL WHERE series_id = ?')
      .run(seriesId)
    return Number(result.changes ?? 0)
  },

  /**
   * Delete groups nothing points at.
   *
   * Manual groups are kept: someone made them deliberately, and a group can be
   * legitimately empty between deleting its last member and adding the next.
   */
  pruneEmpty(): number {
    const result = getSqlite()
      .prepare(
        `DELETE FROM series
          WHERE is_manual = 0
            AND id NOT IN (SELECT series_id FROM library_item WHERE series_id IS NOT NULL)`
      )
      .run()
    return Number(result.changes ?? 0)
  }
}
