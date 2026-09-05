//! downloadItem port (download-manager.ts:332-765) — the pipeline in its
//! observable order: cached-metadata parse → API fetch + gallery upsert →
//! placeholder row (is_custom=2) → CDN order → page rows → fresh scratch →
//! page batches of 3 with server rotation/demotion → convert (sanitiser 1
//! path) → complete (placeholder promoted, page count from the file,
//! superseded file removed only after the new one exists) → page rows dropped.
//! Failure: failDownload — row failed, placeholder removed, scratch purged.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::Value;

use super::cdn::CdnState;
use super::page_count::count_pages;
use super::worker_cbz::{generate_cbz_from_paths, generate_download_thumbnail};
use super::worker_pdf::{generate_pdf, PdfOptions};
use crate::metadata::context::{
    file_metadata_from_gallery, GalleryMetadata, TagLike,
};
use crate::metadata::filenames::sanitize_download_title;
use crate::metadata::mappers::Clock;
use crate::nhentai::http::Transport;
use crate::nhentai::types::GalleryDetail;

/// The nhentai page-fetch UA (download-manager.ts:795) — same string as the
/// client's, but the page fetch is a raw fetch outside the API client.
pub const PAGE_USER_AGENT: &str = "Doujin-Downloader/1.0";

/// Page fetch timeout: 30 s in 1.x (via AbortController). The transport owns
/// the real timeout; the constant is kept for parity documentation.
pub const PAGE_TIMEOUT_MS: i64 = 30_000;

/// Batches of 3 concurrent pages (:449); the pause poll is 500 ms (:458).
pub const CONCURRENT_PAGES: usize = 3;
pub const PAUSE_POLL_MS: i64 = 500;

/// Events consumed by tests and the future IPC layer.
#[derive(Debug, Clone, PartialEq)]
pub struct DownloadProgress {
    pub queue_id: i64,
    pub gallery_id: i64,
    pub title: String,
    pub status: String,
    pub total_pages: i64,
    pub completed_pages: i64,
    pub percentage: i64,
    pub speed_kbps: f64,
    pub eta_seconds: i64,
    pub error_message: Option<String>,
}

