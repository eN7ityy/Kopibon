import { eq } from 'drizzle-orm'
import { getDatabase } from '../connection'
import { gallery as galleryTable } from '../schema'
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'

export type Gallery = InferSelectModel<typeof galleryTable>
export type NewGallery = InferInsertModel<typeof galleryTable>

export const galleryRepo = {
  findById(id: number): Gallery | undefined {
    const db = getDatabase()
    return db.select().from(galleryTable).where(eq(galleryTable.id, id)).get()
  },

  findByMediaId(mediaId: number): Gallery | undefined {
    const db = getDatabase()
    return db.select().from(galleryTable).where(eq(galleryTable.mediaId, mediaId)).get()
  },

  upsert(gallery: NewGallery): Gallery {
    const db = getDatabase()
    const existing = this.findById(gallery.id)
    if (existing) {
      db.update(galleryTable)
        .set({ ...gallery, updatedAt: Date.now() })
        .where(eq(galleryTable.id, gallery.id))
        .run()
      return this.findById(gallery.id)!
    }
    db.insert(galleryTable).values(gallery).run()
    return this.findById(gallery.id)!
  },

  delete(id: number): void {
    const db = getDatabase()
    db.delete(galleryTable).where(eq(galleryTable.id, id)).run()
  },

  count(): number {
    const db = getDatabase()
    return db.$count(galleryTable)
  }
}
