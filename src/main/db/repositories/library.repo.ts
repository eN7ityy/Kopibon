import { eq, like, desc, sql } from 'drizzle-orm'
import { getDatabase } from '../connection'
import { libraryItem, libraryItemArtist } from '../schema'
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm'

export type LibraryItem = InferSelectModel<typeof libraryItem>
export type LibraryItemArtist = InferSelectModel<typeof libraryItemArtist>
export type NewLibraryItem = InferInsertModel<typeof libraryItem>
export type NewLibraryItemArtist = InferInsertModel<typeof libraryItemArtist>

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
  }
}