/// Control flags for the in-flight item (ActiveDownload, :84-90).
#[derive(Debug, Clone, Default)]
pub struct ActiveFlags {
    pub cancel_requested: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub paused: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl ActiveFlags {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.cancel_requested
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
    pub fn cancelled(&self) -> bool {
        self.cancel_requested.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// parseCachedGallery (:40-65): a `gallery` row is usable only with real
/// tags/pages/num_pages/media_id/title — scanner stubs are cache MISSES.
pub fn parse_cached_gallery(raw_json: Option<&str>) -> Option<GalleryDetail> {
    let raw = raw_json?;
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let gallery: GalleryDetail = serde_json::from_value(parsed).ok()?;

    // Every field the pipeline goes on to read without checking (:55-62).
    let usable = !gallery.tags.is_empty()
        && !gallery.pages.is_empty()
        && gallery.num_pages > 0
        && !gallery.media_id.is_empty();
    if usable {
        Some(gallery)
    } else {
        None
    }
}

fn primary_artist_of(gallery: &GalleryDetail) -> String {
    gallery
        .tags
        .iter()
        .find(|t| t.tag_type == "artist")
        .map(|t| t.name.clone())
        .filter(|n| !n.is_empty())
        .or_else(|| {
            gallery
                .tags
                .iter()
                .find(|t| t.tag_type == "group")
                .map(|t| t.name.clone())
                .filter(|n| !n.is_empty())
        })
        .unwrap_or_else(|| "Unknown".to_string())
}

fn group_name_of(gallery: &GalleryDetail) -> Option<String> {
    gallery
        .tags
        .iter()
        .find(|t| t.tag_type == "group")
        .map(|t| t.name.clone())
        .filter(|n| !n.is_empty())
}

fn emit(notify: &mut dyn FnMut(DownloadProgress), p: DownloadProgress) {
    notify(p);
}

#[allow(clippy::too_many_arguments)]
fn emit_progress(
    notify: &mut dyn FnMut(DownloadProgress),
    queue_id: i64,
    gallery_id: i64,
    title: &str,
    total_pages: i64,
    completed_pages: i64,
    speed_kbps: f64,
    eta_seconds: f64,
    status: &str,
) {
    emit(
        notify,
        DownloadProgress {
            queue_id,
            gallery_id,
            title: title.to_string(),
            status: status.to_string(),
            total_pages,
            completed_pages,
            percentage: if total_pages > 0 {
                ((completed_pages as f64 / total_pages as f64) * 100.0).round() as i64
            } else {
                0
            },
            speed_kbps: (speed_kbps * 10.0).round() / 10.0,
            eta_seconds: eta_seconds.round() as i64,
            error_message: None,
        },
    );
}

pub struct PipelineEnv<'a> {
    /// `<userData>` — holds `download-tmp/` and `thumbnails/`.
    pub data_dir: &'a Path,
    pub clock: &'a dyn Clock,
    /// Backoff / pause sleeps, injectable for tests.
    pub sleep: &'a mut dyn FnMut(i64),
    pub notify: &'a mut dyn FnMut(DownloadProgress),
    /// Page fetch transport (1.x: raw fetch with the page UA).
    pub page_fetch: &'a dyn Fn(&str) -> Result<Vec<u8>, PageFetchError>,
}

/// A page fetch outcome the retry loop can classify (404 vs other).
pub enum PageFetchError {
    NotFound,
    Other(String),
}

fn purge_scratch_dir(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

/// failDownload (:314-327).
#[allow(clippy::too_many_arguments)]
fn fail_download(
    conn: &Connection,
    queue_id: i64,
    gallery_id: i64,
    title: &str,
    error_message: &str,
    notify: &mut dyn FnMut(DownloadProgress),
) {
    let _ = crate::db::download::update(
        conn,
        queue_id,
        &crate::db::download::QueueUpdate {
            status: Some("failed".to_string()),
            error_message: Some(Some(error_message.to_string())),
            started_at: None,
            completed_at: None,
        },
    );
    remove_placeholder(conn, gallery_id);
    // scratch purge done by the caller (owns the path)
    emit_progress(notify, queue_id, gallery_id, title, 0, 0, 0.0, 0.0, "failed");
    let _ = error_message;
}

/// removePlaceholder (:299-309): the is_custom=2 + empty-filePath row.
pub fn remove_placeholder(conn: &Connection, gallery_id: i64) {
    let row: Option<(i64, i64, String)> = conn
        .query_row(
            "SELECT id, is_custom, file_path FROM library_item WHERE gallery_id = ?",
            [gallery_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    if let Some((id, is_custom, file_path)) = row {
        if is_custom == 2 && file_path.is_empty() {
            // libraryRepo.delete() removes artist rows too
            let _ = conn.execute(
                "DELETE FROM library_item_artist WHERE library_item_id = ?",
                [id],
            );
            let _ = conn.execute("DELETE FROM library_item WHERE id = ?", [id]);
        }
    }
}

/// One page with retry across CDN servers (downloadPageWithRetry,
/// :770-867). Returns the written file path, or None after exhaustion.
#[allow(clippy::too_many_arguments)]
fn download_page_with_retry(
    env: &mut PipelineEnv<'_>,
    cdn: &mut CdnState,
    flags: &ActiveFlags,
    page_number: i64,
    media_id: &str,
    image_type: &str,
    servers: &[String],
    download_dir: &Path,
    max_retries: u32,
) -> Option<String> {
    for attempt in 0..max_retries {
        if flags.cancelled() {
            return None;
        }
        // Rotate through servers (:783-784).
        let server_index = (attempt as usize) % servers.len();
        let raw_server = &servers[server_index];
        let server = crate::download::cdn::host_of(raw_server);
        let url = format!("https://{server}/galleries/{media_id}/{page_number}.{image_type}");

        match (env.page_fetch)(&url) {
            Ok(buffer) => {
                // Extension from the image type (:811-823).
                let ext = match image_type.to_lowercase().as_str() {
                    "png" => "png",
                    "webp" => "webp",
                    "gif" => "gif",
                    "bmp" => "bmp",
                    _ => "jpg",
                };
                let file_path = download_dir.join(format!("{:04}.{}", page_number, ext));
                if std::fs::write(&file_path, &buffer).is_err() {
                    return None;
                }
                // Re-promote: a success resets the count and clears demotion.
                cdn.record_success(&server);
                return Some(file_path.to_string_lossy().to_string());
            }
            Err(PageFetchError::NotFound) => {
                // 404: page-specific miss — try the next server, never counts.
                continue;
            }
            Err(PageFetchError::Other(_)) => {
                // Non-404 failure counts toward demotion (:846-853).
                cdn.record_failure(&server);
                if attempt == max_retries - 1 {
                    return None;
                }
                // Exponential backoff 1s·2^attempt (:863).
                (env.sleep)(1000 * (1 << attempt));
            }
        }
    }
    None
}

/// The whole pipeline. Returns Ok(()) when the queue row reached a terminal
/// state (completed or failed — both observable via the DB + events).
#[allow(clippy::too_many_arguments)]
pub fn download_item<T: Transport>(
    conn: &mut Connection,
    client: &mut crate::nhentai::ApiClient<T>,
    cdn: &mut CdnState,
    queue_id: i64,
    gallery_id: i64,
    output_format: &str,
    flags: &ActiveFlags,
    library_root: &str,
    data_dir: &Path,
    clock: &dyn Clock,
    sleep: &mut dyn FnMut(i64),
    notify: &mut dyn FnMut(DownloadProgress),
    page_fetch: &dyn Fn(&str) -> Result<Vec<u8>, PageFetchError>,
) {
    let mut env = PipelineEnv {
        data_dir,
        clock,
        sleep,
        notify,
        page_fetch,
    };
    let scratch_dir = env.data_dir.join("download-tmp").join(gallery_id.to_string());

    let result = pipeline_inner(
        conn,
        client,
        cdn,
        queue_id,
        gallery_id,
        output_format,
        flags,
        library_root,
        &mut env,
        &scratch_dir,
    );

    if let Err(error_message) = result {
        // The catch path (:756-758) — title 'Error', message verbatim.
        crate::db::download::update(
            conn,
            queue_id,
            &crate::db::download::QueueUpdate {
                status: Some("failed".to_string()),
                error_message: Some(Some(error_message.clone())),
                started_at: None,
                completed_at: None,
            },
        )
        .ok();
        remove_placeholder(conn, gallery_id);
        emit(
            env.notify,
            DownloadProgress {
                queue_id,
                gallery_id,
                title: "Error".to_string(),
                status: "failed".to_string(),
                total_pages: 0,
                completed_pages: 0,
                percentage: 0,
                speed_kbps: 0.0,
                eta_seconds: 0,
                error_message: Some(error_message),
            },
        );
    }

    // finally: the scratch dir is purged on every exit path (:759-764).
    purge_scratch_dir(&scratch_dir);
}

#[allow(clippy::too_many_lines, clippy::too_many_arguments)]
fn pipeline_inner<T: Transport>(
    conn: &mut Connection,
    client: &mut crate::nhentai::ApiClient<T>,
    cdn: &mut CdnState,
    queue_id: i64,
    gallery_id: i64,
    output_format: &str,
    flags: &ActiveFlags,
    library_root: &str,
    env: &mut PipelineEnv<'_>,
    scratch_dir: &Path,
) -> Result<(), String> {
    // ── Step 1: metadata (:339-371) ────────────────────────────────────────
    let gallery: GalleryDetail = {
        let cached_raw = crate::db::gallery::find_raw_json_by_id(conn, gallery_id)?;
        let cached = parse_cached_gallery(cached_raw.as_deref());
        match cached {
            Some(g) => g,
            None => {
                emit_progress(env.notify, queue_id, gallery_id, "Fetching metadata...", 0, 0, 0.0, 0.0, "downloading");
                let fetched = client
                    .get_gallery(gallery_id, env.clock)?
                    .expect("gallery response");
                let g: GalleryDetail = serde_json::from_str(&fetched.body)
                    .map_err(|e| format!("failed to parse JSON: {e}"))?;
                // Cache to DB — rawJson verbatim (byte parity of the stored
                // string), timestamp columns in seconds (port rule).
                crate::db::gallery::upsert(
                    conn,
                    &crate::db::gallery::GalleryUpsert {
                        id: g.id,
                        media_id: g.media_id.parse::<i64>().unwrap_or(0),
                        title_pretty: &g.title.pretty,
                        title_english: &g.title.english,
                        title_japanese: g.title.japanese.as_deref(),
                        page_count: g.num_pages,
                        favorites_count: g.num_favorites,
                        upload_date: Some(g.upload_date),
                        thumbnail_url: Some(&format!(
                            "https://t.nhentai.net/{}",
                            g.thumbnail.path
                        )),
                        cover_url: Some(&format!("https://t.nhentai.net/{}", g.cover.path)),
                        raw_tags_json: &serde_json::to_string(&g.tags).unwrap_or_default(),
                        raw_json: &fetched.body,
                    },
                    env.clock.now_ms() / 1000,
                )?;
                g
            }
        }
    };

    let title = gallery.title.pretty.clone();
    let total_pages = gallery.num_pages;

    // Artist priority: artist tag → group tag → 'Unknown' (:377-381).
    let primary_artist = primary_artist_of(&gallery);

    // ── Step 1.5: placeholder row (:387-416) ───────────────────────────────
    let tag_names = gallery
        .tags
        .iter()
        .map(|t| t.name.clone())
        .collect::<Vec<_>>()
        .join(", ");
    let language_iso = crate::metadata::xml_utils::resolve_language_name(
        &gallery
            .tags
            .iter()
            .filter(|t| t.tag_type == "language")
            .map(|t| Some(t.name.clone()))
            .collect::<Vec<_>>(),
    );
    let existing_lib: Option<i64> = conn
        .query_row(
            "SELECT id FROM library_item WHERE gallery_id = ?",
            [gallery_id],
            |r| r.get(0),
        )
        .ok();
    if existing_lib.is_none() {
        let now_s = env.clock.now_ms() / 1000;
        conn.execute(
            "INSERT INTO library_item (gallery_id, is_custom, custom_title, custom_tags,
               custom_language, custom_date, custom_cover_path, file_path, file_size,
               format, primary_artist, series_name, publisher, read_progress, file_mtime,
               added_at, updated_at)
             VALUES (?, 2, ?, ?, ?, NULL, NULL, '', 0, ?, ?, NULL, ?, 0, ?, ?, ?)",
            rusqlite::params![
                gallery.id,
                gallery.title.pretty,
                tag_names,
                language_iso,
                output_format,
                primary_artist,
                group_name_of(&gallery),
                env.clock.now_ms(),
                now_s,
                now_s
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    // ── Step 2: CDN servers (:419-420) ─────────────────────────────────────
    // getCdnConfig() — the 1h client cache lives in the ApiClient; a cache
    // hit surfaces no response at all.
    let config: crate::nhentai::CdnConfig = if client.cdn_cache_valid(env.clock.now_ms()) {
        client.cdn_cached().ok_or("API error: no cdn config".to_string())?
    } else {
        let resp = client
            .get_cdn_config_raw(env.clock)?
            .expect("cdn response on miss");
        serde_json::from_str(&resp.body).map_err(|e| format!("failed to parse JSON: {e}"))?
    };
    let servers_raw: Vec<String> = config
        .image_servers
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect();
    let servers = cdn.order_servers(&servers_raw);

    // ── Step 3: page rows (:422-431) ───────────────────────────────────────
    for i in 1..=total_pages {
        crate::db::download::insert_page(conn, queue_id, i)?;
    }

    // ── Step 4: scratch, fresh every attempt (:433-439) ────────────────────
    purge_scratch_dir(scratch_dir);
    std::fs::create_dir_all(scratch_dir).map_err(|e| e.to_string())?;

    // ── Step 5: pages in batches of 3 (:442-518) ───────────────────────────
    let page_items = crate::db::download::get_pages(conn, queue_id)?;
    let mut downloaded_paths: Vec<String> = vec![String::new(); total_pages as usize];
    let mut completed_pages: i64 = 0;
    let mut total_bytes: i64 = 0;
    let start_time = env.clock.now_ms();

    let mut batch_start = 0usize;
    while batch_start < page_items.len() {
        if flags.cancelled() {
            fail_download(conn, queue_id, gallery_id, &title, "Cancelled by user", env.notify);
            purge_scratch_dir(scratch_dir);
            return Ok(());
        }
        // Pause gate: poll between batches (:457-459).
        while flags.paused.load(std::sync::atomic::Ordering::SeqCst)
            && !flags.cancelled()
        {
            (env.sleep)(PAUSE_POLL_MS);
        }
        if flags.cancelled() {
            break;
        }

        let batch = &page_items[batch_start..(batch_start + CONCURRENT_PAGES).min(page_items.len())];
        for page in batch {
            let page_number = page["page_number"].as_i64().unwrap_or(0);
            // Extension from the gallery's page path (:465-466).
            let ext = gallery
                .pages
                .get((page_number - 1) as usize)
                .and_then(|p| p.path.rsplit('.').next())
                .filter(|e| !e.is_empty())
                .unwrap_or("jpg")
                .to_string();
            let media_id = gallery.media_id.clone();
            match download_page_with_retry(
                env,
                cdn,
                flags,
                page_number,
                &media_id,
                &ext,
                &servers,
                scratch_dir,
                3,
            ) {
                Some(path) => {
                    downloaded_paths[(page_number - 1) as usize] = path.clone();
                    completed_pages += 1;
                    total_bytes += std::fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(0);
                }
                None => {
                    crate::db::download::update_page(
                        conn,
                        page["id"].as_i64().unwrap_or(0),
                        "failed",
                        3,
                        None,
                        None,
                    )?;
                }
            }

            let elapsed = (env.clock.now_ms() - start_time) as f64 / 1000.0;
            let speed_kbps = if elapsed > 0.0 {
                total_bytes as f64 / 1024.0 / elapsed
            } else {
                0.0
            };
            let remaining_pages = total_pages - completed_pages;
            let eta_seconds = if completed_pages > 0 {
                (elapsed / completed_pages as f64) * remaining_pages as f64
            } else {
                remaining_pages as f64 * 2.0
            };
            emit_progress(
                env.notify,
                queue_id,
                gallery_id,
                &title,
                total_pages,
                completed_pages,
                speed_kbps,
                eta_seconds,
                "downloading",
            );
        }
        batch_start += CONCURRENT_PAGES;
    }

    if flags.cancelled() {
        fail_download(conn, queue_id, gallery_id, &title, "Cancelled by user", env.notify);
        purge_scratch_dir(scratch_dir);
        return Ok(());
    }

    // All pages present? (:526-535)
    let failed_count = total_pages - completed_pages;
    if failed_count > 0 {
        let message = format!("{failed_count} of {total_pages} pages failed to download");
        fail_download(conn, queue_id, gallery_id, &title, &message, env.notify);
        purge_scratch_dir(scratch_dir);
        return Ok(());
    }

    // ── Step 6: convert (:538-541) ─────────────────────────────────────────
    emit_progress(env.notify, queue_id, gallery_id, &title, total_pages, completed_pages, 0.0, 0.0, "converting");
    crate::db::download::update(
        conn,
        queue_id,
        &crate::db::download::QueueUpdate::status("converting"),
    )?;

    let is_cbz = output_format == "cbz";
    let ext = if is_cbz { "cbz" } else { "pdf" };

    // Output path: sanitiser 1 (`_`-substitute, 180-char cap) + the
    // [nhentai-{id}] marker (:547-553).
    let output_dir = Path::new(library_root).join(&primary_artist);
    if !output_dir.exists() {
        std::fs::create_dir_all(&output_dir).map_err(|e| e.to_string())?;
    }
    let safe_title = sanitize_download_title(&title);
    let output_path = output_dir.join(format!("{safe_title} [nhentai-{gallery_id}].{ext}"));

    // Preserve existing user-set series/volume (:555-558).
    let existing_item: Option<(Option<String>, Option<f64>)> = conn
        .query_row(
            "SELECT series_name, series_index FROM library_item WHERE gallery_id = ?",
            [gallery_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let existing_series = existing_item.as_ref().and_then(|(s, _)| s.clone());
    let existing_volume = existing_item.as_ref().and_then(|(_, i)| *i);

    let valid_paths: Vec<PathBuf> = downloaded_paths
        .iter()
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .collect();

    let thumb_dir = env.data_dir.join("thumbnails");
    let metadata_payload = GalleryMetadata {
        id: gallery.id as f64,
        title: crate::metadata::context::GalleryTitle {
            english: Some(gallery.title.english.clone()),
            japanese: gallery.title.japanese.clone(),
            pretty: Some(gallery.title.pretty.clone()),
        },
        tags: gallery
            .tags
            .iter()
            .map(|t| TagLike {
                id: Some(t.id as f64),
                r#type: t.tag_type.clone(),
                name: t.name.clone(),
            })
            .collect(),
        upload_date: Some(gallery.upload_date as f64),
        num_pages: Some(gallery.num_pages as f64),
        series_name: existing_series,
        series_index: existing_volume,
        language: None,
        publisher: group_name_of(&gallery),
        description: None,
        media_id: gallery.media_id.parse::<f64>().ok(),
        favorites: Some(gallery.num_favorites as f64),
        cover_url: Some(format!("https://t.nhentai.net/{}", gallery.cover.path)),
        thumbnail_url: Some(format!("https://t.nhentai.net/{}", gallery.thumbnail.path)),
        scanlator: Some(gallery.scanlator.clone()),
    };
    let page_count_for_meta = valid_paths.len();

    // ── Worker dispatch (:562-650) ─────────────────────────────────────────
    let thumbnail_path: Option<String> = if is_cbz {
        let manga_direction = "YesAndRightToLeft";
        let ci_meta = file_metadata_from_gallery(
            &metadata_payload,
            crate::metadata::context::FileMetadataOverrides {
                page_count: Some(page_count_for_meta as f64),
                manga_direction: Some(manga_direction.to_string()),
                format: Some("cbz".to_string()),
                ..Default::default()
            },
        );
        let mtime = env.clock.now_ms() as u64;
        generate_cbz_from_paths(&valid_paths, &output_path, &ci_meta, mtime, "jpg")
            .map_err(|e| format!("CBZ generation failed: {e}"))?;
        valid_paths
            .first()
            .and_then(|first| generate_download_thumbnail(first, &thumb_dir, gallery_id))
            .map(|p| p.to_string_lossy().to_string())
    } else {
        // Settings mapping (:634-648) — the port reads the same keys.
        let compress_pdf = true; // compressPdf !== 'false' (default true)
        let compress_quality: i64 = 80;
        let page_size = "dynamic";
        let black_bg = true; // blackBackground !== 'false'
        let options = PdfOptions {
            page_size: page_size.to_string(),
            quality: if compress_pdf {
                compress_quality.clamp(1, 95)
            } else {
                100
            },
            black_background: black_bg,
        };
        let mut gen_log = |msg: String| {
            eprintln!("pdf page dropped: {msg}");
        };
        generate_pdf(&valid_paths, &output_path, &options, &mut gen_log)
            .map_err(|e| format!("PDF generation failed: {e}"))?;

        // XMP + Info dict via the metadata writers — failure warn-only
        // (:48-81, 07-metadata-spec §6 row 1).
        let xmp_meta = file_metadata_from_gallery(
            &metadata_payload,
            crate::metadata::context::FileMetadataOverrides {
                page_count: Some(page_count_for_meta as f64),
                format: Some("pdf".to_string()),
                ..Default::default()
            },
        );
        let clock = SystemClockCompat;
        if let Err(e) = crate::metadata::writers::apply_metadata(
            &output_path,
            crate::metadata::context::Format::Pdf,
            &xmp_meta,
            &clock,
            env.clock.now_ms() as u64,
        ) {
            eprintln!("XMP injection failed, PDF has no embedded metadata: {e}");
        }

        valid_paths
            .first()
            .and_then(|first| generate_download_thumbnail(first, &thumb_dir, gallery_id))
            .map(|p| p.to_string_lossy().to_string())
    };

    // ── Step 8: complete (:653-656) ────────────────────────────────────────
    crate::db::download::update(
        conn,
        queue_id,
        &crate::db::download::QueueUpdate {
            status: Some("completed".to_string()),
            error_message: None,
            started_at: None,
            completed_at: Some(Some(env.clock.now_ms() / 1000)),
        },
    )?;

    // ── Step 9: library entry (:659-735) ───────────────────────────────────
    let lib_item: Option<i64> = conn
        .query_row(
            "SELECT id FROM library_item WHERE gallery_id = ?",
            [gallery.id],
            |r| r.get(0),
        )
        .ok();
    if let Some(lib_id) = lib_item {
        let file_size = std::fs::metadata(&output_path).map(|m| m.len() as i64).unwrap_or(0);
        // new Date(upload_date * 1000).toISOString().split('T')[0] (:663)
        let date_str = match jiff::Timestamp::from_second(gallery.upload_date) {
            Ok(ts) => ts.strftime("%Y-%m-%d").to_string(),
            Err(_) => String::new(),
        };

        // Superseded file removed only after the new one exists (:665-695).
        let superseded: Option<String> = conn
            .query_row(
                "SELECT file_path FROM library_item WHERE id = ?",
                [lib_id],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        if let Some(old) = &superseded {
            if !old.is_empty() {
                let old_abs = crate::download::resolve_library_path(old, library_root);
                if old_abs != output_path && old_abs.exists() {
                    let _ = std::fs::remove_file(&old_abs);
                }
            }
        }

        // Page count counted from the file just written (:697-699).
        let downloaded_pages = count_pages(&output_path, Some(output_format));

        conn.execute(
            "UPDATE library_item SET is_custom = 0, page_count = ?, custom_title = ?,
               custom_tags = ?, custom_language = ?, custom_date = ?, file_path = ?,
               file_size = ?, publisher = ?, file_mtime = ?, updated_at = ?
             WHERE id = ?",
            rusqlite::params![
                downloaded_pages,
                gallery.title.pretty,
                tag_names,
                language_iso,
                date_str,
                crate::download::relativize_library_path(&output_path, library_root),
                file_size,
                group_name_of(&gallery),
                env.clock.now_ms(),
                env.clock.now_ms(),
                lib_id
            ],
        )
        .map_err(|e| e.to_string())?;

        // Artists only when the row has none yet (:715-726).
        let artist_tags: Vec<&crate::nhentai::TagResponse> = gallery
            .tags
            .iter()
            .filter(|t| t.tag_type == "artist")
            .collect();
        let existing_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM library_item_artist WHERE library_item_id = ?",
                [lib_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if existing_count == 0 {
            for (i, artist) in artist_tags.iter().enumerate() {
                let _ = conn.execute(
                    "INSERT OR IGNORE INTO library_item_artist (library_item_id, artist_name, sort_order) VALUES (?, ?, ?)",
                    rusqlite::params![lib_id, artist.name, i as i64],
                );
            }
        }

        if let Some(thumb) = &thumbnail_path {
            let bare = Path::new(thumb)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let _ = conn.execute(
                "UPDATE library_item SET custom_cover_path = ?, thumbnail_path = ? WHERE id = ?",
                rusqlite::params![bare, bare, lib_id],
            );
        }
    }

    // ── Step 10: page bookkeeping dropped (:737-739) ───────────────────────
    crate::db::download::delete_pages(conn, queue_id)?;

    emit_progress(env.notify, queue_id, gallery_id, &title, total_pages, total_pages, 0.0, 0.0, "completed");

    // Notification: gated on showNotifications; the Notifier is trait-
    // abstracted so Phase A is headless (03 §8). Kavita scan hook ABSENT
    // (:748-755 — do not restore).
    Ok(())
}

struct SystemClockCompat;

impl crate::metadata::mappers::Clock for SystemClockCompat {
    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
}
