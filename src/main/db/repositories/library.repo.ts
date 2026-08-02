import { eq, like, desc, sql, and, or, ne, inArray, isNull } from 'drizzle-orm'
import { getDatabase } from '../connection'
import { libraryItem, libraryItemArtist, libraryScanLog } from '../schema'
import {
  DEFAULT_MIN_SERIES_MEMBERS,
  findVolumeGaps,
  mergeSeriesFacts,
  pickSeriesCover,
  sortSeriesMembers
} from '../../services/series-grouping'
import type { InferSelectModel, InferInsertModel, SQL } from 'drizzle-orm'

/**
 * Escape LIKE metacharacters so user input matches literally.
 *
 * Used with `ESCAPE '\'`. Without this, a title search for "50%" or "foo_bar"
 * silently behaves as a wildcard pattern.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

export type LibraryItem = InferSelectModel<typeof libraryItem>
export type LibraryItemArtist = InferSelectModel<typeof libraryItemArtist>
export type LibraryScanLog = InferSelectModel<typeof libraryScanLog>
export type NewLibraryItem = InferInsertModel<typeof libraryItem>
export type NewLibraryItemArtist = InferInsertModel<typeof libraryItemArtist>
export type NewLibraryScanLog = InferInsertModel<typeof libraryScanLog>

/**
 * Filters shared by every list query over the library.
 *
 * Extracted so "select all" can resolve exactly the set the grid is showing.
 * A second copy of this logic would drift, and the failure mode is bad: select
 * all would hand a delete action a different set of items than the one on
 * screen.
 */
export interface LibraryFilterParams {
  searchQuery?: string
  artistFilters?: string[]
  seriesFilters?: string[]
  tagFilters?: string[]
  showUnmatchedOnly?: boolean
}

function buildLibraryFilter(params: LibraryFilterParams): SQL | undefined {
  // Every value below is bound as a parameter. This used to be built by string
  // concatenation, which meant a search term containing % or _ acted as a LIKE
  // wildcard and any quoting slip changed the query shape.
  const conditions: SQL[] = []

  if (params.searchQuery && params.searchQuery.trim()) {
    const pattern = `%${escapeLikePattern(params.searchQuery.trim())}%`
    const columns = [
      libraryItem.customTitle,
      libraryItem.primaryArtist,
      libraryItem.seriesName,
      libraryItem.customTags,
      libraryItem.publisher,
      libraryItem.language,
      libraryItem.description
    ]
    const anyColumnMatches = columns.map(
      (column) => sql`${column} LIKE ${pattern} ESCAPE '\\' COLLATE NOCASE`
    )
    /*
     * The nhentai id too, cast to text so a numeric column can be matched the
     * same way. Typing an id is the obvious way to find one gallery, and it
     * used to return nothing at all.
     */
    anyColumnMatches.push(sql`CAST(${libraryItem.galleryId} AS TEXT) LIKE ${pattern} ESCAPE '\\'`)
    conditions.push(sql`(${sql.join(anyColumnMatches, sql` OR `)})`)
  }

  if (params.artistFilters && params.artistFilters.length > 0) {
    conditions.push(inArray(libraryItem.primaryArtist, params.artistFilters))
  }

  if (params.seriesFilters && params.seriesFilters.length > 0) {
    conditions.push(inArray(libraryItem.seriesName, params.seriesFilters))
  }

  if (params.tagFilters && params.tagFilters.length > 0) {
    const anyTagMatches = params.tagFilters.map(
      (tag) =>
        sql`${libraryItem.customTags} LIKE ${`%${escapeLikePattern(tag)}%`} ESCAPE '\\' COLLATE NOCASE`
    )
    conditions.push(sql`(${sql.join(anyTagMatches, sql` OR `)})`)
  }

  if (params.showUnmatchedOnly) {
    conditions.push(
      or(isNull(libraryItem.galleryId), eq(libraryItem.galleryId, 0)) as SQL
    )
  }

  return conditions.length > 0 ? and(...conditions) : undefined
}

