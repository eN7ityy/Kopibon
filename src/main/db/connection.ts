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
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  db = drizzle(sqlite, { schema })
  runMigrations(sqlite)
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
      read_progress INTEGER NOT NULL DEFAULT 0,
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
  `)
}
