import { getSqlite } from '../connection'

/**
 * nhentai metadata sync queue.
 *
 * The queue is the source of truth for what still needs syncing, not an
 * in-memory array. A batch is paced against the API's rate limit — roughly 40
 * items a minute — so syncing a few hundred galleries runs for long enough that
 * quitting or crashing part-way through is expected rather than exceptional.
 * The previous implementation held the work list in a local variable, so an
 * interrupted run simply lost its place.
 *
 * Modelled on `conversion_queue`, down to `claimNext` using
 * `UPDATE ... RETURNING` so a row is handed to exactly one runner.
 */

export interface SyncQueueCounts {
  pending: number
  syncing: number
  completed: number
  failed: number
}

export const syncRepo = {
  /**
   * Add items as pending, resetting any earlier row for the same item.
   *
   * `library_item_id` is unique, so re-syncing something that previously failed
   * has to reset the existing row rather than fail the insert.
   */
  enqueue(libraryItemIds: readonly number[]): number {
    const sqlite = getSqlite()
    const stmt = sqlite.prepare(`
      INSERT INTO sync_queue
        (library_item_id, status, error_message, started_at, completed_at)
      VALUES (?, 'pending', NULL, NULL, NULL)
      ON CONFLICT(library_item_id) DO UPDATE SET
        status        = 'pending',
        error_message = NULL,
        started_at    = NULL,
        completed_at  = NULL
    `)
    const run = sqlite.transaction(() => {
      for (const id of libraryItemIds) stmt.run(id)
    })
    run()
    return libraryItemIds.length
  },

  /**
   * Take the next pending item and mark it in flight.
   *
   * A single statement so two runners cannot claim the same row, matching how
   * the conversion queue does it.
   */
  claimNext(): number | null {
    const row = getSqlite()
      .prepare(
        `UPDATE sync_queue
            SET status = 'syncing', started_at = ?
          WHERE id = (SELECT id FROM sync_queue WHERE status = 'pending' ORDER BY id LIMIT 1)
      RETURNING library_item_id`
      )
      .get(Date.now()) as { library_item_id: number } | undefined
    return row?.library_item_id ?? null
  },

  finish(libraryItemId: number, error: string | null): void {
    getSqlite()
      .prepare(
        `UPDATE sync_queue
            SET status = ?, error_message = ?, completed_at = ?
          WHERE library_item_id = ?`
      )
      .run(error ? 'failed' : 'completed', error, Date.now(), libraryItemId)
  },

  counts(): SyncQueueCounts {
    const rows = getSqlite()
      .prepare('SELECT status, COUNT(*) AS n FROM sync_queue GROUP BY status')
      .all() as Array<{ status: string; n: number }>
    const counts: SyncQueueCounts = { pending: 0, syncing: 0, completed: 0, failed: 0 }
    for (const row of rows) {
      if (row.status in counts) counts[row.status as keyof SyncQueueCounts] = row.n
    }
    return counts
  },

  /** The first few failures, for the resume banner. */
  recentErrors(limit = 5): string[] {
    const rows = getSqlite()
      .prepare(
        `SELECT error_message FROM sync_queue
          WHERE status = 'failed' AND error_message IS NOT NULL
          ORDER BY completed_at DESC LIMIT ?`
      )
      .all(limit) as Array<{ error_message: string }>
    return rows.map((r) => r.error_message)
  },

  /**
   * Put anything left mid-flight back in the queue.
   *
   * Called at startup: a row still marked 'syncing' means the app went away
   * while it was in progress, and nothing is running now.
   */
  requeueInterrupted(): number {
    const result = getSqlite()
      .prepare(
        "UPDATE sync_queue SET status = 'pending', started_at = NULL WHERE status = 'syncing'"
      )
      .run()
    return Number(result.changes ?? 0)
  },

  /** Drop finished rows, keeping whatever is still outstanding. */
  clearFinished(): number {
    const result = getSqlite()
      .prepare("DELETE FROM sync_queue WHERE status IN ('completed', 'failed')")
      .run()
    return Number(result.changes ?? 0)
  },

  /** Forget the whole queue, including anything still pending. */
  clear(): number {
    const result = getSqlite().prepare('DELETE FROM sync_queue').run()
    return Number(result.changes ?? 0)
  }
}
