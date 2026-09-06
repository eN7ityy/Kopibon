//! Download manager shell (`src/main/services/download-manager.ts`).
//!
//! The queue TABLE is the state machine (core `db::download` + `download`
//! queue ops, differentially tested); this layer adds what must live in
//! the shell: the pump thread, in-flight flags, progress broadcast, the
//! completion notification, and the concurrency setting.
//!
//! Lock order (global, deadlock-audited): `active`/`titles` → `auth` →
//! `cdn` → DB writer. Commands never nest DB-inside-manager the other
//! way: they clone flags/titles under brief locks, then do DB work
//! unlocked. The pump holds `auth` per ITEM (not per queue) so `api:*`
//! calls interleave between downloads.
//!
//! Parallelism deviation (documented): 1.x runs up to `maxConcurrent`
//! items concurrently; the Phase A pump drains serially (the claim ORDER
//! is what the gate asserts), so the shell runs one pump thread. The
//! setting is still honoured for claim order/raising kicks, and every
//! channel shape is exact.

use kopibon_core::db::Db;
use kopibon_core::download::cdn::CdnState;
use kopibon_core::download::pipeline::{ActiveFlags, DownloadProgress, PageFetchError};
use kopibon_core::metadata::mappers::SystemClock;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::auth::stored_setting;
use crate::events::emit;
use crate::state::AppState;

/// Formats the pipeline can produce (`output-format.ts:17`).
pub const SUPPORTED_OUTPUT_FORMATS: [&str; 2] = ["pdf", "cbz"];
/// Fall-through default (`output-format.ts:21,36-40`).
pub const DEFAULT_OUTPUT_FORMAT: &str = "cbz";

/// `resolveOutputFormat` (output-format.ts:28-40): explicit choice, then
/// the persisted setting, then the default. Unrecognised values at either
/// level fall through.
pub fn resolve_output_format(explicit: Option<&str>, stored: Option<&str>) -> String {
    if let Some(format) = explicit {
        if SUPPORTED_OUTPUT_FORMATS.contains(&format) {
            return format.to_string();
        }
    }
    if let Some(format) = stored {
        if SUPPORTED_OUTPUT_FORMATS.contains(&format) {
            return format.to_string();
        }
    }
    DEFAULT_OUTPUT_FORMAT.to_string()
}

/// Progress event payload (`DownloadProgress`, download-manager.ts:69-80):
/// camelCase keys, rounded speed/percent, `errorMessage` omitted when
/// absent (1.x leaves it `undefined`).
pub fn progress_payload(progress: &DownloadProgress) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    out.insert("queueId".to_string(), serde_json::json!(progress.queue_id));
    out.insert(
        "galleryId".to_string(),
        serde_json::json!(progress.gallery_id),
    );
    out.insert("title".to_string(), serde_json::json!(progress.title));
    out.insert("status".to_string(), serde_json::json!(progress.status));
    out.insert(
        "totalPages".to_string(),
        serde_json::json!(progress.total_pages),
    );
    out.insert(
        "completedPages".to_string(),
        serde_json::json!(progress.completed_pages),
    );
    out.insert(
        "percentage".to_string(),
        serde_json::json!(progress.percentage),
    );
    out.insert(
        "speedKBps".to_string(),
        serde_json::json!((progress.speed_kbps * 10.0).round() / 10.0),
    );
    out.insert(
        "etaSeconds".to_string(),
        serde_json::json!(progress.eta_seconds),
    );
    if let Some(message) = &progress.error_message {
        out.insert("errorMessage".to_string(), serde_json::json!(message));
    }
    serde_json::Value::Object(out)
}

