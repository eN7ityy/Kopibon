import { eq, like, desc, sql, and, ne } from 'drizzle-orm'
import { getDatabase } from '../connection'
import { libraryItem, libraryItemArtist, libraryScanLog } from '../schema'
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm'

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

  delete(id: number): void {
    const db = getDatabase()
    db.delete(libraryItem).where(eq(libraryItem.id, id)).run()
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
    const conditions: string[] = []

    if (params.searchQuery) {
      const q = params.searchQuery.replace(/'/g, "''")
      conditions.push(
        `(custom_title LIKE '%${q}%' OR primary_artist LIKE '%${q}%' OR series_name LIKE '%${q}%')`
      )
    }
    if (params.artistFilters && params.artistFilters.length > 0) {
      const escaped = params.artistFilters.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')
      conditions.push(`primary_artist IN (${escaped})`)
    }
    if (params.seriesFilters && params.seriesFilters.length > 0) {
      const escaped = params.seriesFilters.map((s) => `'${s.replace(/'/g, "''")}'`).join(',')
      conditions.push(`series_name IN (${escaped})`)
    }
    if (params.tagFilters && params.tagFilters.length > 0) {
      const tagConditions = params.tagFilters.map((t) => {
        const escaped = t.replace(/'/g, "''")
        return `custom_tags LIKE '%${escaped}%'`
      })
      conditions.push(`(${tagConditions.join(' OR ')})`)
    }
    if (params.showUnmatchedOnly) {
      conditions.push(`(gallery_id IS NULL OR gallery_id = 0)`)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    let orderClause: string
    switch (params.sortField) {
      case 'title':
        orderClause = 'ORDER BY custom_title COLLATE NOCASE ASC'
        break
      case 'artist':
        orderClause = 'ORDER BY primary_artist COLLATE NOCASE ASC'
        break
      case 'added':
      default:
        orderClause = 'ORDER BY added_at DESC'
        break
    }

    const totalRow = db
      .get<{ count: number }>(
        sql`SELECT COUNT(*) as count FROM library_item ${sql.raw(whereClause)}`
      )
    const total = totalRow?.count ?? 0

    const rawRows = db
      .all<Record<string, unknown>>(
        sql`SELECT * FROM library_item ${sql.raw(whereClause)} ${sql.raw(orderClause)} LIMIT ${params.limit} OFFSET ${params.offset}`
      )

    // Map raw snake_case rows to drizzle's camelCase LibraryItem type
    const items: LibraryItem[] = rawRows.map((row) => ({
      id: row.id as number,
      galleryId: row.gallery_id as number | null,
      isCustom: row.is_custom as number,
      customTitle: row.custom_title as string | null,
      customTags: row.custom_tags as string | null,
      customLanguage: row.custom_language as string | null,
      customDate: row.custom_date as string | null,
      customCoverPath: row.custom_cover_path as string | null,
      filePath: row.file_path as string,
      fileSize: row.file_size as number | null,
      format: row.format as string,
      primaryArtist: row.primary_artist as string,
      seriesName: row.series_name as string | null,
      seriesIndex: row.series_index as number | null,
      language: row.language as string | null,
      publisher: row.publisher as string | null,
      description: row.description as string | null,
      readProgress: row.read_progress as number,
      fileMtime: row.file_mtime as number | null,
      thumbnailPath: row.thumbnail_path as string | null,
      addedAt: row.added_at as number,
      updatedAt: row.updated_at as number
    }))

    return { items, total }
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
