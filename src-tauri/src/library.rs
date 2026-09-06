//! Library shell state + shared helpers (`src/main/ipc/library.ipc.ts:1-360`).
//!
//! Module-scope singletons made explicit: the scan worker handle + flags,
//! both conversion cancel flags, `syncingItems`, the CBZ lock sets,
//! the originals-info cache. Long jobs (scan, metadata conversion, CBZ
//! conversion, sync batch) run on pump threads — the in-process equivalent
//! of the worker threads — emitting the same progress events; the `Db`
//! writer mutex serialises their writes with foreground commands.

use kopibon_core::db::Db;
use kopibon_core::metadata::context::{FileMetadata, FileMetadataOverrides, LibraryItemMetadata};
use kopibon_core::scanner::{ScanControl, ScanState};
use serde_json::{json, Value};
use sha1::Sha1;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::auth::stored_setting;

/// Library pump + lock state. All interior-mutable so pump threads share
/// `&LibraryState` straight off `State<AppState>`; `Send + Sync` holds.
pub struct LibraryState {
    /// `isScanning` + worker liveness (`:57-59`).
    pub scanning: AtomicBool,
    /// Scan pause/cancel (worker `state`; cooperative, checked per item).
    pub scan_paused: AtomicBool,
    pub scan_cancelled: AtomicBool,
    /// `conversionCancelled` (`:2008`), `cbzConversionCancelled` (`:2927`).
    pub conversion_cancelled: AtomicBool,
    pub cbz_cancelled: AtomicBool,
    /// `syncCancelled` (`:2246`): stops the batch loop after the item in
    /// flight — never mid-write.
    pub sync_cancelled: AtomicBool,
    /// `syncingItems` (`:2233`).
    pub syncing_items: Mutex<HashSet<i64>>,
    /// `cbzConverting ∪ cbzQueued` (`:183-189`): one set covers the
    /// in-flight `convert_one` ids too (`conversionLocks` in the workers).
    pub conversion_locks: Mutex<HashSet<i64>>,
    /// `originalsInfoCache` + TTL (`:3439-3445`): 60 s, keyed by root.
    pub originals_cache: Mutex<Option<OriginalsCacheEntry>>,
}

/// `conversionLockError` (`:191-198`): the single refusal every guarded
/// handler reports.
pub fn conversion_lock_error() -> Value {
    json!({
        "success": false,
        "error": "This file is being converted to CBZ. Try again once it finishes."
    })
}

#[derive(Clone)]
pub struct OriginalsCacheEntry {
    pub root: String,
    pub at_ms: i64,
    pub info: Value,
}

impl LibraryState {
    pub fn new() -> Self {
        Self {
            scanning: AtomicBool::new(false),
            scan_paused: AtomicBool::new(false),
            scan_cancelled: AtomicBool::new(false),
            conversion_cancelled: AtomicBool::new(false),
            cbz_cancelled: AtomicBool::new(false),
            sync_cancelled: AtomicBool::new(false),
            syncing_items: Mutex::new(HashSet::new()),
            conversion_locks: Mutex::new(HashSet::new()),
            originals_cache: Mutex::new(None),
        }
    }

    /// `isConversionLocked` (`:186-189`).
    pub fn is_conversion_locked(&self, id: i64) -> bool {
        self.conversion_locks
            .lock()
            .map(|guard| guard.contains(&id))
            .unwrap_or(false)
    }

    pub fn invalidate_originals_info(&self) {
        if let Ok(mut guard) = self.originals_cache.lock() {
            *guard = None;
        }
    }
}

impl ScanControl for LibraryState {
    fn state(&self) -> ScanState {
        if self.scan_cancelled.load(Ordering::SeqCst) {
            ScanState::Cancelled
        } else if self.scan_paused.load(Ordering::SeqCst) {
            ScanState::Paused
        } else {
            ScanState::Scanning
        }
    }

