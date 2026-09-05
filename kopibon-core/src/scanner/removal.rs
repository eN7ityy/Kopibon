//! The removal pass (library-scanner.worker.ts:972-1044) — the
//! highest-consequence non-metadata component (04-parity-ledger P0). All
//! three guards are mandatory; only when none trips are absent rows deleted
//! with their artist rows, in one transaction (no FKs exist).

use rusqlite::{Connection, OptionalExtension};

use super::walk::{is_absolute, normalize_path};

/// Guard-1 reason: unreadable directories (:980-988).
pub fn unreadable_dirs_reason(failed_dirs: &[super::walk::FailedDir]) -> Option<String> {
    if failed_dirs.is_empty() {
        return None;
    }
    let sample = failed_dirs
        .iter()
        .take(3)
        .map(|f| f.dir.clone())
        .collect::<Vec<_>>()
        .join(", ");
    let ellipsis = if failed_dirs.len() > 3 { ", …" } else { "" };
    Some(format!(
        "{} directory/directories could not be read ({sample}{ellipsis}), so files may exist that this scan did not see. Skipped removing missing items to avoid deleting metadata.",
        failed_dirs.len()
    ))
}

/// Guard-2 reason: count collapse (:993-1001) — last scan log total >= 50 and
/// discovered < 80% of it (vanished-mountpoint backstop).
pub fn count_collapse_reason(conn: &Connection, discovered_count: usize) -> Result<Option<String>, String> {
    let last_log: Option<i64> = conn
        .query_row(
            "SELECT total_items FROM library_scan_log ORDER BY scanned_at DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let previous_total = last_log.unwrap_or(0);
    // Float compare, like the TS (`discovered < previousTotal * 0.8`).
    if previous_total >= 50 && (discovered_count as f64) < previous_total as f64 * 0.8 {
        return Ok(Some(format!(
            "Discovered {discovered_count} files but the last scan saw {previous_total} (a drop of over 20%). Skipped removing missing items — check that the library path is correct and fully mounted, then rescan."
        )));
    }
    Ok(None)
}

/// resolveItemPath (:627-631) over the scan root.
pub fn resolve_item_path(root: &std::path::Path, stored: &str) -> String {
    if stored.is_empty() {
        return String::new();
    }
    if is_absolute(stored) {
        return stored.to_string();
    }
    normalize_path(root.join(stored).to_string_lossy().as_ref())
}

/// The removal decision: given the DB rows and the discovered set, which rows
/// are gone (:1010-1015), then guard 3 (:1022-1028).
pub struct RemovalDecision {
    pub gone: Vec<(i64, String)>,
    pub skipped_reason: Option<String>,
}

pub fn decide_removal(
    conn: &Connection,
    root: &std::path::Path,
    failed_dirs: &[super::walk::FailedDir],
    discovered_absolute: &[String],
) -> Result<RemovalDecision, String> {
    let mut skipped_reason = unreadable_dirs_reason(failed_dirs);
    if skipped_reason.is_none() {
        skipped_reason = count_collapse_reason(conn, discovered_absolute.len())?;
    }

    if skipped_reason.is_some() {
        return Ok(RemovalDecision {
            gone: Vec::new(),
            skipped_reason,
        });
    }

    let all_db_rows: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, file_path FROM library_item")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let discovered_set: std::collections::HashSet<&String> = discovered_absolute.iter().collect();
    // DB stores relative paths; resolve to absolute for comparison.
    let gone: Vec<(i64, String)> = all_db_rows
        .iter()
        .filter(|(_, p)| !discovered_set.contains(&resolve_item_path(root, p)))
        .cloned()
        .collect();

    // Guard 3: never delete a large fraction in one pass (:1017-1028).
    if !gone.is_empty()
        && !all_db_rows.is_empty()
        && (gone.len() as f64) > (all_db_rows.len() as f64) * 0.2
    {
        let reason = format!(
            "Removal pass would delete {} of {} items (over 20%). Skipped removing missing items to avoid a mass deletion — check the library path.",
            gone.len(),
            all_db_rows.len()
        );
        return Ok(RemovalDecision {
            gone: Vec::new(),
            skipped_reason: Some(reason),
        });
    }

    Ok(RemovalDecision {
        gone,
        skipped_reason: None,
    })
}

/// Happy path: delete gone rows + artist rows in ONE transaction (:1030-1044).
pub fn remove_rows(conn: &mut Connection, gone: &[(i64, String)]) -> Result<usize, String> {
    if gone.is_empty() {
        return Ok(0);
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (id, _) in gone {
        tx.execute(
            "DELETE FROM library_item_artist WHERE library_item_id = ?",
            [id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM library_item WHERE id = ?", [id])
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(gone.len())
}
