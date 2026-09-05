//! Port of `src/main/services/metadata/templates.ts` — finding and loading
//! the metadata templates (08/01 §4). Two copies exist: shipped defaults
//! (never written) and a per-user copy seeded on first run. The cache is
//! invalidated by mtime. Search order: `$DOUJIN_TEMPLATE_DIR` → packaged
//! resources dir → ≤6-level cwd walk (templates.ts:42-62). In Rust there is
//! no `process.resourcesPath`; the exe-adjacent `resources/metadata-templates`
//! plays that role for packaged builds, and the cwd walk covers dev/test runs
//! from inside the repository.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::SystemTime;

pub const DIR_NAME: &str = "metadata-templates";
pub const TEMPLATE_DIR_ENV: &str = "DOUJIN_TEMPLATE_DIR";
pub const COMICINFO_TEMPLATE: &str = "comicinfo.template";
pub const PDF_XMP_TEMPLATE: &str = "pdf-xmp.template";

/// Directories to look in, most specific first (templates.ts:42-62).
pub fn search_path() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Some(from_env) = std::env::var_os(TEMPLATE_DIR_ENV) {
        if !from_env.is_empty() {
            dirs.push(PathBuf::from(from_env));
        }
    }

    // Packaged-build stand-in for Electron's process.resourcesPath.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            dirs.push(exe_dir.join("resources").join(DIR_NAME));
        }
    }

    // Walk up from the working directory so a tool run from a subdirectory
    // still finds the repository copy (≤6 levels, templates.ts:53-59).
    let mut cursor = std::env::current_dir().ok();
    for _ in 0..6 {
        let Some(dir) = cursor else { break };
        dirs.push(dir.join("resources").join(DIR_NAME));
        match dir.parent() {
            Some(parent) if parent != dir => cursor = Some(parent.to_path_buf()),
            _ => break,
        }
    }
    dirs
}

/// Locate one template file, or None when no candidate directory holds it
/// (templates.ts:65-71).
fn find_template(name: &str) -> Option<PathBuf> {
    for dir in search_path() {
        let candidate = dir.join(name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// The shipped defaults, ignoring any user copy (templates.ts:80-87). Skips
/// whatever `DOUJIN_TEMPLATE_DIR` points at — copying it onto itself would be
/// a no-op that looks like it worked.
fn find_shipped_dir() -> Option<PathBuf> {
    let user_dir = std::env::var_os(TEMPLATE_DIR_ENV);
    for dir in search_path() {
        if let Some(user) = &user_dir {
            if dir.canonicalize().ok().as_deref() == Some(Path::new(user)) {
                continue;
            }
            if dir == Path::new(user) {
                continue;
            }
        }
        if dir.join(COMICINFO_TEMPLATE).exists() {
            return Some(dir);
        }
    }
    None
}

struct CacheEntry {
    path: PathBuf,
    mtime: SystemTime,
    text: String,
}

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Read a template, re-reading it whenever the file on disk has changed
/// (templates.ts:105-125). Throws when the file cannot be found anywhere —
/// the error text is load-bearing (multi-line "Looked in:" message).
pub fn load_template(name: &str) -> Result<String, String> {
    if let Ok(cache) = cache().lock() {
        if let Some(entry) = cache.get(name) {
            match std::fs::metadata(&entry.path).and_then(|m| m.modified()) {
                Ok(mtime) if mtime == entry.mtime => return Ok(entry.text.clone()),
                _ => {} // file went away — fall through and resolve again
            }
        }
    }

    let Some(path) = find_template(name) else {
        let looked: Vec<String> = search_path()
            .iter()
            .map(|d| d.display().to_string())
            .collect();
        return Err(format!(
            "Metadata template \"{}\" not found. Looked in:\n  {}",
            name,
            looked.join("\n  ")
        ));
    };

    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mtime = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH);
    if let Ok(mut cache) = cache().lock() {
        cache.insert(
            name.to_string(),
            CacheEntry {
                path: path.clone(),
                mtime,
                text: text.clone(),
            },
        );
    }
    Ok(text)
}

/// Forget every cached template. Only needed by tests.
pub fn clear_template_cache() {
    if let Ok(mut cache) = cache().lock() {
        cache.clear();
    }
}

/// Make a user-editable copy of the templates and point the app at it
/// (templates.ts:142-162): missing files copied, existing ones never
/// overwritten. Returns the directory in use, or None when the shipped
/// templates could not be located or the target was unwritable — the search
/// path still finds them wherever they are.
pub fn install_user_templates(user_data_dir: &Path) -> Option<PathBuf> {
    let target = user_data_dir.join(DIR_NAME);
    let shipped = find_shipped_dir()?;

    if let Err(_e) = std::fs::create_dir_all(&target) {
        return None;
    }
    let Ok(entries) = std::fs::read_dir(&shipped) else {
        return None;
    };
    for entry in entries.flatten() {
        let dest = target.join(entry.file_name());
        if !dest.exists() && std::fs::copy(entry.path(), &dest).is_err() {
            // A read-only or unwritable userData directory is not a reason
            // to refuse to write metadata (templates.ts:157-160).
            return None;
        }
    }
    std::env::set_var(TEMPLATE_DIR_ENV, &target);
    Some(target)
}