    /// The worker's pause gate: block while paused (100 ms polls), wake on
    /// resume or cancel. The renderer progress stack owns the UX; here the
    /// pump thread simply waits.
    fn wait_while_paused(&self) {
        while self.scan_paused.load(Ordering::SeqCst) && !self.scan_cancelled.load(Ordering::SeqCst)
        {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
}

// ─── Paths ─────────────────────────────────────────────────────────────

/// Trimmed `libraryPath` setting (`:838` and everywhere).
pub fn library_root(db: &Db) -> String {
    stored_setting(db, "libraryPath")
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// `resolveThumbnailDir` (`:216-219`): `thumbnailPath` setting, else
/// `<dataDir>/thumbnails`.
pub fn thumbnail_dir(data_dir: &Path, db: &Db) -> PathBuf {
    let configured = stored_setting(db, "thumbnailPath")
        .unwrap_or_default()
        .trim()
        .to_string();
    if configured.is_empty() {
        data_dir.join("thumbnails")
    } else {
        PathBuf::from(configured)
    }
}

/// `resolveOriginalsRoot` (`:245-250`): `originalsPath` setting, else
/// `<library>/_originals`, else empty.
pub fn originals_root(db: &Db) -> String {
    let configured = stored_setting(db, "originalsPath")
        .unwrap_or_default()
        .trim()
        .to_string();
    if !configured.is_empty() {
        return configured;
    }
    let root = library_root(db);
    if root.is_empty() {
        String::new()
    } else {
        Path::new(&root)
            .join("_originals")
            .to_string_lossy()
            .to_string()
    }
}

/// `resolveCoverPath` (`:225-229`): stored filename → absolute; absolute
/// stored values (pre-migration rows) pass through.
pub fn resolve_cover_path(data_dir: &Path, db: &Db, filename: Option<&str>) -> Option<PathBuf> {
    let filename = filename?;
    if filename.is_empty() {
        return None;
    }
    if Path::new(filename).is_absolute() {
        return Some(PathBuf::from(filename));
    }
    Some(thumbnail_dir(data_dir, db).join(filename))
}

/// `coverFilename` (`:232-235`).
pub fn cover_filename(absolute: Option<&str>) -> Option<String> {
    absolute.and_then(|p| {
        Path::new(p)
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())
    })
}

/// First 16 hex chars of a SHA-1 (the thumbnail key: `sha1(path)[..16]`).
fn sha1_hex16(bytes: &[u8]) -> String {
    use sha1::Digest;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(16);
    for &b in Sha1::new_with_prefix(bytes).finalize().iter().take(8) {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 15) as usize] as char);
    }
    out
}
/// `renameThumbnailForPath` (`:252-279`): move the cached cover to the key
/// the new file path hashes to (`sha1(newPath)[..16] + .jpg`, matching the
/// scanner). Returns the new basename, or `None` when there was nothing to
/// move — the caller then leaves the column alone.
pub fn rename_thumbnail_for_path(
    data_dir: &Path,
    db: &Db,
    current_cover: Option<&str>,
    new_file_path: &str,
) -> Option<String> {
    let resolved = resolve_cover_path(data_dir, db, current_cover)?;
    if !resolved.exists() {
        return None;
    }
    let dest =
        thumbnail_dir(data_dir, db).join(format!("{}.jpg", sha1_hex16(new_file_path.as_bytes())));
    if dest == resolved {
        return resolved
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());
    }
    if dest.exists() {
        let _ = std::fs::remove_file(&resolved);
        return dest
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());
    }
    std::fs::rename(&resolved, &dest).ok()?;
    dest.file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
}

// ─── Hydration + metadata ──────────────────────────────────────────────

/// `hydrateItem` (`:368-380`): stored relative `filePath` → absolute for
/// the renderer; stored cover filename → absolute cover path (falling back
/// to the stored value when unresolvable).
pub fn hydrate_item(data_dir: &Path, db: &Db, item: &Value, library_root: &str) -> Value {
    let mut out = item.clone();
    if let Some(rel) = item.get("filePath").and_then(Value::as_str) {
        if !rel.is_empty() {
            let abs = kopibon_core::download::resolve_library_path(rel, library_root);
            out["filePath"] = json!(abs.to_string_lossy().to_string());
        }
    }
    if let Some(stored) = item.get("customCoverPath").and_then(Value::as_str) {
        if !stored.is_empty() {
            let resolved = resolve_cover_path(data_dir, db, Some(stored))
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| stored.to_string());
            out["customCoverPath"] = json!(resolved);
        }
    }
    out
}

/// `hydrateItems` (`:382+`): map over rows.
pub fn hydrate_items(
    data_dir: &Path,
    db: &Db,
    items: Vec<Value>,
    library_root: &str,
) -> Vec<Value> {
    items
        .iter()
        .map(|item| hydrate_item(data_dir, db, item, library_root))
        .collect()
}

