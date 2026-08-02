import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import * as schema from './schema'

let _dbDir: string | null = null
let _dbPath: string | null = null

function resolveDbDir(): string {
  if (_dbDir) return _dbDir
  // Use app.getPath('userData') when available (main process), fall back to
  // homedir() for worker threads where Electron is not importable.
  try {
    // A static import would break worker threads, where electron is not
    // resolvable at all; this has to stay a guarded runtime require.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron')
    if (app?.getPath) {
      _dbDir = join(app.getPath('userData'))
      _dbPath = join(_dbDir, 'db.sqlite')
      return _dbDir
    }
  } catch {
    /* not in Electron context */
  }
  _dbDir = join(homedir(), '.config', 'doujin-downloader')
  _dbPath = join(_dbDir, 'db.sqlite')
  return _dbDir
}

function resolveDbPath(): string {
  if (!_dbPath) resolveDbDir()
  return _dbPath!
}

let db: ReturnType<typeof drizzle> | null = null
let sqlite: Database.Database | null = null

export function getDbPath(): string {
  return resolveDbPath()
}

export function getRawDatabase(): Database.Database {
  if (!sqlite) {
    initDatabase()
  }
  return sqlite!
}

export function getDbDir(): string {
  return resolveDbDir()
}

export function initDatabase(): ReturnType<typeof drizzle> {
  if (db) return db

  const dbDir = resolveDbDir()
  // Ensure directory exists
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }

  sqlite = new Database(resolveDbPath())
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

/**
 * The raw better-sqlite3 handle behind the Drizzle instance.
 *
 * For the few statements Drizzle cannot express: the conversion queue needs
 * `UPDATE ... RETURNING` so concurrent runners each claim a distinct row.
 * Prefer `getDatabase()` everywhere else.
 */
export function getSqlite(): Database.Database {
  if (!sqlite) {
    initDatabase()
  }
  if (!sqlite) throw new Error('Database is not initialised')
  return sqlite
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
    outputFormat: 'pdf',
    compressPdf: 'true',
    compressionQuality: '80',
    pageSize: 'Dynamic',
    blackBackground: 'true',
    cbzMangaDirection: 'YesAndRightToLeft',
    cbzParodyAsCollection: 'false',
    cbzKeepOriginal: 'true'
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

    CREATE TABLE IF NOT EXISTS conversion_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS blocked_value (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'exclude',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS tag_cache (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_item_id INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_name TEXT,
      cover_item_id INTEGER,
      cover_path TEXT,
      is_manual INTEGER NOT NULL DEFAULT 0,
      is_dissolved INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

  `)

  /*
   * One group per name, case-insensitively. Series names arrive from ComicInfo,
   * from nhentai metadata and from hand entry, so the same series routinely
   * appears with different capitalisation; without NOCASE those would become
   * separate groups holding what is plainly one work.
   *
   * Declared here rather than in the Drizzle schema because Drizzle's
   * uniqueIndex() cannot express a collation, exactly as with blocked_value.
   */
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_series_name ON series(name COLLATE NOCASE)')

  /*
   * One blocked entry per type+value. NOCASE so 'Yuri' and 'yuri' cannot both be
   * added — they would produce two identical negations in every search query.
   */
  sqlite.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_blocked_value_type_value
       ON blocked_value(type, value COLLATE NOCASE)`
  )

  // Dim mode looks tags up by name for every result on screen.
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_tag_cache_name ON tag_cache(name COLLATE NOCASE)')

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
  if (!colNames.has('series_id')) {
    sqlite.exec('ALTER TABLE library_item ADD COLUMN series_id INTEGER')
  }
  if (!colNames.has('page_count')) {
    sqlite.exec('ALTER TABLE library_item ADD COLUMN page_count INTEGER')
  }

  const seriesCols = sqlite.prepare("PRAGMA table_info('series')").all() as Array<{ name: string }>
  if (!seriesCols.some((c) => c.name === 'is_dissolved')) {
    sqlite.exec('ALTER TABLE series ADD COLUMN is_dissolved INTEGER NOT NULL DEFAULT 0')
  }

  // The grouped library query joins on this for every page it renders.
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_library_item_series_id ON library_item(series_id)')

  // The sync loop claims the next pending row on every item.
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status)')

  // conversion_queue was created keyed only on file_path, which is not enough to
  // resume: the path changes from .pdf to .cbz the moment an item succeeds, and
  // the worker needs the library row, not a path. `keep_original` is stored per
  // row because it is a per-run choice the user made in the dialog — a resumed
  // batch must honour that decision rather than silently falling back to
  // whatever the setting says now.
  const conversionCols = sqlite
    .prepare("PRAGMA table_info('conversion_queue')")
    .all() as Array<{ name: string }>
  const convNames = new Set(conversionCols.map((c) => c.name))

  if (!convNames.has('library_item_id')) {
    sqlite.exec('ALTER TABLE conversion_queue ADD COLUMN library_item_id INTEGER')
  }
  if (!convNames.has('keep_original')) {
    sqlite.exec('ALTER TABLE conversion_queue ADD COLUMN keep_original INTEGER NOT NULL DEFAULT 1')
  }
  sqlite.exec(
    'CREATE INDEX IF NOT EXISTS idx_conversion_queue_status ON conversion_queue(status)'
  )
}

/**
 * Open a separate better-sqlite3 connection for use in worker threads.
 * Drizzle ORM instances cannot be shared across threads, so workers
 * use raw better-sqlite3 with their own connection.
 */
export function openWorkerConnection(): Database.Database {
  const workerDb = new Database(resolveDbPath())
  workerDb.pragma('encoding = "UTF-8"')
  workerDb.pragma('journal_mode = WAL')
  workerDb.pragma('foreign_keys = ON')
  workerDb.pragma('busy_timeout = 5000')
  return workerDb
}