// ─── Grouped rows ────────────────────────────────────────────────────────────

/** A series as the library grid needs it. */
export interface SeriesCardData {
  id: number
  /** Display name: the sort override when set, otherwise the metadata name. */
  name: string
  /** Members matching the active filter. Equals `totalCount` when unfiltered. */
  matchCount: number
  /** Members in the whole series, which is the "of 15" the card reports. */
  totalCount: number
  addedAt: number
  fileSize: number
  /** Member to draw the cover from, resolved through any override. */
  coverItemId: number | null
  /** A hand-picked image, which wins over `coverItemId`. */
  coverPath: string | null
  /** 'pdf', 'cbz', or 'mixed' while a conversion is part-done. */
  format: string | null
  artists: string[]
  /**
   * Raw stored language values, deduplicated only by case and ordered by how
   * many members carry each. `eng` and `english` are still two entries here —
   * knowing they are one language is display formatting, which belongs to the
   * renderer's `mergeDisplayLanguages`, not to main.
   */
  languages: string[]
  tags: string[]
  /** Whole volumes absent from the middle of the run. */
  gaps: number[]
  /**
   * The galleries this card stands for, in reading order — matching members
   * only, so selecting a card that reads "3 of 15" selects three.
   *
   * Carried on the card rather than fetched per card: selection has to know
   * these to render a checkbox state at all, and a round-trip for every series
   * on a hundred-row page would be a hundred round-trips. At an average of 3.3
   * members across 239 groups the payload is negligible.
   *
   * Shaped like the rows `findAllIds` returns, id and format together, because
   * it feeds the same selection state. Selecting a series has to record each
   * member's format: the renderer only holds rows for galleries shown in their
   * own right, so without this a member of a collapsed series would fall back
   * to a default and a selection of CBZs could be counted as convertible PDFs.
   */
  members: Array<{ id: number; format: string }>
}

export type LibraryRow =
  { kind: 'item'; item: LibraryItem } | { kind: 'series'; series: SeriesCardData }

/** Reading order for rows shaped as they come out of SQL. */
function sortSeriesMembersRows<
  T extends { id: number; series_index: number | null; custom_title: string | null }
>(rows: readonly T[]): T[] {
  const order = sortSeriesMembers(
    rows.map((r) => ({ id: r.id, seriesIndex: r.series_index, title: r.custom_title ?? '' }))
  )
  const byId = new Map(rows.map((r) => [r.id, r]))
  return order.map((m) => byId.get(m.id)!).filter(Boolean)
}

interface MemberRow {
  id: number
  series_id: number
  series_index: number | null
  custom_title: string | null
  format: string | null
  language: string | null
  custom_language: string | null
  primary_artist: string | null
  custom_tags: string | null
  file_size: number | null
  added_at: number
  matches: number
}

/**
 * Turn the thin index into the rows the grid renders.
 *
 * Items and series are fetched in one query each regardless of how many of
 * either the page holds, then put back into the order the index established.
 */
