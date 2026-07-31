import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core'

// ─── Gallery ─────────────────────────────────────────────────────────────────

export const gallery = sqliteTable('gallery', {
  id: integer('id').primaryKey(),
  mediaId: integer('media_id').notNull(),
  titlePretty: text('title_pretty').notNull(),
  titleEnglish: text('title_english'),
  titleJapanese: text('title_japanese'),
  pageCount: integer('page_count').notNull().default(0),
  favoritesCount: integer('favorites_count').default(0),
  uploadDate: integer('upload_date'),
  thumbnailUrl: text('thumbnail_url'),
  coverUrl: text('cover_url'),
  rawTagsJson: text('raw_tags_json').notNull().default('[]'),
  rawJson: text('raw_json').notNull(),
  createdAt: integer('created_at').notNull().default(Date.now()),
  updatedAt: integer('updated_at').notNull().default(Date.now())
})

// ─── Library Item ────────────────────────────────────────────────────────────

export const libraryItem = sqliteTable('library_item', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  galleryId: integer('gallery_id').unique(),
  isCustom: integer('is_custom').notNull().default(0),
  customTitle: text('custom_title'),
  customTags: text('custom_tags'),
  customLanguage: text('custom_language'),
  customDate: text('custom_date'),
  customCoverPath: text('custom_cover_path'),
  filePath: text('file_path').notNull(),
  fileSize: integer('file_size'),
  format: text('format').notNull().default('pdf'),
  primaryArtist: text('primary_artist').notNull(),
  seriesName: text('series_name'),
  seriesIndex: real('series_index'),
  language: text('language'),
  publisher: text('publisher'),
  description: text('description'),
  readProgress: integer('read_progress').notNull().default(0),
  fileMtime: integer('file_mtime'),
  thumbnailPath: text('thumbnail_path'),
  addedAt: integer('added_at').notNull().default(Date.now()),
  updatedAt: integer('updated_at').notNull().default(Date.now())
})

// ─── Library Item Artist ─────────────────────────────────────────────────────

export const libraryItemArtist = sqliteTable(
  'library_item_artist',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    libraryItemId: integer('library_item_id').notNull(),
    artistName: text('artist_name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0)
  },
  (table) => [
    uniqueIndex('idx_library_item_artist_unique').on(table.libraryItemId, table.artistName),
    index('idx_library_item_artist_name').on(table.artistName)
  ]
)

// ─── Download Queue ──────────────────────────────────────────────────────────

export const downloadQueue = sqliteTable('download_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  galleryId: integer('gallery_id').notNull(),
  status: text('status').notNull().default('queued'), // queued | downloading | converting | completed | failed
  priority: integer('priority').notNull().default(0),
  retryCount: integer('retry_count').notNull().default(0),
  maxRetries: integer('max_retries').notNull().default(3),
  errorMessage: text('error_message'),
  outputFormat: text('output_format').notNull().default('pdf'),
  outputDirectory: text('output_directory'),
  queuedAt: integer('queued_at').notNull().default(Date.now()),
  startedAt: integer('started_at'),
  completedAt: integer('completed_at')
})

// ─── Download Page ───────────────────────────────────────────────────────────

export const downloadPage = sqliteTable('download_page', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  queueId: integer('queue_id').notNull(),
  pageNumber: integer('page_number').notNull(),
  url: text('url').notNull(),
  status: text('status').notNull().default('pending'), // pending | downloading | downloaded | failed
  localPath: text('local_path'),
  fileSize: integer('file_size'),
  retryCount: integer('retry_count').notNull().default(0)
})

// ─── Favorite ────────────────────────────────────────────────────────────────

export const favorite = sqliteTable('favorite', {
  galleryId: integer('gallery_id').primaryKey(),
  addedAt: integer('added_at').notNull().default(Date.now()),
  synced: integer('synced').notNull().default(1)
})

// ─── App Settings ────────────────────────────────────────────────────────────

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull().default(Date.now())
})

// ─── Library Scan Log ────────────────────────────────────────────────────────

export const libraryScanLog = sqliteTable('library_scan_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  scannedAt: integer('scanned_at').notNull().default(Date.now()),
  totalItems: integer('total_items').notNull().default(0),
  newItems: integer('new_items').notNull().default(0),
  removedItems: integer('removed_items').notNull().default(0),
  errorsJson: text('errors_json').default('[]')
})

// ─── Blocked Values ─────────────────────────────────────────────────────────

/**
 * User-defined values to keep out of, or mark up in, search results.
 *
 * `mode` is per entry rather than a single global setting, because the two are
 * genuinely different jobs:
 *
 *   'exclude' — appended to the search query as a negation (`-tag:"x"`), so the
 *               gallery never arrives. Cheap, and the result counts stay honest.
 *   'dim'     — the gallery still arrives and is marked in the grid. Requires
 *               knowing the result's tag names, which search does not return, so
 *               these rely on the tag cache below.
 *
 * `type` is one of the nhentai tag types, or 'text' for a free-text phrase that
 * matches the title.
 */
export const blockedValue = sqliteTable(
  'blocked_value',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 'tag' | 'artist' | 'group' | 'parody' | 'character' | 'language' | 'text' */
    type: text('type').notNull(),
    /** Stored as entered; matched case-insensitively. */
    value: text('value').notNull(),
    /** 'exclude' | 'dim' */
    mode: text('mode').notNull().default('exclude'),
    createdAt: integer('created_at').notNull().default(Date.now())
  },
  (table) => ({
    // One entry per type+value. Without this, adding the same tag twice would
    // put a duplicate negation in every query.
    uniqueTypeValue: uniqueIndex('idx_blocked_value_type_value').on(table.type, table.value)
  })
)

// ─── Tag Cache ──────────────────────────────────────────────────────────────

/**
 * Tag id → name, populated from `GET /api/v2/tags/ids`.
 *
 * Search results carry `tag_ids` and no names, so without this there is no way
 * to tell whether a result holds a blocked tag — which is what 'dim' mode needs.
 * Persisted rather than held in memory because the endpoint is rate limited
 * (15/min) and tag ids are stable, so a resolved id never needs fetching again.
 */
export const tagCache = sqliteTable('tag_cache', {
  /** The nhentai tag id. */
  id: integer('id').primaryKey(),
  type: text('type').notNull(),
  name: text('name').notNull(),
  updatedAt: integer('updated_at').notNull().default(Date.now())
})

// ─── Scan Queue ─────────────────────────────────────────────────────────────

export const scanQueue = sqliteTable('scan_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  filePath: text('file_path').notNull().unique(),
  status: text('status').notNull().default('pending'),
  priority: integer('priority').notNull().default(0),
  errorMessage: text('error_message'),
  scannedAt: integer('scanned_at'),
  createdAt: integer('created_at').notNull().default(Date.now())
})
