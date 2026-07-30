import { eq, like, desc, sql, and, or, ne, inArray, isNull } from 'drizzle-orm'
import { getDatabase } from '../connection'
import { libraryItem, libraryItemArtist, libraryScanLog } from '../schema'
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

    // Every value below is bound as a parameter. This used to be built by
    // string concatenation, which meant a search term containing % or _ acted
    // as a LIKE wildcard and any quoting slip changed the query shape.
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

    const where = conditions.length > 0 ? and(...conditions) : undefined

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
