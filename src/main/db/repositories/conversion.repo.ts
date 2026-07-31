import { getSqlite } from '../connection'

/**
 * PDF → CBZ conversion queue.
 *
 * The queue is the source of truth for what still needs converting, not an
 * in-memory array. Converting a full library is a multi-hour, disk-heavy job, and
 * the previous implementation held the work list in a local variable: quitting or
 * crashing part-way lost the position entirely, so the table existed and was
 * reset on boot but nothing ever wrote to it.
 *
 * Raw better-sqlite3 rather than Drizzle because `claimNext` needs
 * `UPDATE ... RETURNING` to hand a row to exactly one runner.
 */

export interface ConversionRow {
  id: number
  libraryItemId: number
  filePath: string
  keepOriginal: boolean
}

export interface ConversionCounts {
  pending: number
  converting: number
  completed: number
  failed: number
}

export const conversionRepo = {
  /**
   * Add items as pending, replacing any earlier row for the same path.
   *
   * `file_path` is UNIQUE, so re-converting something that previously failed (or
   * succeeded and was converted back) has to reset the existing row rather than
   * fail the insert.
   *
   * @returns how many rows are now pending for this batch
   */
  enqueue(items: Array<{ libraryItemId: number; filePath: string; keepOriginal: boolean }>): number {
    const sqlite = getSqlite()
    const stmt = sqlite.prepare(`
      INSERT INTO conversion_queue
        (file_path, library_item_id, keep_original, status, error_message, started_at, completed_at)
      VALUES (?, ?, ?, 'pending', NULL, NULL, NULL)
      ON CONFLICT(file_path) DO UPDATE SET
        library_item_id = excluded.library_item_id,
        keep_original   = excluded.keep_original,
        status          = 'pending',
        error_message   = NULL,
        started_at      = NULL,
        completed_at    = NULL
    `)
    const run = sqlite.transaction(() => {
      for (const it of items) {
        stmt.run(it.filePath, it.libraryItemId, it.keepOriginal ? 1 : 0)
      }
    })
    run()
    return items.length
  },

  /**
   * Hand the next pending row to a runner, marking it `converting`.
   *
   * A single statement so concurrent runners cannot claim the same item: the
   * subquery picks one id and the UPDATE only matches while it is still pending.
   */
  claimNext(): ConversionRow | null {
    const sqlite = getSqlite()
    const row = sqlite
      .prepare(
        `UPDATE conversion_queue
            SET status = 'converting', started_at = unixepoch()
          WHERE id = (
            SELECT id FROM conversion_queue
             WHERE status = 'pending'
             ORDER BY priority DESC, id ASC
             LIMIT 1
          )
            AND status = 'pending'
      RETURNING id, library_item_id AS libraryItemId, file_path AS filePath, keep_original AS keepOriginal`
      )
      .get() as (Omit<ConversionRow, 'keepOriginal'> & { keepOriginal: number }) | undefined

    if (!row) return null
    return { ...row, keepOriginal: row.keepOriginal !== 0 }
  },

  markCompleted(id: number): void {
    getSqlite()
      .prepare(
        "UPDATE conversion_queue SET status = 'completed', error_message = NULL, completed_at = unixepoch() WHERE id = ?"
      )
      .run(id)
  },

  markFailed(id: number, error: string): void {
    getSqlite()
      .prepare(
        "UPDATE conversion_queue SET status = 'failed', error_message = ?, completed_at = unixepoch() WHERE id = ?"
      )
      .run(error.slice(0, 2000), id)
  },

  /** Put a claimed row back, used when a batch is cancelled mid-flight. */
  release(id: number): void {
    getSqlite()
      .prepare(
        "UPDATE conversion_queue SET status = 'pending', started_at = NULL WHERE id = ? AND status = 'converting'"
      )
      .run(id)
  },

  counts(): ConversionCounts {
    const rows = getSqlite()
      .prepare('SELECT status, COUNT(*) AS n FROM conversion_queue GROUP BY status')
      .all() as Array<{ status: string; n: number }>
    const out: ConversionCounts = { pending: 0, converting: 0, completed: 0, failed: 0 }
    for (const r of rows) {
      if (r.status in out) out[r.status as keyof ConversionCounts] = r.n
    }
    return out
  },

  /** Library ids still awaiting conversion — used to lock those rows in the UI. */
  pendingItemIds(): number[] {
    return (
      getSqlite()
        .prepare(
          "SELECT library_item_id AS id FROM conversion_queue WHERE status IN ('pending','converting') AND library_item_id IS NOT NULL"
        )
        .all() as Array<{ id: number }>
    ).map((r) => r.id)
  },

  /** First few failure messages, for reporting a finished batch. */
  recentErrors(limit = 20): string[] {
    return (
      getSqlite()
        .prepare(
          "SELECT error_message AS msg FROM conversion_queue WHERE status = 'failed' AND error_message IS NOT NULL ORDER BY completed_at DESC LIMIT ?"
        )
        .all(limit) as Array<{ msg: string }>
    ).map((r) => r.msg)
  },

  /**
   * Drop finished rows. Called when a new batch starts so the queue reflects
   * outstanding work rather than accumulating a permanent history.
   */
  clearFinished(): number {
    return getSqlite()
      .prepare("DELETE FROM conversion_queue WHERE status IN ('completed','failed')")
      .run().changes
  }
}
