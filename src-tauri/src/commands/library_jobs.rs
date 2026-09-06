//! Long-running library jobs (`library.ipc.ts:990-1119,2005-2710,2925-3387`):
//! scan, metadata conversion, CBZ conversion, sync.
//!
//! The 1.x jobs ran in Electron utility `Worker`s (separate V8 isolates with
//! their own SQLite connections). Here the *core* owns each job's loop
//! (`run_scan`, `convert_metadata_one`/`convert_one`, `sync_item`); this
//! file owns the Tauri side: concurrency guards, progress events, queue
//! bookkeeping, log files, and the completion payloads.
//!
//! Parallelism note: 1.x ran N worker threads (`runners`, `concurrency`).
//! The ports run serially — rusqlite is single-writer and the core loops are
//! synchronous — while `concurrency`/`Runners` are still read, clamped, and
//! written to the log so the observable config surface does not change.

use std::sync::atomic::Ordering;
use std::time::Duration;

use kopibon_core::db::library_write::FieldValue;
use kopibon_core::metadata::mappers::{Clock, SystemClock};
use serde_json::{json, Value};
use tauri::{Emitter, Manager, State};

use crate::commands::library::{opt_i64, opt_str};
use crate::envelope::{handle, CommandError, LogRecord, LogSink};
use crate::library::library_root;
use crate::state::AppState;

// ─── Scan ──────────────────────────────────────────────────────────────

// Pause/cancel coordination reuses the `ScanControl` impl on `LibraryState`
// (`library.rs`, 100 ms poll gate): these commands only flip the flags.

/// Whole-table regroup after a scan (`regroupAllSeries`, `:94-106`):
/// skipped unless grouping is on; failures only warn.
fn regroup_all_series(state: &AppState) {
    if crate::auth::stored_setting(&state.db, "seriesGrouping").as_deref() != Some("true") {
        return;
    }
    let outcome = state
        .db
        .with_writer(|conn| kopibon_core::db::series::backfill_all(conn, SystemClock.now_ms()));
    let mut fields = serde_json::Map::new();
    match outcome {
        Ok(result) => {
            fields.insert("linked".to_string(), json!(result.linked));
            fields.insert("cleared".to_string(), json!(result.cleared));
            fields.insert("visibleGroups".to_string(), json!(result.visible_groups));
            state.logger.info("regrouped the library", Some(fields));
        }
        Err(error) => {
            fields.insert("error".to_string(), json!(error));
            state
                .logger
                .warn("could not regroup the library", Some(fields));
        }
    }
}

/// `library:scan` (`:990-1086`): guard, reset the flags, detach the thread,
/// return at once. The thread opens its *own* SQLite connection (WAL, busy
/// timeout) — the 1.x scanner worker's private connection — so other
/// commands keep serving while the scan runs.
pub(crate) fn scan_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
    app: &tauri::AppHandle,
) -> Result<Value, CommandError> {
    let library_root_arg = opt_str(args, 0).unwrap_or_default();
    if state.library.scanning.swap(true, Ordering::SeqCst) {
        return Ok(json!({ "success": false, "error": "Scan already in progress" }));
    }
    state.library.scan_paused.store(false, Ordering::SeqCst);
    state.library.scan_cancelled.store(false, Ordering::SeqCst);

    let app = app.clone();
    std::thread::spawn(move || {
        let state: State<'_, AppState> = app.state::<AppState>();
        let finish = |state: &AppState| {
            state.library.scanning.store(false, Ordering::SeqCst);
        };
        let db_path = state.data_dir.join("db.sqlite");
        let mut conn = match kopibon_core::db::connection::open_connection(&db_path) {
            Ok(conn) => conn,
            Err(error) => {
                let _ = app.emit("library:scanError", error);
                finish(&state);
                return;
            }
        };
        let thumb_dir = crate::library::thumbnail_dir(&state.data_dir, &state.db);
        let root_owned = library_root_arg.clone();
        let options = kopibon_core::scanner::ScanOptions {
            library_root: std::path::Path::new(&root_owned),
            thumbnail_dir: &thumb_dir,
        };
        let clock = SystemClock;
        let mut emit = |event: kopibon_core::scanner::ScanEvent| {
            use kopibon_core::scanner::ScanEvent;
            match event {
                ScanEvent::Progress {
                    current,
                    total,
                    status,
                } => {
                    let _ = app.emit(
                        "library:scanProgress",
                        json!({ "current": current, "total": total, "status": status }),
                    );
                }
                ScanEvent::NewItems { items } => {
                    // 1.x sent both the single and the batch; the core batch
                    // carries the items, so the singles fan out here, in order.
                    for item in &items {
                        let _ = app.emit(
                            "library:newItem",
                            json!({ "id": item.id, "title": item.title, "artist": item.artist }),
                        );
                    }
                    let _ = app.emit(
                        "library:newItems",
                        items
                            .iter()
                            .map(|item| {
                                json!({ "id": item.id, "title": item.title, "artist": item.artist })
                            })
                            .collect::<Vec<_>>(),
                    );
                }
                ScanEvent::Paused => {
                    let _ = app.emit("library:scanPaused", Value::Null);
                }
                ScanEvent::Cancelled => {
                    finish(&state);
                    let _ = app.emit("library:scanCancelled", Value::Null);
                }
                ScanEvent::Error { message } => {
                    let _ = app.emit("library:scanError", message);
                }
            }
        };
        let outcome =
            kopibon_core::scanner::run_scan(&mut conn, &options, &clock, &state.library, &mut emit);
        // The terminal result is the return value, not an event: `Some` is
        // the worker's `complete` message (regroup + `scanComplete`), `None`
        // means the `Cancelled` event above already fired.
        match outcome {
            Ok(Some(result)) => {
                regroup_all_series(&state);
                let _ = app.emit(
                    "library:scanComplete",
                    json!({
                        "total": result.total,
                        "newItems": result.new_items,
                        "removedItems": result.removed_items,
                        "errors": result.errors,
                        "cancelled": result.cancelled,
                        "removalSkippedReason": result.removal_skipped_reason,
                    }),
                );
                finish(&state);
            }
            Ok(None) => finish(&state),
            Err(message) => {
                finish(&state);
                let _ = app.emit("library:scanError", message);
            }
        }
    });
    Ok(json!({ "success": true, "data": { "scanning": true } }))
}

