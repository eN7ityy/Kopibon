//! Line-for-line port of `runMigrations()` (connection.ts:146-493).
//! The DDL block is copied verbatim — `schema.ts` is decorative and wrong
//! (03-data-model §3). On an already-migrated DB every statement here is a
//! no-op: that is the zero-surprise guarantee DB-01 asserts.

use rusqlite::Connection;
use std::collections::HashSet;

const DDL: &str = r#"
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
"#;

/// The one group per name, NOCASE (connection.ts:319); one blocked entry per
/// type+value NOCASE (:325-328); dim mode tag lookup NOCASE (:331).
const COLLATION_INDEXES: &[&str] = &[
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_series_name ON series(name COLLATE NOCASE)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_blocked_value_type_value ON blocked_value(type, value COLLATE NOCASE)",
    "CREATE INDEX IF NOT EXISTS idx_tag_cache_name ON tag_cache(name COLLATE NOCASE)",
];

const TAIL_INDEXES: &[&str] = &[
    // The grouped library query joins on this for every page it renders.
    "CREATE INDEX IF NOT EXISTS idx_library_item_series_id ON library_item(series_id)",
    // The sync loop claims the next pending row on every item.
    "CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status)",
    "CREATE INDEX IF NOT EXISTS idx_conversion_queue_status ON conversion_queue(status)",
];

/// Safe migration: add columns only if they don't exist
/// (connection.ts:334-394).
fn column_names(conn: &Connection, table: &str) -> Result<HashSet<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info('{table}')"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    let mut set = HashSet::new();
    for name in rows {
        set.insert(name.map_err(|e| e.to_string())?);
    }
    Ok(set)
}

pub fn run_migrations(conn: &mut Connection) -> Result<(), String> {
    conn.execute_batch(DDL).map_err(|e| e.to_string())?;

    for stmt in COLLATION_INDEXES {
        conn.execute_batch(stmt).map_err(|e| e.to_string())?;
    }

    // PRAGMA-guarded ALTERs, same shape and order as connection.ts:334-394.
    let col_names = column_names(conn, "library_item")?;
    let alters: &[(&str, &str)] = &[
        (
            "file_mtime",
            "ALTER TABLE library_item ADD COLUMN file_mtime INTEGER",
        ),
        (
            "thumbnail_path",
            "ALTER TABLE library_item ADD COLUMN thumbnail_path TEXT",
        ),
        (
            "series_index",
            "ALTER TABLE library_item ADD COLUMN series_index REAL",
        ),
        (
            "language",
            "ALTER TABLE library_item ADD COLUMN language TEXT",
        ),
        (
            "publisher",
            "ALTER TABLE library_item ADD COLUMN publisher TEXT",
        ),
        (
            "description",
            "ALTER TABLE library_item ADD COLUMN description TEXT",
        ),
        (
            "series_id",
            "ALTER TABLE library_item ADD COLUMN series_id INTEGER",
        ),
        (
            "page_count",
            "ALTER TABLE library_item ADD COLUMN page_count INTEGER",
        ),
    ];
    for (col, sql) in alters {
        if !col_names.contains(*col) {
            conn.execute_batch(sql).map_err(|e| e.to_string())?;
        }
    }

    let series_cols = column_names(conn, "series")?;
    if !series_cols.contains("is_dissolved") {
        conn.execute_batch("ALTER TABLE series ADD COLUMN is_dissolved INTEGER NOT NULL DEFAULT 0")
            .map_err(|e| e.to_string())?;
    }

    for stmt in TAIL_INDEXES {
        conn.execute_batch(stmt).map_err(|e| e.to_string())?;
    }

    let conversion_cols = column_names(conn, "conversion_queue")?;
    if !conversion_cols.contains("library_item_id") {
        conn.execute_batch("ALTER TABLE conversion_queue ADD COLUMN library_item_id INTEGER")
            .map_err(|e| e.to_string())?;
    }
    if !conversion_cols.contains("keep_original") {
        conn.execute_batch(
            "ALTER TABLE conversion_queue ADD COLUMN keep_original INTEGER NOT NULL DEFAULT 1",
        )
        .map_err(|e| e.to_string())?;
    }

    // metadata_queue — the Q6 port decision (06-subsystem-plans §5, P2
    // deviation with its 04-parity-ledger §9 row): convertAllMetadata is
    // crash-resumable in 2.x. Additive CREATE TABLE IF NOT EXISTS — the one
    // deliberate schema touch on already-migrated DBs.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS metadata_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_path TEXT NOT NULL UNIQUE,
          library_item_id INTEGER,
          status TEXT NOT NULL DEFAULT 'pending',
          error_message TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );",
    )
    .map_err(|e| e.to_string())?;

    // ── Path-storage migrations (connection.ts:411-493) ────────────────────
    migrate_cover_paths(conn)?;
    migrate_file_paths(conn)?;
    Ok(())
}