pub struct DownloadManager {
    /// In-flight flags by queue id (`activeDownloads`, `:84-90`).
    active: Mutex<HashMap<i64, ActiveFlags>>,
    /// Last-seen titles by queue id (feeds the completion notification;
    /// the queue row carries no title).
    titles: Mutex<HashMap<i64, String>>,
    /// CDN server health (`serverFailures`/`demotedServers`, `:130-134`).
    cdn: Mutex<CdnState>,
    /// Page image fetcher (30 s timeout + client UA, `:790-796`).
    page_agent: ureq::Agent,
    /// Pump thread alive (`processingQueue`, `:125`).
    running: AtomicBool,
    /// Simultaneous-download limit, 1–8 (`:123`, slider range).
    max_concurrent: Mutex<usize>,
}

impl DownloadManager {
    pub fn new() -> Self {
        DownloadManager {
            active: Mutex::new(HashMap::new()),
            titles: Mutex::new(HashMap::new()),
            cdn: Mutex::new(CdnState::new()),
            page_agent: ureq::Agent::config_builder()
                .http_status_as_error(false)
                .timeout_global(Some(std::time::Duration::from_millis(30_000)))
                .build()
                .into(),
            running: AtomicBool::new(false),
            max_concurrent: Mutex::new(3),
        }
    }

    /// `applyConcurrencyFromSettings` (`:163-169`): absent/unparseable
    /// keeps the current value. Returns whether the limit rose (the caller
    /// kicks the pump to fill new slots).
    pub fn apply_concurrency_from_settings(&self, db: &Db) -> bool {
        let raw = stored_setting(db, "downloadConcurrency");
        let parsed = raw
            .as_deref()
            .and_then(|raw| raw.trim().parse::<f64>().ok())
            .filter(|parsed| parsed.is_finite());
        let Some(parsed) = parsed else { return false };
        self.set_max_concurrent(parsed as i64)
    }

    /// `setMaxConcurrent` (`:144-152`): clamped 1–8. Returns whether the
    /// limit rose (the caller kicks the pump to fill new slots —
    /// `setMaxConcurrent` itself kicks in 1.x, but the shell kick needs
    /// the `AppHandle`, which this level doesn't hold).
    pub fn set_max_concurrent(&self, n: i64) -> bool {
        let next = n.clamp(1, 8) as usize;
        if let Ok(mut guard) = self.max_concurrent.lock() {
            if next == *guard {
                return false;
            }
            let raised = next > *guard;
            *guard = next;
            raised
        } else {
            false
        }
    }

    /// `reconcileInterrupted` + startup kick (`index.ts` boot sequence):
    /// re-queue crashed rows (fast, synchronous), log, and start the pump.
    pub fn startup(&self, app: &AppHandle, state: &AppState) {
        let requeued = state
            .db
            .with_writer(|conn| {
                kopibon_core::download::reconcile_interrupted(conn, &state.data_dir)
            })
            .unwrap_or(0);
        if requeued > 0 {
            state.logger.scope("downloads").info(
                &format!("Re-queued {requeued} interrupted download(s)"),
                None,
            );
        }
        self.apply_concurrency_from_settings(&state.db);
        self.kick(app);
    }