/// `library:pauseScan` / `resumeScan` / `cancelScan` (`:1088-1101`): flip
/// the flags the detached scan thread watches (posting to a missing worker
/// was already a no-op success in 1.x).
pub(crate) fn pause_scan_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    state.library.scan_paused.store(true, Ordering::SeqCst);
    Ok(json!({ "success": true }))
}

pub(crate) fn resume_scan_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    state.library.scan_paused.store(false, Ordering::SeqCst);
    Ok(json!({ "success": true }))
}

pub(crate) fn cancel_scan_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    state.library.scan_cancelled.store(true, Ordering::SeqCst);
    Ok(json!({ "success": true }))
}

// ─── Batch Metadata Conversion ───────────────────────────────────────

/// `library:convertAllMetadata` (`:2010-2224`): newest-first over every row,
/// one `convert_metadata_one` per item. The row update on rename already
/// happens inside core — the shell only counts, logs, and reports.
///
/// Parallelism: serial where 1.x ran `concurrency` worker threads (see the
/// module docs); the row-update-on-rename the main thread used to do is
/// core-owned now, so the end state matches.
pub(crate) fn convert_all_metadata_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
    app: &tauri::AppHandle,
) -> Result<Value, CommandError> {
    let runners = opt_i64(args, 0).unwrap_or(3);
    let concurrency = runners.clamp(1, 20);
    state
        .library
        .conversion_cancelled
        .store(false, Ordering::SeqCst);

    let items = state
        .db
        .with_reader(kopibon_core::db::library_write::find_all_items)
        .map_err(CommandError::Thrown)?;
    let total = items.len() as i64;
    let mut converted = 0i64;
    let mut failed = 0i64;
    let mut errors: Vec<String> = Vec::new();
    let mut log_lines: Vec<String> = Vec::new();

    // File logging (`:2028-2047`): same directory as the scanner logs.
    let log_dir = state.data_dir.join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let stamp = crate::log::now_iso().replace([':', '.'], "-");
    let log_path = log_dir.join(format!("convert-{stamp}.log"));
    let write_log = |line: &str| {
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            let _ = writeln!(file, "{line}");
        }
    };
    // Header lines are written with fresh opens (mirror the three
    // `writeFileSync` calls); the body appends through the same helper.
    {
        use std::io::Write;
        if let Ok(mut file) = std::fs::File::create(&log_path) {
            let _ = writeln!(
                file,
                "Conversion started at {}\n{}\nTotal items: {total}\nRunners: {concurrency}",
                crate::log::now_iso(),
                "=".repeat(60),
            );
        }
    }

    let send_progress =
        |app: &tauri::AppHandle, converted: i64, failed: i64, log_lines: &mut Vec<String>| {
            let _ = app.emit(
                "library:convertProgress",
                json!({
                    "current": converted + failed,
                    "total": total,
                    "converted": converted,
                    "failed": failed,
                    "logLines": std::mem::take(log_lines),
                }),
            );
        };

    let library_root_setting = library_root(&state.db);
    let clock = SystemClock;
    for item in &items {
        if state.library.conversion_cancelled.load(Ordering::SeqCst) {
            break;
        }
        let stored = item.get("filePath").and_then(Value::as_str).unwrap_or("");
        let outcome = state.db.with_writer(|conn| {
            kopibon_core::conversion::metadata_job::convert_metadata_one(
                conn,
                &library_root_setting,
                stored,
                &clock,
            )
        });
        match outcome {
            Ok(line) => {
                if !state.library.conversion_cancelled.load(Ordering::SeqCst) {
                    converted += 1;
                } else {
                    failed += 1;
                }
                write_log(&line);
                log_lines.push(line);
            }
            Err(error) => {
                failed += 1;
                errors.push(error.clone());
                let name = std::path::Path::new(stored)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(stored);
                let line = format!("FAIL {name}: {error}");
                write_log(&line);
                log_lines.push(line);
            }
        }
        send_progress(app, converted, failed, &mut log_lines);
    }

    send_progress(app, converted, failed, &mut log_lines);
    let cancelled = state.library.conversion_cancelled.load(Ordering::SeqCst);
    write_log(&format!(
        "{}\n{}: {converted} converted, {failed} failed, {total} total",
        "=".repeat(60),
        if cancelled { "CANCELLED" } else { "COMPLETE" },
    ));
    Ok(json!({
        "success": true,
        "data": {
            "converted": converted,
            "failed": failed,
            "total": total,
            "cancelled": cancelled,
            "errors": if errors.is_empty() { Value::Null } else {
                json!(errors.into_iter().take(20).collect::<Vec<_>>())
            },
        },
    }))
}

