import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'

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