/// Strip directory prefix from custom_cover_path / thumbnail_path
/// (connection.ts:411-438). Sentinel `_migrated_cover_paths` runs it once.
fn migrate_cover_paths(conn: &mut Connection) -> Result<(), String> {
    let done: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = '_migrated_cover_paths'",
            [],
            |row| row.get(0),
        )
        .ok();
    if done.is_some() {
        return Ok(());
    }

    for col in ["custom_cover_path", "thumbnail_path"] {
        let rows: Vec<(i64, String)> = {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT id, {col} FROM library_item WHERE {col} IS NOT NULL AND {col} LIKE '%/%'"
                ))
                .map_err(|e| e.to_string())?;
            let mapped = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            mapped.filter_map(|r| r.ok()).collect()
        };
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (id, val) in rows {
            let bn = basename_posix(&val);
            if bn != val {
                tx.execute(
                    &format!("UPDATE library_item SET {col} = ? WHERE id = ?"),
                    rusqlite::params![bn, id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('_migrated_cover_paths', '1', ?)",
        rusqlite::params![now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Convert absolute file_path values to relative-to-library-root
/// (connection.ts:444-493). Files outside the root keep absolute paths;
/// no library root set → skip and retry on a later boot (sentinel not
/// written).
fn migrate_file_paths(conn: &mut Connection) -> Result<(), String> {
    let done: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = '_migrated_file_paths'",
            [],
            |row| row.get(0),
        )
        .ok();
    if done.is_some() {
        return Ok(());
    }

    let library_root: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'libraryPath'",
            [],
            |row| row.get(0),
        )
        .ok();
    let library_root = library_root.unwrap_or_default().trim().to_string();
    if library_root.is_empty() {
        return Ok(()); // sentinel NOT written; retried on a later boot
    }

    migrate_file_paths_column(conn, "library_item", "file_path", &library_root)?;
    for table in ["conversion_queue", "scan_queue"] {
        migrate_file_paths_column(conn, table, "file_path", &library_root)?;
    }

    conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('_migrated_file_paths', '1', ?)",
        rusqlite::params![now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn migrate_file_paths_column(
    conn: &mut Connection,
    table: &str,
    column: &str,
    library_root: &str,
) -> Result<(), String> {
    let rows: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id, {column} FROM {table} WHERE {column} IS NOT NULL"
            ))
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        mapped.filter_map(|r| r.ok()).collect()
    };
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (id, path) in rows {
        if !is_absolute(&path) {
            continue;
        }
        if let Some(rel) = relative(library_root, &path) {
            // Node: rel must not start with '..' and differ from the input.
            if !rel.starts_with("..") && rel != path {
                tx.execute(
                    &format!("UPDATE {table} SET {column} = ? WHERE id = ?"),
                    rusqlite::params![rel, id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// `path.basename` for the POSIX separators the DB stores.
fn basename_posix(p: &str) -> String {
    match p.rfind('/') {
        Some(i) => p[i + 1..].to_string(),
        None => p.to_string(),
    }
}

/// `path.isAbsolute` (POSIX shapes stored in this DB).
fn is_absolute(p: &str) -> bool {
    p.starts_with('/')
}

/// `path.relative(from, to)` — None when the result would escape `from`
/// via the trailing-`..` guard the caller applies.
fn relative(from: &str, to: &str) -> Option<String> {
    let from = from.trim_end_matches('/');
    let to_trimmed = to.trim_start_matches('/');
    let from_parts: Vec<&str> = from.split('/').filter(|s| !s.is_empty()).collect();
    let to_parts: Vec<&str> = to_trimmed.split('/').filter(|s| !s.is_empty()).collect();
    let mut common = 0;
    while common < from_parts.len()
        && common < to_parts.len()
        && from_parts[common] == to_parts[common]
    {
        common += 1;
    }
    let ups = from_parts.len() - common;
    let mut parts: Vec<String> = Vec::new();
    for _ in 0..ups {
        parts.push("..".to_string());
    }
    for part in &to_parts[common..] {
        parts.push(part.to_string());
    }
    if parts.is_empty() {
        Some(".".to_string())
    } else {
        Some(parts.join("/"))
    }
}

/// The seed/migration stamps in 1.x are `Date.now()` **ms** here
/// (connection.ts:437, :492) — ported verbatim, ms included (03 §10.5).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths() {
        assert_eq!(
            relative("/lib", "/lib/artist/file.cbz").as_deref(),
            Some("artist/file.cbz")
        );
        assert_eq!(
            relative("/lib", "/other/file.cbz").as_deref(),
            Some("../other/file.cbz")
        );
        assert_eq!(relative("/lib", "/lib").as_deref(), Some("."));
    }

    #[test]
    fn basename() {
        assert_eq!(super::basename_posix("/a/b/c.jpg"), "c.jpg");
        assert_eq!(super::basename_posix("c.jpg"), "c.jpg");
    }

    #[test]
    fn fresh_db_migrates_twice_identically() {
        let dir = std::env::temp_dir().join(format!("migr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("db.sqlite");
        let mut conn = Connection::open(&path).unwrap();
        run_migrations(&mut conn).unwrap();
        let schema: String = {
            let mut stmt = conn
                .prepare("SELECT name || '|' || sql FROM sqlite_master ORDER BY name")
                .unwrap();
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
            rows.filter_map(|r| r.ok()).collect::<Vec<_>>().join("\n")
        };
        run_migrations(&mut conn).unwrap();
        let schema2: String = {
            let mut stmt = conn
                .prepare("SELECT name || '|' || sql FROM sqlite_master ORDER BY name")
                .unwrap();
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
            rows.filter_map(|r| r.ok()).collect::<Vec<_>>().join("\n")
        };
        assert_eq!(schema, schema2);
        std::fs::remove_dir_all(&dir).ok();
    }
}