/// `library:cancelConversion` (`:2226-2229`).
pub(crate) fn cancel_conversion_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    state
        .library
        .conversion_cancelled
        .store(true, Ordering::SeqCst);
    Ok(json!({ "success": true }))
}

// ─── Convert to CBZ ────────────────────────────────────────────────────

/// `library:convertToCbz` (`:2929-3379`): dry-run, queue seed/resume, then a
/// serial claim loop over core `convert_one` (completion — cover rename,
/// recount, row update — lives in core). Progress carries the live
/// active/queued sets; an unexpected throw clears the locks but leaves
/// pending rows resumable (`:3366-3377`).
pub(crate) fn convert_to_cbz_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
    app: &tauri::AppHandle,
) -> Result<Value, CommandError> {
    let ids: Vec<i64> = args
        .first()
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default();
    let dry_run = args.get(1).and_then(Value::as_bool).unwrap_or(false);
    let options = args.get(2).cloned().unwrap_or(Value::Null);

    let library_root_setting =
        crate::auth::stored_setting(&state.db, "libraryPath").unwrap_or_default();
    let keep_original = options
        .get("keepOriginal")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            crate::auth::stored_setting(&state.db, "cbzKeepOriginal").as_deref() != Some("false")
        });
    if keep_original
        && (library_root_setting.trim().is_empty()
            || !std::path::Path::new(library_root_setting.trim()).exists())
    {
        return Ok(json!({
            "success": false,
            "error": "Library path is not set or does not exist. Set it in Settings before converting, or disable \"keep original\".",
        }));
    }
    let manga_direction = crate::auth::stored_setting(&state.db, "cbzMangaDirection")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "YesAndRightToLeft".to_string());

    if dry_run {
        let items: Vec<Value> = ids
            .iter()
            .filter_map(|id| {
                state
                    .db
                    .with_reader(|conn| kopibon_core::db::library_write::find_item_by_id(conn, *id))
                    .ok()
                    .flatten()
                    .map(|item| {
                        json!({
                            "id": item.get("id"),
                            "title": item.get("customTitle"),
                            "format": item.get("format"),
                        })
                    })
            })
            .collect();
        let count = items.len() as i64;
        return Ok(json!({
            "success": true,
            "data": { "dryRun": true, "items": items, "count": count },
        }));
    }

    let targets: Vec<Value> = ids
        .iter()
        .filter_map(|id| {
            state
                .db
                .with_reader(|conn| kopibon_core::db::library_write::find_item_by_id(conn, *id))
                .ok()
                .flatten()
        })
        .filter(|item| item.get("format").and_then(Value::as_str).unwrap_or("pdf") == "pdf")
        .collect();
    let skipped = ids.len() as i64 - targets.len() as i64;

    let resume = options.get("resume").and_then(Value::as_bool) == Some(true);
    if !resume {
        if targets.is_empty() {
            return Ok(json!({
                "success": true,
                "data": { "converted": 0, "failed": 0, "total": 0, "skipped": skipped, "cancelled": false },
            }));
        }
        state
            .db
            .with_writer(|conn| {
                kopibon_core::db::conversion::clear_finished_rows(conn).map(|_| ())?;
                for item in &targets {
                    let id = item.get("id").and_then(Value::as_i64);
                    let path = item.get("filePath").and_then(Value::as_str).unwrap_or("");
                    kopibon_core::db::conversion::enqueue(conn, path, id, keep_original)?;
                }
                Ok::<(), String>(())
            })
            .map_err(CommandError::Thrown)?;
    }

    let batch_total = state
        .db
        .with_reader(kopibon_core::db::conversion::counts)
        .map_err(CommandError::Thrown)?
        .get("pending")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if batch_total == 0 {
        return Ok(json!({
            "success": true,
            "data": { "converted": 0, "failed": 0, "total": 0, "skipped": skipped, "cancelled": false },
        }));
    }

    state.library.cbz_cancelled.store(false, Ordering::SeqCst);
    // Seed the edit-guard + progress sets from the outstanding rows.
    let seed: Vec<i64> = state
        .db
        .with_reader(kopibon_core::db::conversion::pending_item_ids)
        .map_err(CommandError::Thrown)?;
    let mut queued: std::collections::HashSet<i64> = seed.iter().cloned().collect();
    let mut active: std::collections::HashSet<i64> = std::collections::HashSet::new();
    if let Ok(mut locks) = state.library.conversion_locks.lock() {
        locks.extend(seed.iter().cloned());
    }

    let mut converted = 0i64;
    let mut failed = 0i64;
    let mut forced_keeps = 0i64;
    let mut errors: Vec<String> = Vec::new();
    let mut log_lines: Vec<String> = Vec::new();
    let send_progress = |app: &tauri::AppHandle,
                         running: bool,
                         converted: i64,
                         failed: i64,
                         log_lines: &mut Vec<String>,
                         active: &std::collections::HashSet<i64>,
                         queued: &std::collections::HashSet<i64>| {
        let _ = app.emit(
            "library:convertToCbzProgress",
            json!({
                "current": converted + failed,
                "total": batch_total,
                "converted": converted,
                "failed": failed,
                "skipped": skipped,
                "running": running,
                "activeIds": active.iter().collect::<Vec<_>>(),
                "queuedIds": queued.iter().collect::<Vec<_>>(),
                "logLines": std::mem::take(log_lines),
            }),
        );
    };

    let originals_root_owned = crate::library::originals_root(&state.db);
    let thumb_dir_owned = crate::library::thumbnail_dir(&state.data_dir, &state.db);
    let clock = SystemClock;
    // An unexpected throw must not strand claimed rows as uneditable
    // (`:3366-3377`); the inner closure returns the error for the cleanup
    // below to re-throw after clearing the locks.
    let run = |state: &AppState,
               app: &tauri::AppHandle,
               converted: &mut i64,
               failed: &mut i64,
               forced_keeps: &mut i64,
               errors: &mut Vec<String>,
               log_lines: &mut Vec<String>,
               active: &mut std::collections::HashSet<i64>,
               queued: &mut std::collections::HashSet<i64>| {
        loop {
            if state.library.cbz_cancelled.load(Ordering::SeqCst) {
                break;
            }
            let claim: Option<(i64, String)> = state
                .db
                .with_writer(kopibon_core::conversion::claim_next)
                .map_err(CommandError::Thrown)?;
            let Some((row_id, stored)) = claim else {
                break;
            };
            // Stale-row path (`:3117-3127`): the worker format check is
            // STRICT — a missing format does not count as PDF here.
            let row = state
                .db
                .with_reader(|conn| {
                    kopibon_core::db::library_write::find_item_by_file_path(conn, &stored)
                })
                .map_err(CommandError::Thrown)?;
            let is_pdf = row
                .as_ref()
                .and_then(|item| item.get("format"))
                .and_then(Value::as_str)
                == Some("pdf");
            let item_id = row
                .as_ref()
                .and_then(|item| item.get("id"))
                .and_then(Value::as_i64);
            if row.is_none() || !is_pdf {
                state
                    .db
                    .with_writer(|conn| {
                        kopibon_core::conversion::mark_completed(
                            conn,
                            row_id,
                            SystemClock.now_ms() / 1000,
                        )
                    })
                    .map_err(CommandError::Thrown)?;
                if let Some(id) = item_id {
                    queued.remove(&id);
                    if let Ok(mut locks) = state.library.conversion_locks.lock() {
                        locks.remove(&id);
                    }
                }
                send_progress(app, true, *converted, *failed, log_lines, active, queued);
                continue;
            }
            let item_id = item_id.unwrap_or(0);
            queued.remove(&item_id);
            active.insert(item_id);
            send_progress(app, true, *converted, *failed, log_lines, active, queued);

            let item = state
                .db
                .with_reader(|conn| kopibon_core::conversion::fetch_item(conn, &stored))
                .map_err(CommandError::Thrown)?
                .map(|mut fetched| {
                    // The worker command carries the RESOLVED absolute path
                    // (library.ipc.ts:3151) — same one-liner as the core
                    // batch loop (conversion/mod.rs:299).
                    fetched.file_path = kopibon_core::download::resolve_library_path(
                        &stored,
                        library_root_setting.trim(),
                    )
                    .to_string_lossy()
                    .to_string();
                    fetched
                });
            let outcome = match item {
                None => {
                    state
                        .db
                        .with_writer(|conn| {
                            kopibon_core::conversion::mark_completed(
                                conn,
                                row_id,
                                SystemClock.now_ms() / 1000,
                            )
                        })
                        .map_err(CommandError::Thrown)?;
                    active.remove(&item_id);
                    if let Ok(mut locks) = state.library.conversion_locks.lock() {
                        locks.remove(&item_id);
                    }
                    send_progress(app, true, *converted, *failed, log_lines, active, queued);
                    continue;
                }
                Some(ref fetched) => {
                    let mut lines: Vec<String> = Vec::new();
                    let mut tap = |line: String| lines.push(line);
                    // Per-row keep (`:3179`): a resumed queue may carry an
                    // older choice than this run's setting.
                    let row_keep: Option<bool> = state
                        .db
                        .with_reader(|conn| {
                            conn.query_row(
                                "SELECT keep_original FROM conversion_queue WHERE id = ?",
                                [row_id],
                                |r| r.get::<_, i64>(0),
                            )
                            .map_err(|e| e.to_string())
                        })
                        .ok()
                        .map(|v| v != 0);
                    let item_options = kopibon_core::conversion::worker_cbz::ConvertOptions {
                        library_root: library_root_setting.trim(),
                        originals_root: &originals_root_owned,
                        user_data_dir: &state.data_dir,
                        keep_original: row_keep.unwrap_or(keep_original),
                        manga_direction: manga_direction.clone(),
                        thumbnail_dir: Some(&thumb_dir_owned),
                    };
                    let result = state.db.with_writer(|conn| {
                        kopibon_core::conversion::convert_one(
                            conn,
                            fetched,
                            &item_options,
                            &clock,
                            &mut tap,
                        )
                    });
                    log_lines.extend(lines);
                    result
                }
            };
            match outcome {
                Ok(value) => {
                    if state.library.cbz_cancelled.load(Ordering::SeqCst) {
                        state
                            .db
                            .with_writer(|conn| kopibon_core::db::conversion::release(conn, row_id))
                            .map_err(CommandError::Thrown)?;
                    } else {
                        *converted += 1;
                        if value.get("forcedKeep").and_then(Value::as_bool) == Some(true) {
                            *forced_keeps += 1;
                        }
                    }
                }
                Err(error) => {
                    if state.library.cbz_cancelled.load(Ordering::SeqCst) {
                        state
                            .db
                            .with_writer(|conn| kopibon_core::db::conversion::release(conn, row_id))
                            .map_err(CommandError::Thrown)?;
                    } else {
                        *failed += 1;
                        errors.push(error.clone());
                        state
                            .db
                            .with_writer(|conn| {
                                kopibon_core::db::conversion::mark_failed(conn, row_id, &error)
                            })
                            .map_err(CommandError::Thrown)?;
                    }
                }
            }
            active.remove(&item_id);
            if let Ok(mut locks) = state.library.conversion_locks.lock() {
                locks.remove(&item_id);
            }
            send_progress(app, true, *converted, *failed, log_lines, active, queued);
        }
        Ok::<(), CommandError>(())
    };
    let run_result = run(
        state,
        app,
        &mut converted,
        &mut failed,
        &mut forced_keeps,
        &mut errors,
        &mut log_lines,
        &mut active,
        &mut queued,
    );
    queued.clear();
    active.clear();
    if let Ok(mut locks) = state.library.conversion_locks.lock() {
        locks.clear();
    }
    // The archive may have grown (`:3345-3348`).
    state.library.invalidate_originals_info();
    send_progress(
        app,
        false,
        converted,
        failed,
        &mut log_lines,
        &active,
        &queued,
    );
    run_result?;
    Ok(json!({
        "success": true,
        "data": {
            "converted": converted,
            "failed": failed,
            "total": batch_total,
            "skipped": skipped,
            "keptOriginals": keep_original,
            "forcedKeeps": forced_keeps,
            "cancelled": state.library.cbz_cancelled.load(Ordering::SeqCst),
            "errors": if errors.is_empty() { Value::Null } else {
                json!(errors.into_iter().take(20).collect::<Vec<_>>())
            },
        },
    }))
}

