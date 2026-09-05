//! The library scanner port (library-scanner.worker.ts) — Phase A headless.
//!
//! **Single-threaded per scan is a documented invariant** (plan §3): the work
//! query order, the pause gate, the batch flush and the removal guard all
//! assume one consumer. `run_scan` is the whole worker loop, synchronous;
//! pause/cancel arrive through [`ScanControl`] and are honoured only at item
//! boundaries (:921-937), never mid-file. The scanner owns one connection for
//! its lifetime (§9) and never holds a write txn across a pause.
//!
//! Events mirror the worker protocol (:32-51); the `newItems` batch flushes
//! at 25 items or 500 ms, whichever first, with a final flush after the loop
//! (:907-917, :970).

pub mod extract;
pub mod process;
pub mod queue;
pub mod removal;
pub mod thumbnail;
pub mod walk;

use rusqlite::Connection;

use crate::metadata::mappers::Clock;

const BATCH_SIZE: usize = 25;
const BATCH_INTERVAL_MS: i64 = 500;

/// `idle | scanning | paused | cancelled` (:79).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanState {
    Idle,
    Scanning,
    Paused,
    Cancelled,
}

/// Control surface: the loop polls the state at item boundaries and parks
/// here while paused.
pub trait ScanControl: Send + Sync {
    fn state(&self) -> ScanState;
    /// Block until the state changes from Paused (the worker's pause gate).
    fn wait_while_paused(&self);
}

/// A control that never pauses or cancels (Phase A batch runs).
pub struct NoControl;
impl ScanControl for NoControl {
    fn state(&self) -> ScanState {
        ScanState::Scanning
    }
    fn wait_while_paused(&self) {}
}

/// Atomic-backed control for tests and the future IPC layer.
pub struct AtomicControl {
    state: std::sync::Arc<std::sync::atomic::AtomicU8>,
    /// Notified on resume/cancel so a parked waiter re-checks.
    notify: std::sync::Arc<std::sync::Condvar>,
    guard: std::sync::Arc<std::sync::Mutex<()>>,
}

impl AtomicControl {
    pub fn new() -> Self {
        Self {
            state: std::sync::Arc::new(std::sync::atomic::AtomicU8::new(
                ScanState::Scanning as u8,
            )),
            notify: std::sync::Arc::new(std::sync::Condvar::new()),
            guard: std::sync::Arc::new(std::sync::Mutex::new(())),
        }
    }

    pub fn set(&self, state: ScanState) {
        self.state.store(state as u8, std::sync::atomic::Ordering::SeqCst);
        self.notify.notify_all();
    }
}

impl Default for AtomicControl {
    fn default() -> Self {
        Self::new()
    }
}

impl ScanControl for AtomicControl {
    fn state(&self) -> ScanState {
        match self.state.load(std::sync::atomic::Ordering::SeqCst) {
            0 => ScanState::Idle,
            1 => ScanState::Scanning,
            2 => ScanState::Paused,
            _ => ScanState::Cancelled,
        }
    }

    fn wait_while_paused(&self) {
        let mut guard = self.guard.lock().expect("lock");
        while self.state() == ScanState::Paused {
            guard = self.notify.wait(guard).expect("wait");
        }
    }
}

/// Worker events (:32-51), consumed by the future IPC layer.
#[derive(Debug, Clone)]
pub enum ScanEvent {
    Progress {
        current: usize,
        total: usize,
        status: String,
    },
    NewItems {
        items: Vec<NewItem>,
    },
    Paused,
    Cancelled,
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewItem {
    pub id: i64,
    pub title: String,
    pub artist: String,
}

/// Terminal result (:37-47).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScanResult {
    pub total: usize,
    pub new_items: usize,
    pub removed_items: usize,
    pub errors: Vec<String>,
    pub cancelled: bool,
    pub removal_skipped_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ScanOutcome {
    New { id: i64, title: String, artist: String },
    Skipped,
}

pub struct ScanOptions<'a> {
    pub library_root: &'a std::path::Path,
    pub thumbnail_dir: &'a std::path::Path,
}

