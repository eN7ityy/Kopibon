//! Typed wrapper over app_settings (settings.repo.ts:9-49; 05-DB §5).
//! Values are stored as strings and parsed at the accessor, with the
//! documented 1.x fallbacks (`Number()`/`===` comparisons, no validation).
//! The Kavita API key is returned as the stored blob — decryption happens
//! in the auth layer, not here.

use rusqlite::Connection;

pub fn get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    let mut stmt = conn
        .prepare("SELECT value FROM app_settings WHERE key = ?")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([key]).map_err(|e| e.to_string())?;
    match rows.next().map_err(|e| e.to_string())? {
        Some(row) => Ok(Some(row.get(0).map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

/// `settingsRepo.set` — read-then-insert/update with `Date.now()` ms stamps
/// (settings.repo.ts:26-37), ported verbatim.
pub fn set(conn: &mut Connection, key: &str, value: &str) -> Result<(), String> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let updated = conn
        .execute(
            "UPDATE app_settings SET value = ?, updated_at = ? WHERE key = ?",
            rusqlite::params![value, now_ms, key],
        )
        .map_err(|e| e.to_string())?;
    if updated == 0 {
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
            rusqlite::params![key, value, now_ms],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// `settingsRepo.getAll` (settings.repo.ts:16-24): whole table as a map.
pub fn get_all(conn: &Connection) -> Result<std::collections::BTreeMap<String, String>, String> {
    let mut stmt = conn
        .prepare("SELECT key, value FROM app_settings")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let k: String = row.get(0)?;
            let v: String = row.get(1)?;
            Ok((k, v))
        })
        .map_err(|e| e.to_string())?;
    let mut out = std::collections::BTreeMap::new();
    for row in rows {
        let (k, v) = row.map_err(|e| e.to_string())?;
        out.insert(k, v);
    }
    Ok(out)
}

/// `settingsRepo.delete` (settings.repo.ts:45-48).
pub fn delete(conn: &mut Connection, key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM app_settings WHERE key = ?", [key])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── typed accessors (03-data-model §7.1–7.2 coercions) ─────────────────────

/// `downloadConcurrency` clamped 1–8 (download-manager.ts:144-152).
pub fn download_concurrency(value: Option<&str>) -> u32 {
    let raw = value
        .and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(3.0);
    raw.clamp(1.0, 8.0) as u32
}

/// `seriesGrouping`: off unless `=== 'true'` (library.ipc.ts:71).
pub fn series_grouping(value: Option<&str>) -> bool {
    value == Some("true")
}

/// `cbzKeepOriginal`: on unless `!== 'false'` (library.ipc.ts:2959).
pub fn cbz_keep_original(value: Option<&str>) -> bool {
    value != Some("false")
}

/// `showNotifications`: on unless `!== 'false'` (download-manager.ts:744).
pub fn show_notifications(value: Option<&str>) -> bool {
    value != Some("false")
}

pub fn output_format(value: Option<&str>) -> String {
    value.unwrap_or("cbz").to_string()
}

pub fn library_path(value: Option<&str>) -> Option<String> {
    // Empty means unset (connection.ts:124-127).
    match value {
        Some(v) if !v.is_empty() => Some(v.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coercions() {
        assert_eq!(download_concurrency(Some("5")), 5);
        assert_eq!(download_concurrency(Some("99")), 8);
        assert_eq!(download_concurrency(Some("0")), 1);
        assert_eq!(download_concurrency(Some("garbage")), 3);
        assert!(series_grouping(Some("true")));
        assert!(!series_grouping(Some("1")));
        assert!(cbz_keep_original(Some("true")));
        assert!(cbz_keep_original(None));
        assert!(!cbz_keep_original(Some("false")));
    }
}