/// `library:cancelConvertToCbz` (`:3381-3387`).
pub(crate) fn cancel_cbz_conversion_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    state.library.cbz_cancelled.store(true, Ordering::SeqCst);
    Ok(json!({ "success": true }))
}

/// `library:getCbzConversionState` (`:3769-3780`).
pub(crate) fn cbz_conversion_state_impl(
    state: &AppState,
    _args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    // One set covers both in-flight and queued ids (`conversionLocks`
    // unification): running + active/queued all read off it.
    let ids: Vec<i64> = state
        .library
        .conversion_locks
        .lock()
        .map(|guard| guard.iter().cloned().collect())
        .unwrap_or_default();
    Ok(json!({
        "success": true,
        "data": {
            "running": !ids.is_empty(),
            "activeIds": ids,
            "queuedIds": Vec::<i64>::new(),
        },
    }))
}

// ─── Sync ──────────────────────────────────────────────────────────────

/// `getStoredApiKey` (`api-client.ts`): the decrypted key, empty when none.
fn stored_api_key(state: &AppState) -> String {
    crate::auth::stored_setting(&state.db, crate::auth::NHENTAI_KEY_SETTING)
        .map(|stored| crate::auth::decrypt_key(crate::auth::NHENTAI_KEY_ACCOUNT, &stored))
        .unwrap_or_default()
}