    /// `processQueue` (`:179-208`): start the pump unless one runs.
    pub fn kick(&self, app: &AppHandle) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let app = app.clone();
        std::thread::spawn(move || {
            let state: tauri::State<AppState> = app.state();
            Self::pump(&app, &state);
            state.download.running.store(false, Ordering::SeqCst);
        });
    }

    /// Serial pump: claim → download → notify, until the queue is empty.
    /// One item at a time (see module docs); claims serialize on the DB
    /// writer mutex.
    fn pump(app: &AppHandle, state: &AppState) {
        let clock = SystemClock;
        loop {
            let claimed = state
                .db
                .with_writer(|conn| kopibon_core::download::dequeue_next(conn, &clock));
            let Ok(Some((queue_id, gallery_id, output_format))) = claimed else {
                break;
            };
            let flags = ActiveFlags::new();
            if let Ok(mut guard) = state.download.active.lock() {
                guard.insert(queue_id, flags.clone());
            }
            let library_root = stored_setting(&state.db, "libraryPath").unwrap_or_default();
            let data_dir = state.data_dir.clone();
            let app_for_progress = app.clone();
            let mut notify = |progress: DownloadProgress| {
                if let Ok(mut guard) = state.download.titles.lock() {
                    guard.insert(progress.queue_id, progress.title.clone());
                }
                emit(
                    &app_for_progress,
                    "download:progress",
                    progress_payload(&progress),
                );
            };
            let agent = state.download.page_agent.clone();
            let page_fetch = |url: &str| fetch_page(&agent, url);
            let mut sleep = |ms: i64| {
                std::thread::sleep(std::time::Duration::from_millis(ms.max(0) as u64));
            };
            // Per-item locks (auth → cdn → writer); released before the
            // flags are removed so commands never wait behind bookkeeping.
            if let Ok(mut auth) = state.auth.lock() {
                if let Ok(mut cdn) = state.download.cdn.lock() {
                    let _ = state.db.with_writer(|conn| {
                        kopibon_core::download::pipeline::download_item(
                            conn,
                            auth.client_mut(),
                            &mut cdn,
                            queue_id,
                            gallery_id,
                            &output_format,
                            &flags,
                            &library_root,
                            &data_dir,
                            &clock,
                            &mut sleep,
                            &mut notify,
                            &page_fetch,
                        );
                        Ok::<_, String>(())
                    });
                }
            }
            if let Ok(mut guard) = state.download.active.lock() {
                guard.remove(&queue_id);
            }
            let title = state
                .download
                .titles
                .lock()
                .ok()
                .and_then(|mut guard| guard.remove(&queue_id));
            // Step 9.5/F4: completion notification (`:743-746`).
            let completed = state
                .db
                .with_reader(|conn| kopibon_core::db::download::find_by_id(conn, queue_id))
                .ok()
                .flatten()
                .and_then(|row| {
                    row.get("status")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
                == Some("completed".to_string());
            if completed
                && stored_setting(&state.db, "showNotifications").as_deref() != Some("false")
            {
                notify_completed(
                    app,
                    &title.unwrap_or_else(|| format!("Gallery {gallery_id}")),
                );
            }
        }
    }

    /// `pauseDownload` (`:872-891`).
    pub fn pause_download(&self, db: &Db, queue_id: i64) -> bool {
        let flags = self
            .active
            .lock()
            .ok()
            .and_then(|guard| guard.get(&queue_id).cloned());
        if let Some(flags) = flags {
            flags.paused.store(true, Ordering::SeqCst);
            let _ = db.with_writer(|conn| {
                kopibon_core::db::download::update(
                    conn,
                    queue_id,
                    &kopibon_core::db::download::QueueUpdate::status("paused"),
                )
            });
            return true;
        }
        db.with_writer(|conn| kopibon_core::download::pause_queued(conn, queue_id))
            .unwrap_or(false)
    }

    /// `resumeDownload` (`:896-916`).
    pub fn resume_download(&self, app: &AppHandle, db: &Db, queue_id: i64) -> bool {
        let flags = self
            .active
            .lock()
            .ok()
            .and_then(|guard| guard.get(&queue_id).cloned());
        if let Some(flags) = flags {
            flags.paused.store(false, Ordering::SeqCst);
            let _ = db.with_writer(|conn| {
                kopibon_core::db::download::update(
                    conn,
                    queue_id,
                    &kopibon_core::db::download::QueueUpdate::status("downloading"),
                )
            });
            return true;
        }
        let resumed = db
            .with_writer(|conn| kopibon_core::download::resume_paused(conn, queue_id))
            .unwrap_or(false);
        if resumed {
            self.kick(app);
        }
        resumed
    }

    /// `cancelDownload` (`:921-935`): active → flag (the pipeline settles
    /// the row); queued/paused → delete rows now.
    pub fn cancel_download(&self, db: &Db, queue_id: i64) -> bool {
        let flags = self
            .active
            .lock()
            .ok()
            .and_then(|guard| guard.get(&queue_id).cloned());
        if let Some(flags) = flags {
            flags.cancel();
            return true;
        }
        db.with_writer(|conn| kopibon_core::download::cancel_queued(conn, queue_id))
            .unwrap_or(false)
    }

    /// `pauseAll` (`:940-950`): active flags + queued rows (active rows
    /// keep their DB status — the UI reads the flag — exactly like 1.x).
    pub fn pause_all(&self, db: &Db) {
        if let Ok(guard) = self.active.lock() {
            for flags in guard.values() {
                flags.paused.store(true, Ordering::SeqCst);
            }
        }
        let _ = db.with_writer(|conn| kopibon_core::download::pause_all(conn));
    }

    /// `resumeAll` (`:955-966`).
    pub fn resume_all(&self, app: &AppHandle, db: &Db) {
        if let Ok(guard) = self.active.lock() {
            for flags in guard.values() {
                flags.paused.store(false, Ordering::SeqCst);
            }
        }
        let _ = db.with_writer(|conn| kopibon_core::download::resume_all(conn));
        self.kick(app);
    }
}

impl Default for DownloadManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Page fetch (`downloadPageWithRetry`, `:770-867`): 404 → `NotFound`
/// (try-next-server), anything else → `Other`. UA verbatim (`:794`).
fn fetch_page(agent: &ureq::Agent, url: &str) -> Result<Vec<u8>, PageFetchError> {
    let response = agent
        .get(url)
        .header("User-Agent", kopibon_core::nhentai::CLIENT_USER_AGENT)
        .call()
        .map_err(|e| PageFetchError::Other(e.to_string()))?;
    if response.status().as_u16() == 404 {
        return Err(PageFetchError::NotFound);
    }
    if !response.status().is_success() {
        return Err(PageFetchError::Other(format!(
            "HTTP {}",
            response.status().as_u16()
        )));
    }
    let mut body = response.into_body();
    body.read_to_vec()
        .map_err(|e| PageFetchError::Other(e.to_string()))
}

/// Completion notification (`:743-746`), best-effort.
fn notify_completed(app: &AppHandle, title: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("Download Complete")
        .body(format!("{title} has been added to your library"))
        .show();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Format resolution: explicit → stored → default; garbage falls
    /// through at both levels.
    #[test]
    fn format_resolution() {
        assert_eq!(resolve_output_format(Some("pdf"), Some("cbz")), "pdf");
        assert_eq!(resolve_output_format(None, Some("cbz")), "cbz");
        assert_eq!(resolve_output_format(Some("rar"), Some("cbz")), "cbz");
        assert_eq!(resolve_output_format(Some("rar"), Some("zip")), "cbz");
        assert_eq!(resolve_output_format(None, None), "cbz");
        assert_eq!(resolve_output_format(Some("PDF"), None), "cbz");
    }

    /// Progress payload: camelCase, rounded speed, error omitted/unset.
    #[test]
    fn progress_payload_shape() {
        let progress = DownloadProgress {
            queue_id: 1,
            gallery_id: 2,
            title: "T".to_string(),
            status: "downloading".to_string(),
            total_pages: 3,
            completed_pages: 1,
            percentage: 33,
            speed_kbps: 12.345,
            eta_seconds: 7,
            error_message: None,
        };
        let value = progress_payload(&progress);
        assert_eq!(value["queueId"], serde_json::json!(1));
        assert_eq!(value["speedKBps"], serde_json::json!(12.3));
        assert!(value.get("errorMessage").is_none());
        let mut failed = progress;
        failed.error_message = Some("boom".to_string());
        assert_eq!(
            progress_payload(&failed)["errorMessage"],
            serde_json::json!("boom")
        );
    }
}
