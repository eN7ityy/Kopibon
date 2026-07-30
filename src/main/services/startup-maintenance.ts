/**
 * Startup maintenance.
 *
 * Sweeps transient bookkeeping tables that have no meaning across an app
 * restart. Runs once at boot, before the download queue is reconciled.
 *
 * What is safe to clear, and why:
 *
 * - `download_page` — per-attempt page bookkeeping. Recreated from scratch on
 *   every download attempt and deleted on completion; nothing in the renderer
 *   reads it. Nothing is in flight at startup, so any surviving row is debris
 *   from a hard kill.
 *
 * - `scan_queue` — intra-scan progress only. Rebuilt from a fresh directory
 *   walk at the start of every scan via INSERT OR IGNORE, and the incremental
 *   skip logic keys off library_item (mtime + size), not this table. Clearing
 *   also fixes rows stuck in 'failed', which the pending/scanning select
 *   otherwise skips forever.
 *
 * What is NOT cleared: `download_queue` rows in queued / paused / failed.
 * Those are user intent and failure history, surfaced in the Downloads page.
 * Only 'completed' rows are pruned — the UI never queries that status.
 * Interrupted ('downloading' / 'converting') rows are handled separately by
 * DownloadManager.reconcileInterrupted().
 */

import { getRawDatabase } from '../db/connection'

export interface MaintenanceResult {
  downloadPagesCleared: number
  scanQueueCleared: number
  completedDownloadsPruned: number
  orphanedArtistsRemoved: number
}

export interface MaintenanceOptions {
  /**
   * Keep completed download history newer than this many days.
   * 0 (default) prunes all completed rows.
   */
  completedRetentionDays?: number
}

export function runStartupMaintenance(options: MaintenanceOptions = {}): MaintenanceResult {
  const retentionDays = Math.max(0, options.completedRetentionDays ?? 0)
  const db = getRawDatabase()

  const result: MaintenanceResult = {
    downloadPagesCleared: 0,
    scanQueueCleared: 0,
    completedDownloadsPruned: 0,
    orphanedArtistsRemoved: 0
  }

  const sweep = db.transaction(() => {
    result.downloadPagesCleared = db.prepare('DELETE FROM download_page').run().changes

    result.scanQueueCleared = db.prepare('DELETE FROM scan_queue').run().changes

    if (retentionDays === 0) {
      result.completedDownloadsPruned = db
        .prepare("DELETE FROM download_queue WHERE status = 'completed'")
        .run().changes
    } else {
      const cutoff = Date.now() - retentionDays * 86_400_000
      result.completedDownloadsPruned = db
        .prepare(
          `DELETE FROM download_queue
           WHERE status = 'completed'
             AND (completed_at IS NULL OR completed_at < ?)`
        )
        .run(cutoff).changes
    }

    // Nothing declares a foreign key, so historical deletes left artist rows
    // behind. Deletion paths now clean up after themselves; this sweeps what
    // earlier versions already leaked.
    result.orphanedArtistsRemoved = db
      .prepare(
        `DELETE FROM library_item_artist
         WHERE library_item_id NOT IN (SELECT id FROM library_item)`
      )
      .run().changes
  })

  try {
    sweep()
  } catch (err) {
    // Maintenance is best-effort — never block startup over it.
    console.error('[startup] maintenance failed:', err)
    return result
  }

  const total =
    result.downloadPagesCleared +
    result.scanQueueCleared +
    result.completedDownloadsPruned +
    result.orphanedArtistsRemoved
  if (total > 0) {
    console.log(
      `[startup] maintenance: cleared ${result.downloadPagesCleared} page row(s), ` +
        `${result.scanQueueCleared} scan queue row(s), ` +
        `pruned ${result.completedDownloadsPruned} completed download(s), ` +
        `removed ${result.orphanedArtistsRemoved} orphaned artist row(s)`
    )
  }

  return result
}