/// The per-item run (`spawnSyncWorker` minus the worker, `:2248-2458`):
/// guard-checked by the callers, `syncingItems` added/removed here, the
/// `:2312-2399` commit applied best-effort on success. Returns the worker's
/// `{ success, message }`.
fn run_one_sync(
    state: &AppState,
    item_id: i64,
    gallery_id: i64,
    abs_path: &str,
    format: &str,
    series_name: Option<&str>,
    series_index: Option<f64>,
) -> (bool, Option<String>) {
    if let Ok(mut syncing) = state.library.syncing_items.lock() {
        syncing.insert(item_id);
    }
    let api_key = stored_api_key(state);
    let transport = crate::auth::UreqTransport::new();
    let cmd = kopibon_core::sync::worker::SyncCommand {
        item_id,
        nhentai_id: gallery_id,
        file_path: abs_path,
        format,
        api_key: if api_key.is_empty() {
            None
        } else {
            Some(api_key.as_str())
        },
        series_name,
        series_index,
    };
    let clock = SystemClock;
    let mut sleep = |ms: i64| {
        if ms > 0 {
            std::thread::sleep(Duration::from_millis(ms as u64));
        }
    };
    // No jitter of our own: the batch paces between items, and the single
    // sync passes what the worker passed (none).
    let outcome = kopibon_core::sync::worker::sync_item(&transport, &cmd, &clock, 0, &mut sleep);
    let result = match &outcome {
        kopibon_core::sync::worker::SyncOutcome::Success {
            raw_tags,
            gallery,
            metadata,
        } => {
            commit_sync_success(state, item_id, format, metadata, raw_tags, gallery);
            (true, None)
        }
        kopibon_core::sync::worker::SyncOutcome::Error { message } => {
            (false, Some(message.clone()))
        }
    };
    if let Ok(mut syncing) = state.library.syncing_items.lock() {
        syncing.remove(&item_id);
    }
    result
}

