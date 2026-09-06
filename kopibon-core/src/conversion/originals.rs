//! _originals archive walk / restore / purge (06 §6) — library.ipc.ts
//! :3498-3767. Ordering of restore is the safety property, kept verbatim.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// scanOriginals (:3498-3541): recursive walk classifying anything under a
/// `_lossy` segment separately; unreadable dirs skipped; failed stats = 0.
pub fn scan_originals(root: &Path) -> Value {
    let mut originals: Vec<String> = Vec::new();
    let mut lossy: Vec<String> = Vec::new();
    let mut bytes = 0i64;
    walk(root, root, false, &mut originals, &mut lossy, &mut bytes);
    json!({
        "root": root,
        "originals": originals,
        "lossy": lossy,
        "count": originals.len() + lossy.len(),
        "bytes": bytes,
    })
}

fn walk(root: &Path, dir: &Path, in_lossy: bool, originals: &mut Vec<String>, lossy: &mut Vec<String>, bytes: &mut i64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return; // unreadable dirs are skipped
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            let now_lossy = in_lossy || name == "_lossy";
            walk(root, &path, now_lossy, originals, lossy, bytes);
        } else if name.to_lowercase().ends_with(".pdf") {
            let size = std::fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(0);
            *bytes += size;
            let rel = path.strip_prefix(root).map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
            if in_lossy {
                lossy.push(rel);
            } else {
                originals.push(rel);
            }
        }
    }
}

/// restoreOriginals (:3595-3690): move the PDF back, CONFIRM it arrived
/// before deleting anything, then delete the CBZ (failure there is NOT a
/// failed restore), then update the row.
pub fn restore_original(
    conn: &rusqlite::Connection,
    original_abs: &Path,
    library_root: &Path,
    item_id: i64,
) -> Result<(), String> {
    // Rel path with the leading `_lossy` segment stripped so a lossy
    // original lands where its sibling would (:3613-3623).
    let rel = original_abs.strip_prefix(library_root.join("_originals"))
        .map_err(|_| "original not under the archive root".to_string())?;
    let mut segments: Vec<_> = rel.components().collect();
    if segments.first().map(|c| c.as_os_str() == "_lossy").unwrap_or(false) {
        segments.remove(0);
    }
    let mut target = library_root.to_path_buf();
    for seg in &segments {
        target.push(seg);
    }

    // Never overwrite an existing target (:3628-3631) — FS check, not DB.
    if target.exists() {
        return Err(format!("restore target already exists: {}", target.display()));
    }

    // Move the PDF back, then CONFIRM it arrived (:3640-3647).
    std::fs::rename(original_abs, &target).map_err(|e| format!("restore move failed: {e}"))?;
    if !target.exists() {
        return Err("restore could not confirm the file arrived".to_string());
    }

    // The CBZ next to it (same stem) is deleted AFTER the PDF is confirmed;
    // failure there is not a failed restore (:3651-3658).
    let stem = target.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let cbz = target.with_file_name(format!("{stem}.cbz"));
    if cbz.exists() {
        let _ = std::fs::remove_file(&cbz);
    }

    // Update the row: format back to pdf, size + mtime from the restored
    // file, cover rename (:3649-3676).
    let size = std::fs::metadata(&target).map(|m| m.len() as i64).unwrap_or(0);
    let mtime = std::fs::metadata(&target)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    conn.execute(
        "UPDATE library_item SET format = 'pdf', file_path = ?, file_size = ?, file_mtime = ? WHERE id = ?",
        rusqlite::params![
            target.strip_prefix(library_root).map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
            size,
            mtime,
            item_id
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// purgeOriginals (:3692-3767): lossy kept unless includeLossy; empty-dir
/// prune walks the archive root AS RESOLVED (the double-append bug at
/// :3722-3725 is not ported); returns the counts.
pub fn purge_originals(root: &Path, include_lossy: bool) -> Value {
    let mut deleted = 0i64;
    let mut bytes = 0i64;
    let mut failed = 0i64;
    let lossy_root = root.join("_lossy");

    // Recursive delete of PDFs under `skip` (the _lossy subtree is spared
    // unless include_lossy).
    fn purge_recursive(
        dir: &Path,
        skip: Option<&Path>,
        deleted: &mut i64,
        bytes: &mut i64,
        failed: &mut i64,
    ) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if Some(path.as_path()) == skip {
                    continue;
                }
                purge_recursive(&path, skip, deleted, bytes, failed);
            } else if path.to_string_lossy().to_lowercase().ends_with(".pdf") {
                let size = std::fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(0);
                match std::fs::remove_file(&path) {
                    Ok(_) => {
                        *deleted += 1;
                        *bytes += size;
                    }
                    Err(_) => *failed += 1,
                }
            }
        }
    }

    purge_recursive(root, Some(&lossy_root), &mut deleted, &mut bytes, &mut failed);
    if include_lossy && lossy_root.exists() {
        purge_recursive(&lossy_root, None, &mut deleted, &mut bytes, &mut failed);
    }

    // Empty-dir prune over the resolved root, deepest first (the
    // double-append bug at :3722-3725 is not ported).
    let mut dirs: Vec<PathBuf> = Vec::new();
    collect_dirs(root, &mut dirs);
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    let mut removed_dirs = 0i64;
    for dir in dirs {
        if std::fs::remove_dir(&dir).is_ok() {
            removed_dirs += 1;
        }
    }

    json!({
        "deleted": deleted,
        "bytes": bytes,
        "failed": failed,
        "removedDirs": removed_dirs,
    })
}

fn collect_dirs(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if entry.path().is_dir() {
            collect_dirs(&entry.path(), out);
            out.push(entry.path());
        }
    }
}
