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