/// The `:2312-2399` commit: recount (the sync repacks the archive),
/// custom-field overlay, gallery-row backfill. All best-effort.
fn commit_sync_success(
    state: &AppState,
    item_id: i64,
    format: &str,
    metadata: &kopibon_core::sync::worker::SyncFlatMetadata,
    raw_tags: &Value,
    gallery: &Value,
) {
    let stored = state
        .db
        .with_reader(|conn| kopibon_core::db::library_write::find_item_by_id(conn, item_id))
        .ok()
        .flatten()
        .and_then(|item| {
            item.get("filePath")
                .and_then(Value::as_str)
                .map(|s| s.to_string())
        });
    let root = library_root(&state.db);
    let mut fields: Vec<(String, FieldValue)> = Vec::new();
    if let Some(stored) = stored.as_deref() {
        let abs = kopibon_core::download::resolve_library_path(stored, &root);
        if let Some(pages) = kopibon_core::download::page_count::count_pages(&abs, Some(format)) {
            fields.push(("pageCount".to_string(), FieldValue::Int(pages)));
        }
    }
    fields.push((
        "customTitle".to_string(),
        FieldValue::Text(metadata.title.clone()),
    ));
    fields.push((
        "primaryArtist".to_string(),
        FieldValue::Text(metadata.primary_artist.clone()),
    ));
    fields.push((
        "customTags".to_string(),
        FieldValue::Text(metadata.tags.clone()),
    ));
    fields.push((
        "customLanguage".to_string(),
        FieldValue::from_json(
            &metadata
                .language
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        ),
    ));
    if let Some(publisher) = metadata.publisher.as_deref() {
        fields.push((
            "publisher".to_string(),
            FieldValue::Text(publisher.to_string()),
        ));
    }
    let _ = state.db.with_writer(|conn| {
        kopibon_core::db::library_write::update_item_fields(conn, item_id, &fields).map(|_| ())
    });

    // Gallery backfill (`:2347-2396`): only when the response carried typed
    // tags and the row exists — a synced row becomes as rich as a download.
    let has_tags = raw_tags.as_array().map(|a| !a.is_empty()).unwrap_or(false);
    if !has_tags {
        return;
    }
    let gallery_id = state
        .db
        .with_reader(|conn| kopibon_core::db::library_write::find_item_by_id(conn, item_id))
        .ok()
        .flatten()
        .and_then(|item| item.get("galleryId").and_then(Value::as_i64));
    let (Some(gallery_id), Some(existing)) = (
        gallery_id,
        state
            .db
            .with_reader(|conn| {
                kopibon_core::db::gallery::find_by_id(conn, gallery_id.unwrap_or(0))
            })
            .ok()
            .flatten(),
    ) else {
        return;
    };
    let _ = state.db.with_writer(|conn| {
        upsert_synced_gallery(conn, gallery_id, &existing, raw_tags, gallery).map(|_| ())
    });
}

