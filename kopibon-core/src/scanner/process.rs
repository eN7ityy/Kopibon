//! processFile port (library-scanner.worker.ts:668-861). The order is
//! observable: recent-modified skip → incremental skip → extract → derive →
//! existence checks → thumbnail → insert + artists + gallery stub.

use rusqlite::{Connection, OptionalExtension};

use super::extract::{cbz::extract_cbz_metadata, pdf::extract_pdf_metadata, ExtractedMetadata};
use super::thumbnail::{generate_cbz_thumbnail, thumbnail_filename};
use super::walk::{is_absolute, normalize_path, relative_path};
use super::ScanOutcome;
use crate::metadata::mappers::Clock;

pub struct ProcessContext<'a> {
    pub conn: &'a Connection,
    pub root: &'a std::path::Path,
    pub thumbnail_dir: &'a std::path::Path,
    pub clock: &'a dyn Clock,
}

/// resolveItemPath (:627-631).
fn resolve_item_path(root: &std::path::Path, stored: &str) -> String {
    if stored.is_empty() {
        return String::new();
    }
    if is_absolute(stored) {
        return stored.to_string();
    }
    normalize_path(
        root.join(stored)
            .to_string_lossy()
            .as_ref(),
    )
}

/// shouldSkipFile (:668-687): stat mtime (ms) + size vs the stored row —
/// this, not scan_queue, is the incrementality.
fn should_skip_file(ctx: &ProcessContext<'_>, abs_path: &str) -> bool {
    let (current_mtime, current_size) = match std::fs::metadata(abs_path) {
        Ok(meta) => match meta.modified() {
            Ok(modified) => {
                let ms = modified
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                (ms, meta.len() as i64)
            }
            Err(_) => return false,
        },
        Err(_) => return false,
    };

    let rel = relative_path(ctx.root, std::path::Path::new(abs_path));
    let row: Option<(Option<i64>, Option<i64>)> = ctx
        .conn
        .query_row(
            "SELECT file_mtime, file_size FROM library_item WHERE file_path = ?",
            [&rel],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .unwrap_or(None);

    if let Some((mtime, size)) = row {
        if mtime == Some(current_mtime) && size == Some(current_size) {
            return true;
        }
    }
    false
}

/// updateLibraryItemMtime (:717-722).
fn update_library_item_mtime(
    ctx: &ProcessContext<'_>,
    id: i64,
    abs_path: &str,
    file_mtime: i64,
    file_size: i64,
) -> Result<(), String> {
    let rel = relative_path(ctx.root, std::path::Path::new(abs_path));
    ctx.conn
        .execute(
            "UPDATE library_item SET file_path = ?, file_mtime = ?, file_size = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![rel, file_mtime, file_size, ctx.clock.now_ms(), id],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// repairThumbnail (:434-466): on a touched existing row, regenerate a lost
/// thumbnail and write BOTH columns (they had drifted).
fn repair_thumbnail(ctx: &ProcessContext<'_>, row_id: i64, file_path: &str) -> Result<(), String> {
    let cover_file: Option<String> = ctx
        .conn
        .query_row(
            "SELECT custom_cover_path FROM library_item WHERE id = ?",
            [row_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let cover_abs = cover_file.as_ref().map(|f| {
        if is_absolute(f) {
            f.clone()
        } else {
            ctx.thumbnail_dir.join(f).to_string_lossy().to_string()
        }
    });
    if let Some(abs) = &cover_abs {
        if std::path::Path::new(abs).exists() {
            return Ok(());
        }
    }

    let is_cbz = file_path.to_lowercase().ends_with(".cbz");
    let made = if is_cbz {
        generate_cbz_thumbnail(std::path::Path::new(file_path), ctx.thumbnail_dir)
    } else {
        // PDF rasteriser: open escalation (D3/Q-S4) — absent, loudly.
        None
    };
    let Some(made) = made else {
        return Ok(()); // generation failed — logged by the caller, never fatal
    };

    let thumb_filename = made
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    ctx.conn
        .execute(
            "UPDATE library_item SET custom_cover_path = ?, thumbnail_path = ? WHERE id = ?",
            rusqlite::params![thumb_filename, thumb_filename, row_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// insertLibraryItem (:691-715) — exact column set.
#[allow(clippy::too_many_arguments)]
fn insert_library_item(
    ctx: &ProcessContext<'_>,
    gallery_id: Option<i64>,
    is_custom: i64,
    custom_title: &str,
    custom_tags: Option<&str>,
    custom_language: Option<&str>,
    custom_date: Option<&str>,
    custom_cover_path: Option<&str>,
    file_path: &str,
    file_size: i64,
    format: &str,
    primary_artist: &str,
    series_name: Option<&str>,
    series_index: Option<f64>,
    // The 1.x INSERT (:701-707) carries language/publisher/description in the
    // data shape but does NOT write those columns — ported verbatim, unused.
    _language: Option<&str>,
    _publisher: Option<&str>,
    _description: Option<&str>,
    thumbnail_path: Option<&str>,
    file_mtime: i64,
) -> Result<i64, String> {
    let now = ctx.clock.now_ms();
    ctx.conn
        .execute(
            "INSERT INTO library_item (gallery_id, is_custom, custom_title, custom_tags,
              custom_language, custom_date, custom_cover_path, file_path, file_size,
              format, primary_artist, series_name, series_index,
              thumbnail_path, file_mtime,
              read_progress, added_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
            rusqlite::params![
                gallery_id,
                is_custom,
                custom_title,
                custom_tags,
                custom_language,
                custom_date,
                custom_cover_path,
                file_path,
                file_size,
                format,
                primary_artist,
                series_name,
                series_index,
                thumbnail_path,
                file_mtime,
                now,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(ctx.conn.last_insert_rowid())
}

/// upsertGalleryStub (:730-742): `{id, media_id, title{pretty}}` shape — the
/// download manager treats that shape as a cache miss.
fn upsert_gallery_stub(
    ctx: &ProcessContext<'_>,
    gallery_id: i64,
    title: &str,
    upload_date: Option<i64>,
    tags: &[String],
) -> Result<(), String> {
    let exists: Option<i64> = ctx
        .conn
        .query_row("SELECT id FROM gallery WHERE id = ?", [gallery_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    if exists.is_some() {
        return Ok(());
    }
    let now = ctx.clock.now_ms();
    ctx.conn
        .execute(
            "INSERT INTO gallery (id, media_id, title_pretty, title_english, title_japanese,
              page_count, favorites_count, upload_date, thumbnail_url, cover_url, raw_tags_json, raw_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, NULL, 0, 0, ?, NULL, NULL, ?, ?, ?, ?)",
            rusqlite::params![
                gallery_id,
                gallery_id,
                title,
                title,
                upload_date,
                crate::scanner::extract::comicinfo::stub_tags_json(tags),
                crate::scanner::extract::comicinfo::stub_raw_json(gallery_id, title),
                now,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// UTC `toISOString().split('T')[0]` (:831).
fn iso_date_from_ms(ms: i64) -> String {
    // jiff UTC civil date of the instant (toISOString is UTC).
    match jiff::Timestamp::from_millisecond(ms) {
        Ok(ts) => ts.strftime("%Y-%m-%d").to_string(),
        Err(_) => String::new(),
    }
}

/// processFile (:753-861).
pub fn process_file(ctx: &mut ProcessContext<'_>, file_path: &str) -> Result<ScanOutcome, String> {
    // The queue stores relative paths; resolve for filesystem ops.
    let abs_path = resolve_item_path(ctx.root, file_path);

    // Recently-modified skip (:757-764) — concurrent downloads write files.
    if let Ok(meta) = std::fs::metadata(&abs_path) {
        if let Ok(modified) = meta.modified() {
            let mtime_ms = modified
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            if ctx.clock.now_ms() - mtime_ms < 5_000 {
                super::queue::mark(ctx.conn, ctx.root, &abs_path, "completed", ctx.clock.now_ms(), None)?;
                return Ok(ScanOutcome::Skipped);
            }
        }
    }

    // Incremental skip (:767-771).
    if should_skip_file(ctx, &abs_path) {
        super::queue::mark(ctx.conn, ctx.root, &abs_path, "completed", ctx.clock.now_ms(), None)?;
        return Ok(ScanOutcome::Skipped);
    }

    let result = (|| -> Result<ScanOutcome, String> {
        let is_cbz = abs_path.to_lowercase().ends_with(".cbz");
        let format = if is_cbz { "cbz" } else { "pdf" };
        let metadata: ExtractedMetadata = if is_cbz {
            extract_cbz_metadata(std::path::Path::new(&abs_path))
        } else {
            extract_pdf_metadata(std::path::Path::new(&abs_path), ctx.clock.now_ms())
        };

        let mut gallery_id = metadata.gallery_id;
        if gallery_id.is_none() {
            gallery_id = super::extract::extract_id_from_filename(
                &std::path::Path::new(&abs_path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
            );
        }

        let rel_path = relative_path(ctx.root, std::path::Path::new(&abs_path));
        let rel_slashes = rel_path.replace('\\', "/");
        let parts: Vec<&str> = rel_slashes.split('/').collect();
        // parts[0] || 'Unknown' — an empty first segment falls to Unknown.
        let primary_artist_dir = match parts.first() {
            Some(first) if !first.is_empty() => *first,
            _ => "Unknown",
        };
        // Prefer XMP/Keywords series name over directory-derived (:785-787).
        let dir_series_name = if parts.len() >= 3 { Some(parts[1]) } else { None };
        let series_name = metadata
            .series_name
            .clone()
            .filter(|s| !s.is_empty())
            .or(dir_series_name.map(|s| s.to_string()).filter(|s| !s.is_empty()));
        let artists: Vec<String> = if !metadata.authors.is_empty() {
            metadata.authors.clone()
        } else {
            vec![primary_artist_dir.to_string()]
        };
        let title = metadata.title.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| {
            let base = std::path::Path::new(&abs_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let ext_re = if is_cbz {
                regex::Regex::new(r"(?i)\.cbz$").unwrap()
            } else {
                regex::Regex::new(r"(?i)\.pdf$").unwrap()
            };
            let marker_re = regex::Regex::new(r"^\[nhentai-\d+\]\s*").unwrap();
            let stripped = ext_re.replace(&base, "");
            marker_re.replace(&stripped, "").to_string()
        });
        let is_custom: i64 = if gallery_id.is_some() { 0 } else { 1 };

        // stat — failure falls back to (now, 0) (:793-794).
        let (mtime_ms, size) = match std::fs::metadata(&abs_path) {
            Ok(meta) => (
                meta.modified()
                    .ok()
                    .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or_else(|| ctx.clock.now_ms()),
                meta.len() as i64,
            ),
            Err(_) => (ctx.clock.now_ms(), 0),
        };

        // Exists by gallery ID (:797-806)?
        if let Some(gid) = gallery_id {
            let row: Option<(i64, String)> = ctx
                .conn
                .query_row(
                    "SELECT id, file_path FROM library_item WHERE gallery_id = ?",
                    [gid],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some((row_id, row_path)) = row {
                update_library_item_mtime(ctx, row_id, &abs_path, mtime_ms, size)?;
                repair_thumbnail(ctx, row_id, &resolve_item_path(ctx.root, &row_path))?;
                return Ok(ScanOutcome::Skipped);
            }
        }

        // Exists by path (:808-815)?
        let row_by_path: Option<i64> = ctx
            .conn
            .query_row(
                "SELECT id FROM library_item WHERE file_path = ?",
                [&rel_path],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(row_id) = row_by_path {
            update_library_item_mtime(ctx, row_id, &abs_path, mtime_ms, size)?;
            repair_thumbnail(ctx, row_id, &abs_path)?;
            return Ok(ScanOutcome::Skipped);
        }

        // Thumbnail only when the (about-to-be) row has none (:818-823). By
        // this point no row exists for the path, so generation always runs.
        let mut thumbnail_path: Option<String> = None;
        let existing_thumb: Option<Option<String>> = ctx
            .conn
            .query_row(
                "SELECT thumbnail_path FROM library_item WHERE file_path = ?",
                [&rel_path],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if existing_thumb.flatten().is_none() {
            let made = if is_cbz {
                generate_cbz_thumbnail(std::path::Path::new(&abs_path), ctx.thumbnail_dir)
            } else {
                // PDF rasteriser: open escalation (D3/Q-S4) — absent, loudly.
                None
            };
            thumbnail_path = made.map(|p| p.to_string_lossy().to_string());
        }

        let custom_date = metadata.creation_date.map(iso_date_from_ms);
        let custom_cover = thumbnail_path
            .as_ref()
            .map(|p| {
                std::path::Path::new(p)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
            });

        let custom_tags_value = if metadata.tags.is_empty() {
            None
        } else {
            Some(metadata.tags.join(", "))
        };
        let primary_artist_value = artists.first().map(|s| s.as_str()).unwrap_or("Unknown");
        let new_id = insert_library_item(
            ctx,
            gallery_id,
            is_custom,
            &title,
            custom_tags_value.as_deref(),
            metadata.language.as_deref().filter(|l| !l.is_empty()),
            custom_date.as_deref(),
            custom_cover.as_deref(),
            &rel_path,
            size,
            format,
            primary_artist_value,
            series_name.as_deref(),
            metadata.series_index,
            metadata.language.as_deref(),
            metadata.publisher.as_deref(),
            metadata.description.as_deref(),
            thumbnail_path.as_deref(),
            mtime_ms,
        )?;

        for (ai, artist) in artists.iter().enumerate() {
            ctx.conn
                .execute(
                    "INSERT OR IGNORE INTO library_item_artist (library_item_id, artist_name, sort_order) VALUES (?, ?, ?)",
                    rusqlite::params![new_id, artist, ai as i64],
                )
                .map_err(|e| e.to_string())?;
        }

        if let Some(gid) = gallery_id {
            upsert_gallery_stub(
                ctx,
                gid,
                &title,
                metadata.creation_date.map(|ms| ms / 1000),
                &metadata.tags,
            )?;
        }

        Ok(ScanOutcome::New {
            id: new_id,
            title: title.clone(),
            artist: artists.first().cloned().unwrap_or_else(|| "Unknown".to_string()),
        })
    })();

    match result {
        Ok(outcome) => {
            super::queue::mark(ctx.conn, ctx.root, &abs_path, "completed", ctx.clock.now_ms(), None)?;
            Ok(outcome)
        }
        Err(err) => {
            super::queue::mark(
                ctx.conn,
                ctx.root,
                &abs_path,
                "failed",
                ctx.clock.now_ms(),
                Some(&err),
            )?;
            Err(err)
        }
    }
}

/// The repairThumbnail naming check for tests: `sha1(abs)[0..16].jpg`.
pub fn expected_thumbnail_name(abs_path: &str) -> String {
    thumbnail_filename(abs_path)
}
