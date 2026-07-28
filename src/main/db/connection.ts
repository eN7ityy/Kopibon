import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import * as schema from './schema'

const DB_DIR = join(homedir(), '.config', 'doujin-downloader')
const DB_PATH = join(DB_DIR, 'db.sqlite')

let db: ReturnType<typeof drizzle> | null = null
let sqlite: Database.Database | null = null

export function getDbPath(): string {
  return DB_PATH
}

export function getRawDatabase(): Database.Database {
  if (!sqlite) {
    initDatabase()
  }
  return sqlite!
}

export function getDbDir(): string {
  return DB_DIR
}

export function initDatabase(): ReturnType<typeof drizzle> {
  if (db) return db

  // Ensure directory exists
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true })
  }

  sqlite = new Database(DB_PATH)
  sqlite.pragma('encoding = "UTF-8"')
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  db = drizzle(sqlite, { schema })
  runMigrations(sqlite)
  seedDefaults(sqlite)
  return db
}

export function getDatabase(): ReturnType<typeof drizzle> {
  if (!db) {
    return initDatabase()
  }
  return db
}

export function closeDatabase(): void {
  if (sqlite) {
    sqlite.close()
    sqlite = null
    db = null
  }
}

function seedDefaults(sqlite: Database.Database): void {
  const row = sqlite.prepare('SELECT COUNT(*) as cnt FROM app_settings').get() as { cnt: number }
  if (row.cnt > 0) return

  const defaults: Record<string, string> = {
    libraryPath: '/mnt/bragi/Kavita/Doujins/',
    downloadConcurrency: '3',
    theme: 'system',
    outputFormat: 'pdf',
    compressPdf: 'true',
    compressionQuality: '80',
    pageSize: 'Dynamic',
    blackBackground: 'true'
  }

  const insert = sqlite.prepare('INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
  const now = Date.now()
  for (const [key, value] of Object.entries(defaults)) {
    insert.run(key, value, now)
  }
}

function runMigrations(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS gallery (
      id INTEGER PRIMARY KEY,
      media_id INTEGER NOT NULL,
      title_pretty TEXT NOT NULL,
      title_english TEXT,
      title_japanese TEXT,
      page_count INTEGER NOT NULL DEFAULT 0,
      favorites_count INTEGER DEFAULT 0,
      upload_date INTEGER,
      thumbnail_url TEXT,
      cover_url TEXT,
      raw_tags_json TEXT NOT NULL DEFAULT '[]',
      raw_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS library_item (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gallery_id INTEGER UNIQUE,
      is_custom INTEGER NOT NULL DEFAULT 0,
      custom_title TEXT,
      custom_tags TEXT,
      custom_language TEXT,
      custom_date TEXT,
      custom_cover_path TEXT,
      file_path TEXT NOT NULL,
      file_size INTEGER,
      format TEXT NOT NULL DEFAULT 'pdf',
      primary_artist TEXT NOT NULL,
      series_name TEXT,
      series_index REAL,
      language TEXT,
      publisher TEXT,
      description TEXT,
      read_progress INTEGER NOT NULL DEFAULT 0,
      file_mtime INTEGER,
      thumbnail_path TEXT,
      added_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS library_item_artist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_item_id INTEGER NOT NULL,
      artist_name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_library_item_artist_unique
      ON library_item_artist(library_item_id, artist_name);

    CREATE INDEX IF NOT EXISTS idx_library_item_artist_name
      ON library_item_artist(artist_name);

    CREATE TABLE IF NOT EXISTS download_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gallery_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      priority INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      error_message TEXT,
      output_format TEXT NOT NULL DEFAULT 'pdf',
      output_directory TEXT,
      queued_at INTEGER NOT NULL DEFAULT (unixepoch()),
      started_at INTEGER,
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS download_page (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_id INTEGER NOT NULL,
      page_number INTEGER NOT NULL,
      url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      local_path TEXT,
      file_size INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS favorite (
      gallery_id INTEGER PRIMARY KEY,
      added_at INTEGER NOT NULL DEFAULT (unixepoch()),
      synced INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS library_scan_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scanned_at INTEGER NOT NULL DEFAULT (unixepoch()),
      total_items INTEGER NOT NULL DEFAULT 0,
      new_items INTEGER NOT NULL DEFAULT 0,
      removed_items INTEGER NOT NULL DEFAULT 0,
      errors_json TEXT DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS scan_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      scanned_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

  `)

  // Safe migration: add columns only if they don't exist
  const libraryItemCols = sqlite
    .prepare("PRAGMA table_info('library_item')")
    .all() as Array<{ name: string }>
  const colNames = new Set(libraryItemCols.map((c) => c.name))

  if (!colNames.has('file_mtime')) {
    sqlite.exec('ALTER TABLE library_item ADD COLUMN file_mtime INTEGER')
  }
  if (!colNames.has('thumbnail_path')) {
    sqlite.exec('ALTER TABLE library_item ADD COLUMN thumbnail_path TEXT')
  }
  if (!colNames.has('series_index')) {
    sqlite.exec('ALTER TABLE library_item ADD COLUMN series_index REAL')
  }
  if (!colNames.has('language')) {
    sqlite.exec('ALTER TABLE library_item ADD COLUMN language TEXT')
  }
  if (!colNames.has('publisher')) {
    sqlite.exec('ALTER TABLE library_item ADD COLUMN publisher TEXT')
  }
  if (!colNames.has('description')) {
    sqlite.exec('ALTER TABLE library_item ADD COLUMN description TEXT')
  }
}

/**
 * Open a separate better-sqlite3 connection for use in worker threads.
 * Drizzle ORM instances cannot be shared across threads, so workers
 * use raw better-sqlite3 with their own connection.
 */
export function openWorkerConnection(): Database.Database {
  const workerDb = new Database(DB_PATH)
  workerDb.pragma('encoding = "UTF-8"')
  workerDb.pragma('journal_mode = WAL')
  workerDb.pragma('foreign_keys = ON')
  workerDb.pragma('busy_timeout = 5000')
  return workerDb
}
