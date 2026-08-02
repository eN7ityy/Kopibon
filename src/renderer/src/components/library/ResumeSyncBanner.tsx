import { useState, useEffect } from 'react'
import { useSyncProgressStore } from '../../stores/sync-progress.store'

interface SyncQueueState {
  pending: number
  syncing: number
  completed: number
  failed: number
  outstanding: number
  errors: string[]
}

/**
 * Offers to finish a sync that was interrupted.
 *
 * A batch is paced against the API's rate limit, so a few hundred galleries
 * runs for several minutes and quitting part-way through is expected rather
 * than exceptional. The work list lives in `sync_queue`, and startup
 * maintenance puts anything left mid-item back, so the remainder is known —
 * this is what asks about it.
 *
 * Resuming is a choice rather than automatic, matching the conversion banner:
 * the app should not start making network requests on its own the next time it
 * launches.
 */
export default function ResumeSyncBanner(): React.JSX.Element | null {
  const [queue, setQueue] = useState<SyncQueueState | null>(null)
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const running = useSyncProgressStore((s) => s.running)

  // Re-read whenever a run finishes: that is when leftovers appear (cancelled)
  // or disappear (completed).
  useEffect(() => {
    if (running) return
    let cancelled = false
    window.api.library
      .getSyncQueue()
      .then((r) => {
        if (!cancelled && r?.success) setQueue(r.data as SyncQueueState)
      })
      .catch(() => {
        /* no banner is the right failure here */
      })
    return () => {
      cancelled = true
    }
  }, [running])

  if (dismissed || running || !queue || queue.outstanding === 0) return null

  const resume = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.library.resumeSync()
    } catch {
      /* the sync worker reports its own failures to the log */
    } finally {
      setBusy(false)
      setDismissed(true)
    }
  }

  const discard = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.library.clearSyncQueue()
    } catch {
      /* leaving the queue alone is the safe failure */
    } finally {
      setBusy(false)
      setDismissed(true)
    }
  }

  return (
    <div className="mb-4 shrink-0 rounded-lg border border-accent/40 bg-accent-wash px-3 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-fg">
          A sync was interrupted with{' '}
          <span className="tnum font-semibold">{queue.outstanding}</span>{' '}
          {queue.outstanding === 1 ? 'gallery' : 'galleries'} left.
          {queue.completed > 0 && (
            <span className="text-fg-muted">
              {' '}
              <span className="tnum">{queue.completed}</span> already done.
            </span>
          )}
          {queue.failed > 0 && (
            <span className="text-fg-muted">
              {' '}
              <span className="tnum">{queue.failed}</span> failed.
            </span>
          )}
        </p>
        <button
          onClick={() => void resume()}
          disabled={busy}
          className="rounded-lg bg-accent-fill px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? 'Resuming…' : 'Resume sync'}
        </button>
        <button
          onClick={() => void discard()}
          disabled={busy}
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:bg-raised disabled:opacity-50"
        >
          Discard
        </button>
      </div>
    </div>
  )
}