function hydrateRows(
  index: ReadonlyArray<{ kind: string; id: number; match_count: number; total_count: number }>,
  filter: SQL
): LibraryRow[] {
  const db = getDatabase()
  const itemIds = index.filter((r) => r.kind === 'item').map((r) => r.id)
  const seriesIds = index.filter((r) => r.kind === 'series').map((r) => r.id)

  const itemsById = new Map<number, LibraryItem>()
  if (itemIds.length > 0) {
    for (const item of db
      .select()
      .from(libraryItem)
      .where(inArray(libraryItem.id, itemIds))
      .all()) {
      itemsById.set(item.id, item)
    }
  }

  const cardsById = new Map<number, SeriesCardData>()
  if (seriesIds.length > 0) {
    const groups = db.all(
      sql`SELECT id, name, sort_name, cover_item_id, cover_path FROM series
           WHERE id IN (${sql.join(
             seriesIds.map((id) => sql`${id}`),
             sql`, `
           )})`
    ) as Array<{
      id: number
      name: string
      sort_name: string | null
      cover_item_id: number | null
      cover_path: string | null
    }>

    // Every member of every series on this page, carrying whether it matched.
    // Fetching all members rather than only matching ones is what lets the
    // cover stay stable under a filter while the facts follow the match.
    const members = db.all(
      sql`SELECT id, series_id, series_index, custom_title, format, language,
                 custom_language, primary_artist, custom_tags, file_size, added_at,
                 CASE WHEN ${filter} THEN 1 ELSE 0 END AS matches
            FROM library_item
           WHERE series_id IN (${sql.join(
             seriesIds.map((id) => sql`${id}`),
             sql`, `
           )})`
    ) as MemberRow[]

    const bySeries = new Map<number, MemberRow[]>()
    for (const member of members) {
      const bucket = bySeries.get(member.series_id)
      if (bucket) bucket.push(member)
      else bySeries.set(member.series_id, [member])
    }

    for (const group of groups) {
      const all = bySeries.get(group.id) ?? []
      const matching = all.filter((m) => m.matches === 1)
      // Facts describe what matched; an unfiltered page matches everything, so
      // this is the whole series in the normal case.
      const facts = mergeSeriesFacts(
        matching.map((m) => ({
          format: m.format,
          language: m.language,
          customLanguage: m.custom_language,
          primaryArtist: m.primary_artist,
          customTags: m.custom_tags
        }))
      )

      const cover = pickSeriesCover(
        all.map((m) => ({ id: m.id, seriesIndex: m.series_index, title: m.custom_title ?? '' })),
        { coverItemId: group.cover_item_id, coverPath: group.cover_path }
      )

      cardsById.set(group.id, {
        id: group.id,
        name: group.sort_name?.trim() || group.name,
        matchCount: matching.length,
        totalCount: all.length,
        addedAt: matching.reduce((max, m) => Math.max(max, m.added_at ?? 0), 0),
        fileSize: matching.reduce((sum, m) => sum + (m.file_size ?? 0), 0),
        coverItemId: cover && 'memberId' in cover ? cover.memberId : null,
        coverPath: cover && 'coverPath' in cover ? cover.coverPath : null,
        format: facts.format,
        artists: facts.artists,
        languages: facts.languages,
        tags: facts.tags,
        // Gaps describe the series, not the filtered slice: "volume 3 missing"
        // is a fact about the collection, and computing it over a match would
        // report a gap for every volume the search excluded.
        gaps: findVolumeGaps(all.map((m) => m.series_index)),
        members: sortSeriesMembersRows(matching).map((m) => ({
          id: m.id,
          format: m.format || 'pdf'
        }))
      })
    }
  }

  const rows: LibraryRow[] = []
  for (const entry of index) {
    if (entry.kind === 'item') {
      const item = itemsById.get(entry.id)
      if (item) rows.push({ kind: 'item', item })
    } else {
      const series = cardsById.get(entry.id)
      if (series) rows.push({ kind: 'series', series })
    }
  }
  return rows
}
export const libraryRepo = {
  findAll(): LibraryItem[] {
    const db = getDatabase()
    return db.select().from(libraryItem).orderBy(desc(libraryItem.addedAt)).all()
  },

  findById(id: number): LibraryItem | undefined {
    const db = getDatabase()
    return db.select().from(libraryItem).where(eq(libraryItem.id, id)).get()
  },

  findByGalleryId(galleryId: number): LibraryItem | undefined {
    const db = getDatabase()
    return db.select().from(libraryItem).where(eq(libraryItem.galleryId, galleryId)).get()
  },

  findByFilePath(filePath: string): LibraryItem | undefined {
    const db = getDatabase()
    return db.select().from(libraryItem).where(eq(libraryItem.filePath, filePath)).get()
  },

  findByArtist(artistName: string): LibraryItem[] {
    const db = getDatabase()
    const rows = db
      .select()
      .from(libraryItem)
      .innerJoin(libraryItemArtist, eq(libraryItem.id, libraryItemArtist.libraryItemId))
      .where(eq(libraryItemArtist.artistName, artistName))
      .all()
    return rows.map((row) => row.library_item)
  },

  findBySeries(seriesName: string): LibraryItem[] {
    const db = getDatabase()
    return db
      .select()
      .from(libraryItem)
      .where(eq(libraryItem.seriesName, seriesName))
      .all()
  },

  searchByTitle(query: string): LibraryItem[] {
    const db = getDatabase()
    return db
      .select()
      .from(libraryItem)
      .where(like(libraryItem.customTitle, `%${query}%`))
      .all()
  },

  findAllWithFilePaths(): Array<{ id: number; filePath: string }> {
    const db = getDatabase()
    const rows = db
      .select({ id: libraryItem.id, filePath: libraryItem.filePath })
      .from(libraryItem)
      .all()
    return rows
  },

  insert(item: NewLibraryItem): number {
    const db = getDatabase()
    const result = db.insert(libraryItem).values(item).run()
    return Number(result.lastInsertRowid)
  },

  update(id: number, data: Partial<NewLibraryItem>): void {
    const db = getDatabase()
    db.update(libraryItem)
      .set({ ...data, updatedAt: Date.now() })
      .where(eq(libraryItem.id, id))
      .run()
  },

  /**
   * Delete a library item and its artist rows.
   *
   * `PRAGMA foreign_keys = ON` is set but no table actually declares a foreign
   * key, so nothing cascades. Deleting the artist rows here means callers
   * can't forget and leak orphans into the artist filter list.
   */
  delete(id: number): void {
    const db = getDatabase()
    db.delete(libraryItemArtist).where(eq(libraryItemArtist.libraryItemId, id)).run()
    db.delete(libraryItem).where(eq(libraryItem.id, id)).run()
  },

  /** Remove artist rows whose library item no longer exists. */
  deleteOrphanedArtists(): number {
    const db = getDatabase()
    const result = db.run(
      sql`DELETE FROM library_item_artist
          WHERE library_item_id NOT IN (SELECT id FROM library_item)`
    )
    return Number(result.changes ?? 0)
  },

  findPaginated(params: {
    offset: number
    limit: number
    sortField?: 'added' | 'title' | 'artist'
    searchQuery?: string
    artistFilters?: string[]
    seriesFilters?: string[]
    tagFilters?: string[]
    showUnmatchedOnly?: boolean
  }): { items: LibraryItem[]; total: number } {
    const db = getDatabase()
    const where = buildLibraryFilter(params)

    let orderBy: SQL
    switch (params.sortField) {
      case 'title':
        orderBy = sql`${libraryItem.customTitle} COLLATE NOCASE ASC`
        break
      case 'artist':
        orderBy = sql`${libraryItem.primaryArtist} COLLATE NOCASE ASC`
        break
      case 'added':
      default:
        orderBy = sql`${libraryItem.addedAt} DESC`
        break
    }

    const totalRow = db
      .select({ count: sql<number>`count(*)` })
      .from(libraryItem)
      .where(where)
      .get()

    // Selecting through drizzle returns camelCase rows straight away, so the
    // hand-written snake_case mapping this used to need is gone.
    const items = db
      .select()
      .from(libraryItem)
      .where(where)
      .orderBy(orderBy)
      .limit(params.limit)
      .offset(params.offset)
      .all()

    return { items, total: totalRow?.count ?? 0 }
  },

  /**
   * Every id matching the current filters, ignoring pagination.
   *
   * Backs "select all in library": the grid is virtualised and only holds the
   * pages loaded so far, so the visible select-all could never reach beyond
   * those. Returns ids only — the full rows would be thousands of records the
   * caller does not need.
   *
   * Uses the same filter builder as findPaginated, so the set is exactly what
   * the grid is showing. That equivalence is the safety property: these ids get
   * handed to batch delete.
   */
  findAllIds(params: LibraryFilterParams): Array<{ id: number; format: string }> {
    const db = getDatabase()
    return db
      .select({ id: libraryItem.id, format: libraryItem.format })
      .from(libraryItem)
      .where(buildLibraryFilter(params))
      .all()
  },

  /**
   * One page of the library with series collapsed into single rows.
   *
   * Returns a thin index first and hydrates it in two follow-up queries rather
   * than UNIONing full item rows against series aggregates. `library_item` has
   * two dozen columns; null-padding them across the union to match an aggregate
   * shape would be unreadable and would break the moment a column is added.
   *
   * ── How a filter interacts with a group ──────────────────────────────────
   *
   * A series matches when any member does, and then **the row represents only
   * its matching members**: date, size, artists, languages and tags are all
   * computed over that subset, and the card reports "3 of 15". This is the
   * whole reason the grouping stays honest under a search — a series does not
   * claim fifteen results when three matched, and does not sort by the date of
   * a volume that was filtered out.
   *
   * The cover is the deliberate exception: it comes from the whole series, not
   * the matching subset, because it identifies the series rather than
   * summarising it. A group that changed its cover depending on the search box
   * would read as a different group.
   */
  findPaginatedGrouped(
    params: LibraryFilterParams & {
      offset: number
      limit: number
      sortField?: 'added' | 'title' | 'artist'
      minMembers?: number
    }
  ): { rows: LibraryRow[]; total: number; galleries: number } {
    const db = getDatabase()
    const min = params.minMembers ?? DEFAULT_MIN_SERIES_MEMBERS

    // The same predicate the ungrouped list and "select all" use. Sharing it is
    // what stops the grid and a batch action from disagreeing about which items
    // are on screen; a second copy here would drift and delete the wrong rows.
    const filter = buildLibraryFilter(params) ?? sql`1`

    // A group is one whose member count clears the threshold. Deliberately
    // counted over all members, not matching ones, so a 15-volume series with a
    // single match is still presented as a series.
    const grouped = sql`
      SELECT series_id, COUNT(*) AS total
        FROM library_item
       WHERE series_id IS NOT NULL
       GROUP BY series_id
      HAVING COUNT(*) >= ${min}
    `

    /*
     * Both branches reference `library_item` unaliased so the predicate above —
     * which Drizzle renders as "library_item"."column" — resolves inside each.
     */
    const unioned = sql`
      SELECT 'series' AS kind,
             s.id AS id,
             COALESCE(s.sort_name, s.name) AS sort_title,
             MIN(library_item.primary_artist) FILTER (WHERE ${filter}) AS sort_artist,
             MAX(library_item.added_at) FILTER (WHERE ${filter}) AS sort_added,
             COUNT(*) FILTER (WHERE ${filter}) AS match_count,
             g.total AS total_count
        FROM series s
        JOIN (${grouped}) g ON g.series_id = s.id
        JOIN library_item ON library_item.series_id = s.id
       GROUP BY s.id
      HAVING match_count > 0
      UNION ALL
      SELECT 'item',
             library_item.id,
             library_item.custom_title,
             library_item.primary_artist,
             library_item.added_at,
             1,
             1
        FROM library_item
       WHERE (library_item.series_id IS NULL
              OR library_item.series_id NOT IN (SELECT series_id FROM (${grouped})))
         AND ${filter}
    `

    let orderBy: SQL
    switch (params.sortField) {
      case 'title':
        orderBy = sql`sort_title COLLATE NOCASE ASC`
        break
      case 'artist':
        // A series sorts under its alphabetically first contributing artist.
        // Only 12 of 239 groups span more than one artist — the on-disk layout
        // is artist/series — so this is an exact answer nearly always, and a
        // stable one otherwise.
        orderBy = sql`sort_artist COLLATE NOCASE ASC`
        break
      case 'added':
      default:
        orderBy = sql`sort_added DESC`
        break
    }

    const index = db.all(
      sql`SELECT * FROM (${unioned}) ORDER BY ${orderBy} LIMIT ${params.limit} OFFSET ${params.offset}`
    ) as Array<{ kind: string; id: number; match_count: number; total_count: number }>

    // Two counts, because they answer different questions: how many rows the
    // grid will scroll through, and how many galleries actually matched. A
    // grouped view that reported only the first would understate the result.
    const totals = db.get(
      sql`SELECT COUNT(*) AS rows, COALESCE(SUM(match_count), 0) AS galleries FROM (${unioned})`
    ) as { rows: number; galleries: number } | undefined

    return {
      rows: hydrateRows(index, filter),
      total: totals?.rows ?? 0,
      galleries: totals?.galleries ?? 0
    }
  },

  /**
   * The matching members of one group, in reading order.
   *
   * Selecting a series card has to resolve to galleries, and under a filter it
   * must resolve to the ones the card counted — otherwise a card reading "3 of
   * 15" would hand fifteen files to a delete.
   */
  matchingMemberIds(seriesId: number, params: LibraryFilterParams = {}): number[] {
    const db = getDatabase()
    const filter = buildLibraryFilter(params) ?? sql`1`
    const rows = db.all(
      sql`SELECT id, series_index, custom_title FROM library_item
           WHERE series_id = ${seriesId} AND ${filter}`
    ) as Array<{ id: number; series_index: number | null; custom_title: string | null }>

    return sortSeriesMembersRows(rows).map((r) => r.id)
  },
  /**
   * Everything the series detail panel shows, in one call.
   *
   * The panel previously fetched each member with its own `getById`, which is
   * fifteen round-trips for a fifteen-volume series before it can draw
   * anything. This is one.
   *
   * Unlike the card, this returns the **whole** series and flags which members
   * match. The card summarises a filtered slice — "3 of 15" — but the panel is
   * the series itself, so it lists all fifteen with the other twelve dimmed and
   * describes the whole thing. Reporting only the slice would make opening a
   * card look like the rest of the series had been deleted.
   */
  seriesFacts(
    seriesId: number,
    params: LibraryFilterParams = {}
  ): {
    id: number
    name: string
    sortName: string | null
    coverItemId: number | null
    coverPath: string | null
    matchCount: number
    totalCount: number
    fileSize: number
    /**
     * Pages across the whole series, summed from what each member knows.
     *
     * Null when no member has a count yet. Reported rather than recomputed:
     * counting means opening every archive, about 25ms each, which a fifteen
     * volume series cannot afford on every open.
     */
    pageCount: number | null
    artists: string[]
    languages: string[]
    /**
     * Merged `custom_tags`, most-used first.
     *
     * This is what the panel's tag block is built on, not `typedTags`. Only 52
     * of 4,409 cached gallery rows carry real tag types — scanner-created rows
     * store every tag as type 'tag' — so typed tags reach about five series in
     * this library, while these reach all of them.
     */
    tags: string[]
    gaps: number[]
    /** Genre, parody and character, where a synced gallery row supplies them. */
    typedTags: Array<{ id: number; type: string; name: string }>
    members: Array<LibraryItem & { matches: boolean }>
  } | null {
    const db = getDatabase()
    const filter = buildLibraryFilter(params) ?? sql`1`

    const group = db.get(
      sql`SELECT id, name, sort_name, cover_item_id, cover_path FROM series WHERE id = ${seriesId}`
    ) as
      | {
          id: number
          name: string
          sort_name: string | null
          cover_item_id: number | null
          cover_path: string | null
        }
      | undefined
    if (!group) return null

    const rows = db.all(
      sql`SELECT *, CASE WHEN ${filter} THEN 1 ELSE 0 END AS matches
            FROM library_item WHERE series_id = ${seriesId}`
    ) as Array<Record<string, unknown>>

    // Drizzle returns snake_case for a raw select, while the rest of the app
    // passes camelCase LibraryItem rows around, so these go back through the
    // typed select and the raw pass is used only for the match flag.
    const matchById = new Map(rows.map((r) => [Number(r.id), Number(r.matches) === 1]))
    const typed = db.select().from(libraryItem).where(eq(libraryItem.seriesId, seriesId)).all()

    const ordered = sortSeriesMembers(
      typed.map((item) => ({
        id: item.id,
        seriesIndex: item.seriesIndex,
        title: item.customTitle ?? ''
      }))
    )
    const byId = new Map(typed.map((item) => [item.id, item]))
    const members = ordered
      .map((m) => byId.get(m.id))
      .filter((item): item is LibraryItem => Boolean(item))
      .map((item) => ({ ...item, matches: matchById.get(item.id) ?? false }))

    const facts = mergeSeriesFacts(
      members.map((m) => ({
        format: m.format,
        language: m.language,
        customLanguage: m.customLanguage,
        primaryArtist: m.primaryArtist,
        customTags: m.customTags
      }))
    )

    /*
     * Typed tags — genre, parody, character — come from the cached gallery
     * rows, since `custom_tags` keeps a comma-joined string with the types
     * thrown away. Scanner stubs stored every tag as type 'tag', which carries
     * nothing `custom_tags` does not, so those are skipped exactly as
     * `library:getGalleryTags` skips them.
     */
    const galleryIds = members.map((m) => m.galleryId).filter((id): id is number => Boolean(id))
    const typedTags: Array<{ id: number; type: string; name: string }> = []
    if (galleryIds.length > 0) {
      const seen = new Set<string>()
      const cached = db.all(
        sql`SELECT raw_tags_json FROM gallery
             WHERE id IN (${sql.join(
               galleryIds.map((id) => sql`${id}`),
               sql`, `
             )})`
      ) as Array<{ raw_tags_json: string | null }>

      for (const row of cached) {
        if (!row.raw_tags_json) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(row.raw_tags_json)
        } catch {
          continue
        }
        if (!Array.isArray(parsed)) continue
        const types = new Set(parsed.map((t: { type?: string }) => t.type))
        if (types.size <= 1 && types.has('tag')) continue

        for (const tag of parsed as Array<{ id?: number; type?: string; name?: string }>) {
          if (!tag?.type || !tag?.name) continue
          const key = `${tag.type}\x00${tag.name.toLowerCase()}`
          if (seen.has(key)) continue
          seen.add(key)
          typedTags.push({ id: tag.id ?? 0, type: tag.type, name: tag.name })
        }
      }
    }

    const cover = pickSeriesCover(
      members.map((m) => ({ id: m.id, seriesIndex: m.seriesIndex, title: m.customTitle ?? '' })),
      { coverItemId: group.cover_item_id, coverPath: group.cover_path }
    )

    return {
      id: group.id,
      name: group.sort_name?.trim() || group.name,
      sortName: group.sort_name,
      coverItemId: cover && 'memberId' in cover ? cover.memberId : null,
      coverPath: cover && 'coverPath' in cover ? cover.coverPath : null,
      matchCount: members.filter((m) => m.matches).length,
      totalCount: members.length,
      fileSize: members.reduce((sum, m) => sum + (m.fileSize ?? 0), 0),
      // Summed over members that know their count. Partly-known is still worth
      // showing; entirely unknown renders nothing rather than a misleading 0.
      pageCount: members.some((m) => m.pageCount != null)
        ? members.reduce((sum, m) => sum + (m.pageCount ?? 0), 0)
        : null,
      artists: facts.artists,
      languages: facts.languages,
      tags: facts.tags,
      gaps: findVolumeGaps(members.map((m) => m.seriesIndex)),
      typedTags,
      members
    }
  },

  count(): number {
    const db = getDatabase()
    const result = db
      .select({ count: sql<number>`count(*)` })
      .from(libraryItem)
      .get()
    return result?.count ?? 0
  },

  // ─── Artists ─────────────────────────────────────────────────────

  getArtists(libraryItemId: number): LibraryItemArtist[] {
    const db = getDatabase()
    return db
      .select()
      .from(libraryItemArtist)
      .where(eq(libraryItemArtist.libraryItemId, libraryItemId))
      .orderBy(libraryItemArtist.sortOrder)
      .all()
  },

  addArtist(artist: NewLibraryItemArtist): void {
    const db = getDatabase()
    db.insert(libraryItemArtist).values(artist).run()
  },

  removeArtists(libraryItemId: number): void {
    const db = getDatabase()
    db.delete(libraryItemArtist)
      .where(eq(libraryItemArtist.libraryItemId, libraryItemId))
      .run()
  },

  getAllArtistNames(): string[] {
    const db = getDatabase()
    const rows = db
      .selectDistinct({ artistName: libraryItemArtist.artistName })
      .from(libraryItemArtist)
      .all()
    return rows.map((r) => r.artistName)
  },

  getAllTagNames(): string[] {
    const db = getDatabase()
    const rows = db
      .selectDistinct({ customTags: libraryItem.customTags })
      .from(libraryItem)
      .where(sql`${libraryItem.customTags} IS NOT NULL AND ${libraryItem.customTags} != ''`)
      .all()
    // customTags is comma-separated; split and deduplicate
    const tagSet = new Set<string>()
    for (const row of rows) {
      if (row.customTags) {
        row.customTags.split(',').forEach((t: string) => {
          const trimmed = t.trim()
          if (trimmed) tagSet.add(trimmed)
        })
      }
    }
    return Array.from(tagSet).sort()
  },

  autocompleteTags(query: string): string[] {
    const allNames = this.getAllTagNames()
    const lower = query.toLowerCase()
    return allNames
      .filter((name) => name.toLowerCase().includes(lower))
      .slice(0, 10)
  },

  // ─── Autocomplete ─────────────────────────────────────────────────

  autocompleteArtists(query: string): string[] {
    const db = getDatabase()
    const rows = db
      .select({
        artistName: libraryItemArtist.artistName,
        count: sql<number>`COUNT(*)`.as('count')
      })
      .from(libraryItemArtist)
      .where(like(libraryItemArtist.artistName, `%${query}%`))
      .groupBy(libraryItemArtist.artistName)
      .orderBy(desc(sql`count`))
      .limit(10)
      .all()
    return rows.map((r) => r.artistName)
  },

  autocompleteSeries(query: string): string[] {
    const db = getDatabase()
    const rows = db
      .selectDistinct({ seriesName: libraryItem.seriesName })
      .from(libraryItem)
      .where(
        and(
          like(libraryItem.seriesName, `%${query}%`),
          ne(libraryItem.seriesName, ''),
          sql`${libraryItem.seriesName} IS NOT NULL`
        )
      )
      .limit(10)
      .all()
    return rows.map((r) => r.seriesName!).filter(Boolean)
  },

  getAllSeriesNames(): string[] {
    const db = getDatabase()
    const rows = db
      .selectDistinct({ seriesName: libraryItem.seriesName })
      .from(libraryItem)
      .where(
        and(
          ne(libraryItem.seriesName, ''),
          sql`${libraryItem.seriesName} IS NOT NULL`
        )
      )
      .all()
    return rows.map((r) => r.seriesName!).filter(Boolean)
  },

  // ─── Scan Log ─────────────────────────────────────────────────────

  insertScanLog(log: NewLibraryScanLog): number {
    const db = getDatabase()
    const result = db.insert(libraryScanLog).values(log).run()
    return Number(result.lastInsertRowid)
  },

  getLastScanLog(): LibraryScanLog | undefined {
    const db = getDatabase()
    return db
      .select()
      .from(libraryScanLog)
      .orderBy(desc(libraryScanLog.scannedAt))
      .limit(1)
      .get()
  }
}
