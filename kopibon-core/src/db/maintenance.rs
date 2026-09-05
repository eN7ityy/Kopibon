//! Port of `src/main/services/startup-maintenance.ts:52-164` — sweeps
//! transient bookkeeping tables that have no meaning across an app restart.
//! Order is normative (03-data-model §10.7): inside one transaction wipe
//! `download_page` + `scan_queue`, reset `conversion_queue` 'converting' →
//! 'pending' (the table is deliberately NOT wiped — resumability is the
//! point), prune completed downloads (retention-aware), sweep orphaned
//! artist rows; outside the transaction `requeueInterrupted()` syncs, then
//! the series relink when `seriesGrouping === 'true'`. All best-effort:
//! never block startup (:104-112).

use rusqlite::Connection;

use super::series;
use super::settings;
use super::sync;
use crate::metadata::mappers::Clock;

#[derive(Debug, Default, PartialEq, Clone, Copy)]
pub struct MaintenanceResult {
    pub download_pages_cleared: i64,
    pub scan_queue_cleared: i64,
    pub completed_downloads_pruned: i64,
    pub orphaned_artists_removed: i64,
    /// Items linked to their series group. 0 when grouping is switched off.
    pub series_linked: i64,
    /// Sync rows left mid-flight by a crash or quit, put back in the queue.
    pub sync_requeued: i64,
}

impl MaintenanceResult {
    pub fn total(&self) -> i64 {
        self.download_pages_cleared
            + self.scan_queue_cleared
            + self.completed_downloads_pruned
            + self.orphaned_artists_removed
            + self.series_linked
            + self.sync_requeued
    }
}

/// `runStartupMaintenance(options)`. `retention_days` is
/// `completedRetentionDays` (0 prunes all completed rows). `now_ms` comes
/// from the injected clock — 1.x used `Date.now()` for the retention cutoff.
pub fn run_startup_maintenance(
    conn: &mut Connection,
    clock: &dyn Clock,
    retention_days: u32,
) -> MaintenanceResult {
    let retention_days = retention_days as i64;
    let mut result = MaintenanceResult::default();

    let sweep = |tx: &rusqlite::Transaction<'_>, result: &mut MaintenanceResult| -> Result<(), String> {
        result.download_pages_cleared = tx
            .execute("DELETE FROM download_page", [])
            .map_err(|e| e.to_string())? as i64;

        result.scan_queue_cleared = tx
            .execute("DELETE FROM scan_queue", [])
            .map_err(|e| e.to_string())? as i64;

        // Reset stale conversion_queue rows so the crash-restarted conversion
        // pool can pick them up; do NOT wipe the table (:70-76).
        tx.execute(
            "UPDATE conversion_queue SET status = 'pending' WHERE status = 'converting'",
            [],
        )
        .map_err(|e| e.to_string())?;

        if retention_days == 0 {
            result.completed_downloads_pruned = tx
                .execute("DELETE FROM download_queue WHERE status = 'completed'", [])
                .map_err(|e| e.to_string())? as i64;
        } else {
            let cutoff = clock.now_ms() - retention_days * 86_400_000;
            result.completed_downloads_pruned = tx
                .execute(
                    "DELETE FROM download_queue
                     WHERE status = 'completed'
                       AND (completed_at IS NULL OR completed_at < ?)",
                    [cutoff],
                )
                .map_err(|e| e.to_string())? as i64;
        }

        // Nothing declares a foreign key — this sweeps what historical
        // deletes leaked (:93-101).
        result.orphaned_artists_removed = tx
            .execute(
                "DELETE FROM library_item_artist
                 WHERE library_item_id NOT IN (SELECT id FROM library_item)",
                [],
            )
            .map_err(|e| e.to_string())? as i64;
        Ok(())
    };

    let tx = match conn.transaction() {
        Ok(tx) => tx,
        Err(e) => {
            eprintln!("Maintenance sweep failed: {e}");
            return result;
        }
    };
    if let Err(e) = sweep(&tx, &mut result) {
        // Best-effort — never block startup over it (:104-112). Counters stay
        // at their pre-rollback state, which is zero for this transaction.
        eprintln!("Maintenance sweep failed: {e}");
        return MaintenanceResult::default();
    }
    if let Err(e) = tx.commit() {
        eprintln!("Maintenance sweep failed: {e}");
        return MaintenanceResult::default();
    }

    // A sync row still marked 'syncing' means the app went away mid-item
    // (:127-135). Best-effort like the rest.
    match sync::requeue_interrupted(conn) {
        Ok(n) => result.sync_requeued = n as i64,
        Err(e) => eprintln!("Sync requeue failed: {e}"),
    }

    // Series relink backstop, outside the sweep transaction (:114-143).
    match settings::get(conn, "seriesGrouping") {
        Ok(Some(value)) if settings::series_grouping(Some(&value)) => {
            match series::backfill_all(conn, clock.now_ms() / 1000) {
                Ok(r) => result.series_linked = r.linked,
                Err(e) => eprintln!("Series regroup failed: {e}"),
            }
        }
        Ok(_) => {}
        Err(e) => eprintln!("Series regroup failed: {e}"),
    }

    result
}