fn opt_str(row: &Value, key: &str) -> Option<String> {
    row.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn opt_f64(row: &Value, key: &str) -> Option<f64> {
    row.get(key).and_then(Value::as_f64)
}

fn row_meta(row: &Value, gallery: Option<&Value>) -> LibraryItemMetadata {
    LibraryItemMetadata {
        gallery_id: opt_f64(row, "galleryId"),
        custom_title: opt_str(row, "customTitle"),
        primary_artist: opt_str(row, "primaryArtist"),
        series_name: opt_str(row, "seriesName"),
        series_index: opt_f64(row, "seriesIndex"),
        custom_tags: opt_str(row, "customTags"),
        custom_language: opt_str(row, "customLanguage"),
        language: opt_str(row, "language"),
        publisher: opt_str(row, "publisher"),
        description: opt_str(row, "description"),
        upload_date: gallery.and_then(|g| opt_f64(g, "uploadDate")),
        raw_tags_json: gallery.and_then(|g| opt_str(g, "rawTagsJson")),
        format: opt_str(row, "format"),
        page_count: opt_f64(row, "pageCount"),
        id: opt_f64(row, "id"),
        title_english: gallery.and_then(|g| opt_str(g, "titleEnglish")),
        title_japanese: gallery.and_then(|g| opt_str(g, "titleJapanese")),
        media_id: gallery.and_then(|g| opt_f64(g, "mediaId")),
        favorites_count: gallery.and_then(|g| opt_f64(g, "favoritesCount")),
        cover_url: gallery.and_then(|g| opt_str(g, "coverUrl")),
        thumbnail_url: gallery.and_then(|g| opt_str(g, "thumbnailUrl")),
        gallery_page_count: gallery.and_then(|g| opt_f64(g, "pageCount")),
    }
}

/// `metaForItem` (`:327-358`): row spread + cached-gallery fold, then the
/// core `file_metadata_from_library_item`. `over` applies field overrides
/// (series/tags/… edits); `manga_direction_default` feeds through.
pub fn meta_for_item(
    db: &Db,
    row: &Value,
    manga_direction_default: &str,
    over: FileMetadataOverrides,
) -> FileMetadata {
    let gallery = row
        .get("galleryId")
        .and_then(Value::as_i64)
        .and_then(|gid| {
            db.with_reader(|conn| kopibon_core::db::gallery::find_by_id(conn, gid))
                .ok()
                .flatten()
        });
    let mut merged = over;
    if merged.format.is_none() {
        merged.format = Some(
            row.get("format")
                .and_then(Value::as_str)
                .unwrap_or("pdf")
                .to_string(),
        );
    }
    if merged.manga_direction.is_none() {
        merged.manga_direction = Some(manga_direction_default.to_string());
    }
    kopibon_core::metadata::context::file_metadata_from_library_item(
        &row_meta(row, gallery.as_ref()),
        merged,
    )
}

/// Default overrides: format + pageCount + manga direction, the three
/// `metaForItem` always sets (`:350-354`).
pub fn default_overrides(db: &Db, row: &Value) -> FileMetadataOverrides {
    FileMetadataOverrides {
        format: Some(
            row.get("format")
                .and_then(Value::as_str)
                .unwrap_or("pdf")
                .to_string(),
        ),
        page_count: Some(row.get("pageCount").and_then(Value::as_f64).unwrap_or(0.0)),
        manga_direction: Some(
            stored_setting(db, "cbzMangaDirection")
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "YesAndRightToLeft".to_string()),
        ),
        ..Default::default()
    }
}

// ─── Thumbnails ────────────────────────────────────────────────────────

/// `buildThumbnailFor` (`:294-310+`): shrink a source image to the
/// scanner's 300×400-inside JPEG q80, keyed `sha1(targetFile)[..16].jpg`.
/// Writes into the *setting-aware* thumbnail dir (`thumbnail_dir`), not the
/// hardcoded userData path the 1.x helper used — identical by default, and
/// findable by `resolve_cover_path` when the user moved it.
pub fn build_thumbnail_for(
    data_dir: &Path,
    db: &Db,
    source_image: &Path,
    target_file: &str,
) -> Result<String, String> {
    let thumb_dir = thumbnail_dir(data_dir, db);
    std::fs::create_dir_all(&thumb_dir).map_err(|e| e.to_string())?;
    let thumb_path = thumb_dir.join(format!("{}.jpg", sha1_hex16(target_file.as_bytes())));
    let img = image::open(source_image).map_err(|e| e.to_string())?;
    let thumb = img.thumbnail(300, 400);
    thumb
        .save_with_format(&thumb_path, image::ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;
    Ok(thumb_path.to_string_lossy().to_string())
}

/// Render a JPEG data-URI thumbnail from raw bytes (preview + first-page
/// covers): inside-fit, JPEG q78, no enlargement (`:3791-3803`).
pub fn jpeg_data_uri_thumb(bytes: &[u8], max_w: u32, max_h: u32) -> Result<String, String> {
    use base64::Engine;
    let img = image::load_from_memory(bytes).map_err(|e| e.to_string())?;
    let thumb = img.thumbnail(max_w, max_h);
    let mut buf = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 78);
    encoder.encode_image(&thumb).map_err(|e| e.to_string())?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&buf)
    ))
}

// ─── CBZ reads ─────────────────────────────────────────────────────────

