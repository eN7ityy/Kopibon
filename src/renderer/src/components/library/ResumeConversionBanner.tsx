import { useState, useEffect } from 'react'
import { useCbzConversionStore } from '../../stores/cbz-conversion.store'

interface QueueState {
  pending: number
  converting: number
  completed: number
  failed: number
  outstanding: number
  errors: string[]
}

/**
 * Offers to finish a conversion that was interrupted.
 *
 * Converting a large library runs for hours, so quitting part-way through is
 * expected rather than exceptional. The work list lives in `conversion_queue`,
 * and startup maintenance resets anything that was mid-flight, so the remaining
 * items are known — this is what asks about them. Resuming is deliberately a
 * choice rather than automatic: the app should not start rewriting files on its
 * own the next time it launches.
 */
export default function ResumeConversionBanner(): React.JSX.Element | null {
  const [queue, setQueue] = useState<QueueState | null>(null)
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const running = useCbzConversionStore((s) => s.running)

  // Re-read whenever a run finishes: that is when leftovers appear (cancelled)
  // or disappear (completed).
  useEffect(() => {
    if (running) return
    let cancelled = false
    window.api.library
      .getConversionQueue()
      .then((r) => {
        if (!cancelled) setQueue(r?.success ? (r.data as QueueState) : null)
      })
      .catch(() => {
        if (!cancelled) setQueue(null)
      })
    return () => { cancelled = true }
  }, [running])

  if (running || dismissed || !queue || queue.outstanding === 0) return null

  const n = queue.outstanding

  return (
    <div className="mb-4 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm text-amber-800 dark:text-amber-300">
          <p className="font-medium">
            {n} file{n === 1 ? '' : 's'} left from an unfinished conversion
          </p>
          <p className="text-xs mt-0.5 opacity-90">
            Each keeps the keep-or-delete choice you made when you started it.
            {queue.failed > 0 && ` ${queue.failed} failed earlier and will not be retried.`}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={async () => {
              setBusy(true)
              useCbzConversionStore.getState().begin(n)
              try {
                // No ids: the queue is the work list on a resume.
                await window.api.library.convertToCbz([], false, { resume: true })
              } finally {
                useCbzConversionStore.getState().finish()
                setBusy(false)
              }
            }}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-medium hover:bg-amber-700 disabled:opacity-50"
          >
            {busy ? 'Resuming…' : 'Resume'}
          </button>
          <button
            onClick={async () => {
              await window.api.library.clearConversionQueue()
              setDismissed(true)
            }}
            className="px-3 py-1.5 rounded-lg bg-white dark:bg-gray-800 border border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300 text-xs font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40"
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  )
}