/// Gallery upsert from a sync response (`:2356-2393`): every field the
/// response carried, `?? existing` (or `|| existing` for pretty/media)
/// otherwise — exactly what a download stores.
fn upsert_synced_gallery(
    conn: &mut rusqlite::Connection,
    gallery_id: i64,
    existing: &Value,
    raw_tags: &Value,
    gallery: &Value,
) -> Result<(), String> {
    let get = |key: &str| existing.get(key).cloned().unwrap_or(Value::Null);
    let title = gallery.get("title").cloned().unwrap_or(Value::Null);
    let media_id = gallery
        .get("media_id")
        .and_then(Value::as_i64)
        .or_else(|| {
            gallery
                .get("media_id")
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<i64>().ok())
        })
        .filter(|v| *v != 0)
        .unwrap_or_else(|| get("mediaId").as_i64().unwrap_or(0));
    let pretty = title
        .get("pretty")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| get("titlePretty").as_str().unwrap_or("").to_string());
    let english = title
        .get("english")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .unwrap_or_else(|| get("titleEnglish").as_str().unwrap_or("").to_string());
    let japanese = title
        .get("japanese")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .or_else(|| get("titleJapanese").as_str().map(|s| s.to_string()));
    let page_count = gallery
        .get("num_pages")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| get("pageCount").as_i64().unwrap_or(0));
    let favorites = gallery
        .get("num_favorites")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| get("favoritesCount").as_i64().unwrap_or(0));
    let upload_date = gallery
        .get("upload_date")
        .and_then(Value::as_i64)
        .or_else(|| get("uploadDate").as_i64());
    let thumb_path = gallery
        .get("thumbnail")
        .and_then(|t| t.get("path"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let cover_path = gallery
        .get("cover")
        .and_then(|c| c.get("path"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let thumbnail_url = if thumb_path.is_empty() {
        get("thumbnailUrl").as_str().unwrap_or("").to_string()
    } else {
        format!("https://t.nhentai.net/{thumb_path}")
    };
    let cover_url = if cover_path.is_empty() {
        get("coverUrl").as_str().unwrap_or("").to_string()
    } else {
        format!("https://t.nhentai.net/{cover_path}")
    };
    let raw_tags_json = raw_tags.to_string();
    let raw_json = gallery.to_string();
    kopibon_core::db::gallery::upsert(
        conn,
        &kopibon_core::db::gallery::GalleryUpsert {
            id: gallery_id,
            media_id,
            title_pretty: &pretty,
            title_english: &english,
            title_japanese: japanese.as_deref(),
            page_count,
            favorites_count: favorites,
            upload_date,
            thumbnail_url: if thumbnail_url.is_empty() {
                None
            } else {
                Some(thumbnail_url.as_str())
            },
            cover_url: if cover_url.is_empty() {
                None
            } else {
                Some(cover_url.as_str())
            },
            raw_tags_json: &raw_tags_json,
            raw_json: &raw_json,
        },
        SystemClock.now_ms() / 1000,
    )
}

/// `library:syncItem` (`:2460-2494`).
pub(crate) fn sync_item_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let item_id = opt_i64(args, 0).unwrap_or(0);
    if state.library.is_conversion_locked(item_id) {
        return Ok(crate::library::conversion_lock_error());
    }
    let already = state
        .library
        .syncing_items
        .lock()
        .map(|guard| guard.contains(&item_id))
        .unwrap_or(false);
    if already {
        return Ok(json!({ "success": false, "error": "Already syncing" }));
    }
    let item = state
        .db
        .with_reader(|conn| kopibon_core::db::library_write::find_item_by_id(conn, item_id))
        .map_err(CommandError::Thrown)?;
    let gallery_id = item
        .as_ref()
        .and_then(|row| row.get("galleryId"))
        .and_then(Value::as_i64);
    let (Some(item), Some(gallery_id)) = (item, gallery_id) else {
        return Ok(json!({ "success": false, "error": "No nhentai ID" }));
    };
    let root = library_root(&state.db);
    let abs = kopibon_core::download::resolve_library_path(
        item.get("filePath").and_then(Value::as_str).unwrap_or(""),
        &root,
    );
    let format = item
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or("pdf")
        .to_string();
    let series_name = item
        .get("seriesName")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    let series_index = item.get("seriesIndex").and_then(Value::as_f64);
    let (success, message) = run_one_sync(
        state,
        item_id,
        gallery_id,
        &abs.to_string_lossy(),
        &format,
        series_name.as_deref(),
        series_index,
    );
    if success {
        Ok(json!({ "success": true, "data": { "synced": true } }))
    } else {
        Ok(
            json!({ "success": false, "error": message.unwrap_or_else(|| "Sync failed".to_string()) }),
        )
    }
}

/// `library:cancelSync` (`:2522-2526`).
pub(crate) fn cancel_sync_impl(
    state: &AppState,
    args: &[Value],
    log: &mut LogSink,
) -> Result<Value, CommandError> {
    let _ = args;
    state.library.sync_cancelled.store(true, Ordering::SeqCst);
    log(LogRecord {
        level: "info",
        scope: "library".to_string(),
        message: "sync cancellation requested".to_string(),
        fields: json!({}),
    });
    Ok(json!({ "success": true }))
}

/// `library:syncBatch` (`:2528-2696`): the queue is the work list; pacing
/// from the documented gallery-endpoint limit (90 %, `:2564-2580`);
/// per-item guards finish the row without a progress event (`:2603-2613`);
/// the sleep covers only the interval remainder (`:2650-2659`).
pub(crate) fn sync_batch_impl(
    state: &AppState,
    args: &[Value],
    log: &mut LogSink,
    app: &tauri::AppHandle,
) -> Result<Value, CommandError> {
    let ids: Vec<i64> = args
        .first()
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default();
    let mut succeeded = 0i64;
    let mut failed = 0i64;
    let mut cancelled = false;
    let started_at = std::time::Instant::now();
    state.library.sync_cancelled.store(false, Ordering::SeqCst);

    if !ids.is_empty() {
        state
            .db
            .with_writer(|conn| {
                kopibon_core::db::sync::clear_finished_rows(conn).map(|_| ())?;
                for id in &ids {
                    kopibon_core::db::sync::enqueue(conn, *id)?;
                }
                Ok::<(), String>(())
            })
            .map_err(CommandError::Thrown)?;
    }
    let outstanding = state
        .db
        .with_reader(kopibon_core::db::sync::counts)
        .map_err(CommandError::Thrown)?;
    let total = outstanding
        .get("pending")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        + outstanding
            .get("syncing")
            .and_then(Value::as_i64)
            .unwrap_or(0);
    if total == 0 {
        return Ok(json!({
            "success": true,
            "data": { "succeeded": 0, "failed": 0, "total": 0, "cancelled": false },
        }));
    }
    let mut done = 0i64;

    let limit = kopibon_core::nhentai::limiter::endpoint_limit_per_minute(
        kopibon_core::nhentai::limiter::EndpointKey::Gallery,
        !stored_api_key(state).is_empty(),
    );
    let target = (limit * 0.9).floor().max(1.0) as i64;
    let interval_ms = (60_000 + target - 1) / target;
    log(LogRecord {
        level: "info",
        scope: "library".to_string(),
        message: "sync batch pacing".to_string(),
        fields: json!({ "items": total, "limit": limit, "target": target, "intervalMs": interval_ms }),
    });

    let _ = app.emit(
        "library:syncProgress",
        json!({ "current": 0, "total": total, "title": "Starting...", "etaSeconds": Value::Null }),
    );

    loop {
        if state.library.sync_cancelled.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        let claim: Option<(i64, i64)> = state
            .db
            .with_writer(kopibon_core::db::sync::claim_next)
            .map_err(CommandError::Thrown)?;
        let Some((_row_id, item_id)) = claim else {
            break;
        };
        let started_item_at = std::time::Instant::now();
        let item = state
            .db
            .with_reader(|conn| kopibon_core::db::library_write::find_item_by_id(conn, item_id))
            .map_err(CommandError::Thrown)?;
        let gallery_id = item
            .as_ref()
            .and_then(|row| row.get("galleryId"))
            .and_then(Value::as_i64);
        let in_flight = state
            .library
            .syncing_items
            .lock()
            .map(|guard| guard.contains(&item_id))
            .unwrap_or(false);
        if item.is_none()
            || gallery_id.is_none()
            || in_flight
            || state.library.is_conversion_locked(item_id)
        {
            let _ = state.db.with_writer(|conn| {
                kopibon_core::db::sync::finish_by_item(
                    conn,
                    item_id,
                    Some("No nhentai id, or the file is in use"),
                )
                .map(|_| ())
            });
            failed += 1;
            done += 1;
            continue;
        }
        let item = item.expect("guarded above");
        let gallery_id = gallery_id.expect("guarded above");
        let root = library_root(&state.db);
        let abs = kopibon_core::download::resolve_library_path(
            item.get("filePath").and_then(Value::as_str).unwrap_or(""),
            &root,
        );
        let format = item
            .get("format")
            .and_then(Value::as_str)
            .unwrap_or("pdf")
            .to_string();
        let series_name = item
            .get("seriesName")
            .and_then(Value::as_str)
            .map(|s| s.to_string());
        let series_index = item.get("seriesIndex").and_then(Value::as_f64);
        let (success, message) = run_one_sync(
            state,
            item_id,
            gallery_id,
            &abs.to_string_lossy(),
            &format,
            series_name.as_deref(),
            series_index,
        );
        let _ = state.db.with_writer(|conn| {
            kopibon_core::db::sync::finish_by_item(
                conn,
                item_id,
                if success { None } else { message.as_deref() },
            )
            .map(|_| ())
        });
        if success {
            succeeded += 1;
        } else {
            failed += 1;
        }
        done += 1;

        let elapsed = started_at.elapsed().as_secs_f64();
        let rate = done as f64 / elapsed.max(1.0);
        let eta = if rate > 0.0 {
            Value::from(((total - done) as f64 / rate).round() as i64)
        } else {
            Value::Null
        };
        let _ = app.emit(
            "library:syncProgress",
            json!({
                "current": done,
                "total": total,
                "title": format!("Syncing #{gallery_id}"),
                "etaSeconds": eta,
            }),
        );

        if done < total && !state.library.sync_cancelled.load(Ordering::SeqCst) {
            let remaining = interval_ms - started_item_at.elapsed().as_millis() as i64;
            if remaining > 0 {
                std::thread::sleep(Duration::from_millis(remaining as u64));
            }
        }
    }

    let _ = app.emit(
        "library:syncComplete",
        json!({ "succeeded": succeeded, "failed": failed, "total": total, "cancelled": cancelled }),
    );
    {
        use tauri_plugin_notification::NotificationExt;
        let body = if cancelled {
            format!(
                "Stopped after {} of {total} — {succeeded} succeeded, {failed} failed",
                succeeded + failed
            )
        } else {
            format!("{succeeded} succeeded, {failed} failed ({total} total)")
        };
        let _ = app
            .notification()
            .builder()
            .title(if cancelled {
                "Nhentai Sync Cancelled"
            } else {
                "Nhentai Sync Complete"
            })
            .body(body)
            .show();
    }
    // The reported total is the requested batch (`:2687-2694`) — a resume
    // (`ids` empty) reports 0 even when it just synced the backlog.
    Ok(json!({
        "success": true,
        "data": { "succeeded": succeeded, "failed": failed, "total": ids.len() as i64 },
    }))
}

/// `library:isSyncing` (`:2698-2706`).
pub(crate) fn is_syncing_impl(
    state: &AppState,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let item_id = opt_i64(args, 0).unwrap_or(0);
    let syncing = state
        .library
        .syncing_items
        .lock()
        .map(|guard| guard.contains(&item_id))
        .unwrap_or(false);
    Ok(json!({ "success": true, "data": syncing }))
}

// ─── Wrappers ──────────────────────────────────────────────────────────

macro_rules! lib_job {
    ($name:ident, $channel:literal, $impl_fn:ident) => {
        #[tauri::command(rename = $channel)]
        pub(crate) fn $name(state: State<'_, AppState>, args: Vec<Value>) -> Value {
            let outcome = handle($channel, |log| $impl_fn(&state, &args, log));
            super::forward(&state, $channel, outcome.logs);
            outcome.value
        }
    };
    ($name:ident, $channel:literal, $impl_fn:ident, app) => {
        #[tauri::command(rename = $channel)]
        pub(crate) fn $name(
            state: State<'_, AppState>,
            app: tauri::AppHandle,
            args: Vec<Value>,
        ) -> Value {
            let outcome = handle($channel, |log| $impl_fn(&state, &args, log, &app));
            super::forward(&state, $channel, outcome.logs);
            outcome.value
        }
    };
}

lib_job!(library_scan, "library:scan", scan_impl, app);
lib_job!(library_pause_scan, "library:pauseScan", pause_scan_impl);
lib_job!(library_resume_scan, "library:resumeScan", resume_scan_impl);
lib_job!(library_cancel_scan, "library:cancelScan", cancel_scan_impl);
lib_job!(
    library_convert_all_metadata,
    "library:convertAllMetadata",
    convert_all_metadata_impl,
    app
);
lib_job!(
    library_cancel_conversion,
    "library:cancelConversion",
    cancel_conversion_impl
);
lib_job!(
    library_convert_to_cbz,
    "library:convertToCbz",
    convert_to_cbz_impl,
    app
);
lib_job!(
    library_cancel_cbz_conversion,
    "library:cancelConvertToCbz",
    cancel_cbz_conversion_impl
);
lib_job!(
    library_cbz_conversion_state,
    "library:getCbzConversionState",
    cbz_conversion_state_impl
);
lib_job!(library_sync_item, "library:syncItem", sync_item_impl);
lib_job!(library_cancel_sync, "library:cancelSync", cancel_sync_impl);
lib_job!(
    library_sync_batch,
    "library:syncBatch",
    sync_batch_impl,
    app
);
lib_job!(library_is_syncing, "library:isSyncing", is_syncing_impl);