/// Image entries of a CBZ, sorted by name (`cbz:readPage` `:2758-2771`,
/// `cbz:getPageCount` `:2897-2908`): non-directories, not ComicInfo.xml,
/// image extension, `localeCompare` order (byte order here — the names are
/// zero-padded page files in practice).
pub fn cbz_image_entries(path: &Path) -> Result<Vec<String>, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if name.ends_with('/') || name.ends_with("ComicInfo.xml") {
            continue;
        }
        let lower = name.to_lowercase();
        if lower.ends_with(".jpg")
            || lower.ends_with(".jpeg")
            || lower.ends_with(".png")
            || lower.ends_with(".gif")
            || lower.ends_with(".webp")
            || lower.ends_with(".bmp")
        {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

/// Read one page's bytes by index (`cbz:readPage` `:2781-2860`).
/// Out of range → `Ok(None)` (`'Page not found'`); unreadable archive →
/// `Err` (the envelope error, like yauzl's reject).
pub fn cbz_read_page(path: &Path, page_index: usize) -> Result<Option<Vec<u8>>, String> {
    let names = cbz_image_entries(path)?;
    let Some(name) = names.get(page_index) else {
        return Ok(None);
    };
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut entry = zip.by_name(name).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    use std::io::Read;
    entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(Some(buf))
}

// ─── Misc ──────────────────────────────────────────────────────────────

/// `resolveOutputFormat` (`output-format.ts:1-11`): explicit wins when it
/// names a supported format, else the stored setting, else `'cbz'`.
/// Unrecognised values fall through rather than throwing.
pub fn resolve_output_format(explicit: Option<&str>, stored: Option<&str>) -> String {
    if let Some(f) = explicit {
        if f == "pdf" || f == "cbz" {
            return f.to_string();
        }
    }
    if let Some(f) = stored {
        if f == "pdf" || f == "cbz" {
            return f.to_string();
        }
    }
    "cbz".to_string()
}

/// One archived file: absolute path, size (0 when unreadable), and whether
/// it sits under a `_lossy` segment.
pub struct OriginalFile {
    pub path: PathBuf,
    pub size: i64,
    pub lossy: bool,
}

/// `scanOriginals` (`:3498-3541`): walk the archive. Unreadable dirs are
/// skipped; unreadable files count as 0 bytes. Sync — commands already run
/// off the UI thread, so there is no event loop to keep breathing.
pub fn walk_originals(root: &Path) -> Vec<OriginalFile> {
    fn walk(dir: &Path, in_lossy: bool, out: &mut Vec<OriginalFile>) {
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let now_lossy = in_lossy || entry.file_name().to_string_lossy() == "_lossy";
                walk(&path, now_lossy, out);
            } else if path.is_file() {
                let size = std::fs::metadata(&path)
                    .map(|m| m.len() as i64)
                    .unwrap_or(0);
                out.push(OriginalFile {
                    path,
                    size,
                    lossy: in_lossy,
                });
            }
        }
    }
    let mut out = Vec::new();
    walk(root, false, &mut out);
    out
}

/// The `{ count, bytes, lossyCount, lossyBytes }` summary (`:3561-3570`).
pub fn originals_info(files: &[OriginalFile]) -> Value {
    let (mut count, mut bytes, mut lossy_count, mut lossy_bytes) = (0i64, 0i64, 0i64, 0i64);
    for file in files {
        if file.lossy {
            lossy_count += 1;
            lossy_bytes += file.size;
        } else {
            count += 1;
            bytes += file.size;
        }
    }
    json!({
        "count": count,
        "bytes": bytes,
        "lossyCount": lossy_count,
        "lossyBytes": lossy_bytes,
    })
}

/// Natural sort for page files (`sortNatural` — `addCustom` `:1360-1366`):
/// numeric chunks compare numerically so `10` follows `2`.
pub fn sort_natural(mut names: Vec<String>) -> Vec<String> {
    names.sort_by(|a, b| natural_cmp(a, b));
    names
}

fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (ai, bi) = (a.as_bytes(), b.as_bytes());
    let (mut i, mut j) = (0, 0);
    while i < ai.len() && j < bi.len() {
        let (ca, cb) = (ai[i], bi[j]);
        if ca.is_ascii_digit() && cb.is_ascii_digit() {
            let (mut ni, mut nj) = (i, j);
            while ni < ai.len() && ai[ni].is_ascii_digit() {
                ni += 1;
            }
            while nj < bi.len() && bi[nj].is_ascii_digit() {
                nj += 1;
            }
            let (na, nb) = (&a[i..ni], &b[j..nj]);
            match (na.len().cmp(&nb.len())).then(na.cmp(nb)) {
                std::cmp::Ordering::Equal => {}
                ord => return ord,
            }
            i = ni;
            j = nj;
        } else {
            match ca.cmp(&cb) {
                std::cmp::Ordering::Equal => {
                    i += 1;
                    j += 1;
                }
                ord => return ord,
            }
        }
    }
    ai.len().cmp(&bi.len()).then(a.cmp(b))
}