/// runScan (:865-1057) + the worker's finally-cleanup (:1080-1085).
/// Returns the terminal result; `None` when the scan was cancelled (no
/// complete event, no scan log — but the completed-queue cleanup still runs).
pub fn run_scan(
    conn: &mut Connection,
    options: &ScanOptions<'_>,
    clock: &dyn Clock,
    control: &dyn ScanControl,
    emit: &mut dyn FnMut(ScanEvent),
) -> Result<Option<ScanResult>, String> {
    let root = options.library_root.to_path_buf();

    // Phase 1: discover (:868-886).
    emit(ScanEvent::Progress {
        current: 0,
        total: 0,
        status: "Scanning library directory...".to_string(),
    });

    if !root.exists() {
        // A missing root aborts before any queue work (:872-875).
        emit(ScanEvent::Error {
            message: format!("Library root does not exist: {}", root.to_string_lossy()),
        });
        return Ok(None);
    }

    let walk_result = walk::walk_library_files(&root);
    let mut discovered = walk_result.files;
    // Sort newest-mtime-first so recent downloads scan first (:880-882).
    // Stable sort; stat failures compare as 0 (catch → 0).
    let mtimes: Vec<i64> = discovered
        .iter()
        .map(|p| {
            std::fs::metadata(p)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        })
        .collect();
    let mut order: Vec<usize> = (0..discovered.len()).collect();
    order.sort_by(|&a, &b| mtimes[b].cmp(&mtimes[a]));
    let reordered: Vec<std::path::PathBuf> =
        order.into_iter().map(|i| discovered[i].clone()).collect();
    discovered = reordered;

    // Phase 2: populate + requeue (:889-891).
    queue::populate_queue(conn, &root, &discovered)?;
    queue::requeue_incomplete_items(conn)?;

    // Phase 3: work list (:894-896).
    let queue_items = queue::pending_items(conn)?;
    let total = queue_items.len();
    let mut processed = 0usize;
    let mut new_items = 0usize;
    let mut skipped_items = 0usize;
    let mut errors: Vec<String> = Vec::new();

    emit(ScanEvent::Progress {
        current: 0,
        total,
        status: format!("Starting scan of {total} items..."),
    });

    // Phase 4: process with batched newItems (:907-967).
    let mut new_item_batch: Vec<NewItem> = Vec::new();
    let mut last_batch_flush = clock.now_ms();

    let flush_new_item_batch = |batch: &mut Vec<NewItem>,
                                    last: &mut i64,
                                    emit: &mut dyn FnMut(ScanEvent)| {
        if batch.is_empty() {
            return;
        }
        emit(ScanEvent::NewItems {
            items: std::mem::take(batch),
        });
        *last = clock.now_ms();
    };

    let mut cancelled = false;
    for item in &queue_items {
        // Pause/cancel at the item boundary only (:921-937).
        if control.state() == ScanState::Cancelled {
            emit(ScanEvent::Cancelled);
            cancelled = true;
            break;
        }
        if control.state() == ScanState::Paused {
            emit(ScanEvent::Paused);
            control.wait_while_paused();
            // Cancelled while paused → fall through to the loop top, which
            // sees it and exits (:933).
            if control.state() == ScanState::Cancelled {
                continue;
            }
            emit(ScanEvent::Progress {
                current: processed,
                total,
                status: "Resuming scan...".to_string(),
            });
        }

        queue::claim(conn, item)?;
        let mut ctx = process::ProcessContext {
            conn,
            root: &root,
            thumbnail_dir: options.thumbnail_dir,
            clock,
        };
        match process::process_file(&mut ctx, item) {
            Ok(ScanOutcome::New { id, title, artist }) => {
                new_items += 1;
                new_item_batch.push(NewItem { id, title, artist });
                if new_item_batch.len() >= BATCH_SIZE
                    || clock.now_ms() - last_batch_flush >= BATCH_INTERVAL_MS
                {
                    flush_new_item_batch(&mut new_item_batch, &mut last_batch_flush, emit);
                }
            }
            Ok(ScanOutcome::Skipped) => {
                skipped_items += 1;
            }
            Err(err) => {
                errors.push(format!("{item}: scan error"));
                let _ = err; // the message went to the queue row; 1.x logs it
            }
        }

        processed += 1;

        emit(ScanEvent::Progress {
            current: processed,
            total,
            status: format!("Scanned {processed}/{total} ({new_items} new, {skipped_items} skipped)"),
        });
    }

    if cancelled {
        // The TS worker returns early — no removal, no scan log — and the
        // finally block still cleans completed rows (:1080-1085).
        queue::cleanup_completed(conn)?;
        return Ok(None);
    }

    // Flush remaining new items (:970).
    flush_new_item_batch(&mut new_item_batch, &mut last_batch_flush, emit);

    // Phase 5: removal decision (:972-1044).
    let discovered_absolute: Vec<String> = discovered
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    let decision =
        removal::decide_removal(conn, &root, &walk_result.failed_dirs, &discovered_absolute)?;
    let removal_skipped_reason = decision.skipped_reason.clone();
    if let Some(reason) = &removal_skipped_reason {
        errors.push(reason.clone());
    }
    let removed_items = removal::remove_rows(conn, &decision.gone)?;

    // Phase 6: scan log (:1047-1048).
    conn.execute(
        "INSERT INTO library_scan_log (scanned_at, total_items, new_items, removed_items, errors_json)
         VALUES (?, ?, ?, ?, ?)",
        rusqlite::params![
            clock.now_ms(),
            total as i64,
            new_items as i64,
            removed_items as i64,
            serde_json::to_string(&errors).unwrap_or_else(|_| "[]".to_string())
        ],
    )
    .map_err(|e| e.to_string())?;

    let result = ScanResult {
        total,
        new_items,
        removed_items,
        errors,
        cancelled: false,
        removal_skipped_reason,
    };

    queue::cleanup_completed(conn)?;
    Ok(Some(result))
}
