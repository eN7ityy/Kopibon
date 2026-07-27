import { eq, asc, sql } from 'drizzle-orm'
import { getDatabase } from '../connection'
import { downloadQueue, downloadPage } from '../schema'
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm'

export type DownloadQueueItem = InferSelectModel<typeof downloadQueue>
export type DownloadPageItem = InferSelectModel<typeof downloadPage>
export type NewDownloadQueueItem = InferInsertModel<typeof downloadQueue>
export type NewDownloadPageItem = InferInsertModel<typeof downloadPage>

export const downloadRepo = {
  // ─── Queue ─────────────────────────────────────────────────────────

  findAll(): DownloadQueueItem[] {
    const db = getDatabase()
    return db.select().from(downloadQueue).all()
  },

  findById(id: number): DownloadQueueItem | undefined {
    const db = getDatabase()
    return db.select().from(downloadQueue).where(eq(downloadQueue.id, id)).get()
  },

  findByStatus(status: string): DownloadQueueItem[] {
    const db = getDatabase()
    return db.select().from(downloadQueue).where(eq(downloadQueue.status, status)).all()
  },

  findByGalleryId(galleryId: number): DownloadQueueItem | undefined {
    const db = getDatabase()
    return db
      .select()
      .from(downloadQueue)
      .where(eq(downloadQueue.galleryId, galleryId))
      .get()
  },

  insert(item: NewDownloadQueueItem): number {
    const db = getDatabase()
    const result = db.insert(downloadQueue).values(item).run()
    return Number(result.lastInsertRowid)
  },

  update(id: number, data: Partial<NewDownloadQueueItem>): void {
    const db = getDatabase()
    db.update(downloadQueue).set(data).where(eq(downloadQueue.id, id)).run()
  },

  delete(id: number): void {
    const db = getDatabase()
    db.delete(downloadQueue).where(eq(downloadQueue.id, id)).run()
  },

  // ─── Pages ─────────────────────────────────────────────────────────

  getPages(queueId: number): DownloadPageItem[] {
    const db = getDatabase()
    return db
      .select()
      .from(downloadPage)
      .where(eq(downloadPage.queueId, queueId))
      .orderBy(asc(downloadPage.pageNumber))
      .all()
  },

  insertPage(page: NewDownloadPageItem): number {
    const db = getDatabase()
    const result = db.insert(downloadPage).values(page).run()
    return Number(result.lastInsertRowid)
  },

  insertPages(pages: NewDownloadPageItem[]): void {
    const db = getDatabase()
    for (const page of pages) {
      db.insert(downloadPage).values(page).run()
    }
  },

  updatePage(id: number, data: Partial<NewDownloadPageItem>): void {
    const db = getDatabase()
    db.update(downloadPage).set(data).where(eq(downloadPage.id, id)).run()
  },

  deletePages(queueId: number): void {
    const db = getDatabase()
    db.delete(downloadPage).where(eq(downloadPage.queueId, queueId)).run()
  },

  activeCount(): number {
    const db = getDatabase()
    const result = db
      .select({ count: sql<number>`count(*)` })
      .from(downloadQueue)
      .where(eq(downloadQueue.status, 'downloading'))
      .get()
    return result?.count ?? 0
  },

  queuedCount(): number {
    const db = getDatabase()
    const result = db
      .select({ count: sql<number>`count(*)` })
      .from(downloadQueue)
      .where(eq(downloadQueue.status, 'queued'))
      .get()
    return result?.count ?? 0
  }
}
