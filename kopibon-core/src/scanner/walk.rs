//! walkLibraryFiles port (library-scanner.worker.ts:592-622). Recursive walk,
//! files only, `.pdf`/`.cbz` case-insensitive; dot-entries and the reserved
//! directories skipped; every readdir failure recorded in `failed_dirs` — a
//! partial walk must be distinguishable from a complete one (removal-guard
//! input #1). Manual recursion mirrors per-level `readdir` failure semantics
//! exactly (walkdir would need a custom error sink for the same shape).

use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct FailedDir {
    pub dir: String,
    pub error: String,
}

#[derive(Debug, Default)]
pub struct WalkResult {
    pub files: Vec<PathBuf>,
    pub failed_dirs: Vec<FailedDir>,
}

/// Reserved directory names, skipped by exact match (:606-607).
const RESERVED_DIRS: [&str; 3] = ["_Unsorted", "_migration_staging", "_originals"];

pub fn walk_library_files(dir: &Path) -> WalkResult {
    let mut files = Vec::new();
    let mut failed_dirs = Vec::new();
    walk_recursive(dir, &mut files, &mut failed_dirs);
    WalkResult {
        files,
        failed_dirs,
    }
}

fn walk_recursive(dir: &Path, files: &mut Vec<PathBuf>, failed_dirs: &mut Vec<FailedDir>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => {
            // TS readdir error message differs from Rust's io::Error display —
            // the *directory* is what the removal guard consumes.
            failed_dirs.push(FailedDir {
                dir: dir.to_string_lossy().to_string(),
                error: err.to_string(),
            });
            return;
        }
    };

    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip dot-entries (:605) and reserved dirs (:606-607).
        if name.starts_with('.') {
            continue;
        }
        if RESERVED_DIRS.contains(&name.as_str()) {
            continue;
        }
        let full_path = dir.join(&name);
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // Dirent.isDirectory/isFile do not follow symlinks; neither does
        // entry.file_type().
        if file_type.is_dir() {
            walk_recursive(&full_path, files, failed_dirs);
        } else if file_type.is_file() {
            let lower = name.to_lowercase();
            if lower.ends_with(".pdf") || lower.ends_with(".cbz") {
                files.push(full_path);
            }
        }
    }
}

/// Node `path.relative(from, to)` for the POSIX absolute-under-root case the
/// scanner actually produces (discovered files are always under the root).
pub fn relative_path(root: &Path, absolute: &Path) -> String {
    let root_str = root.to_string_lossy();
    let abs_str = absolute.to_string_lossy();
    let root_norm = root_str.trim_end_matches('/');
    if let Some(rest) = abs_str.strip_prefix(root_norm) {
        let rest = rest.trim_start_matches('/');
        if rest.is_empty() {
            return ".".to_string();
        }
        return rest.to_string();
    }
    // Outside the root: node would emit ../ segments — not produced by any
    // scanner path; return the absolute path so divergence is loud.
    abs_str.to_string()
}

/// Node `path.isAbsolute` (POSIX): starts with '/'.
pub fn is_absolute(p: &str) -> bool {
    p.starts_with('/')
}

/// Node `path.normalize` (POSIX): collapse duplicate slashes, resolve `.` and
/// `..` lexically, drop trailing slash (except root).
pub fn normalize_path(p: &str) -> String {
    let absolute = p.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for segment in p.split('/') {
        match segment {
            "" | "." => continue,
            ".." => {
                if !out.is_empty() && *out.last().expect("checked") != ".." {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
                // Absolute path: .. above root is dropped.
            }
            other => out.push(other),
        }
    }
    let joined = out.join("/");
    if absolute {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}
