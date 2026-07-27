import { eq } from 'drizzle-orm'
import { getDatabase } from '../connection'
import { appSettings } from '../schema'
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm'

export type AppSetting = InferSelectModel<typeof appSettings>
export type NewAppSetting = InferInsertModel<typeof appSettings>

export const settingsRepo = {
  get(key: string): string | undefined {
    const db = getDatabase()
    const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get()
    return row?.value ?? undefined
  },

  getAll(): Record<string, string> {
    const db = getDatabase()
    const rows = db.select().from(appSettings).all()
    const result: Record<string, string> = {}
    for (const row of rows) {
      result[row.key] = row.value
    }
    return result
  },

  set(key: string, value: string): void {
    const db = getDatabase()
    const existing = db.select().from(appSettings).where(eq(appSettings.key, key)).get()
    if (existing) {
      db.update(appSettings)
        .set({ value, updatedAt: Date.now() })
        .where(eq(appSettings.key, key))
        .run()
    } else {
      db.insert(appSettings).values({ key, value, updatedAt: Date.now() }).run()
    }
  },

  setAll(settings: Record<string, string>): void {
    for (const [key, value] of Object.entries(settings)) {
      this.set(key, value)
    }
  },

  delete(key: string): void {
    const db = getDatabase()
    db.delete(appSettings).where(eq(appSettings.key, key)).run()
  }
}
