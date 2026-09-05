//! `seedDefaults` port (connection.ts:119-144): seeded once with
//! INSERT OR IGNORE only when the table is empty — a DB where every setting
//! was deleted re-seeds on next boot.

use rusqlite::Connection;

pub const DEFAULTS: &[(&str, &str)] = &[
    // Empty, not a guessed path (connection.ts:124-127).
    ("libraryPath", ""),
    ("downloadConcurrency", "3"),
    ("outputFormat", "cbz"),
    ("compressPdf", "true"),
    ("compressionQuality", "80"),
    ("pageSize", "Dynamic"),
    ("blackBackground", "true"),
    ("cbzMangaDirection", "YesAndRightToLeft"),
    ("cbzKeepOriginal", "true"),
];

pub fn seed_defaults(conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM app_settings", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if count > 0 {
        return Ok(());
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    for (key, value) in DEFAULTS {
        conn.execute(
            "INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
            rusqlite::params![key, value, now_ms],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
