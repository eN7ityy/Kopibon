import { useState, useEffect } from 'react'

interface OriginalsInfo {
  count: number
  bytes: number
  lossyCount: number
  lossyBytes: number
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * Reclaim space taken by archived original PDFs.
 *
 * Conversions that kept their originals leave them under `_originals/`, which
 * accumulates indefinitely. This reports the real on-disk total and deletes it
 * on request.
 *
 * Files under `_originals/_lossy/` are counted separately and never removed by
 * the ordinary sweep: those conversions used the re-rasterising fallback, so the
 * archived PDF is the higher-quality copy of the two.
 */
export default function OriginalsCleanup(): React.JSX.Element {
  const [info, setInfo] = useState<OriginalsInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  // Re-read is driven by a counter rather than by calling a fetch function from
  // the effect: state is only ever set from a promise callback, so nothing is set
  // synchronously during the effect, and the cancelled flag keeps a purge that
  // completes after unmount from writing to a dead component.
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    window.api.library
      .getOriginalsInfo()
      .then((r) => {
        if (!cancelled) setInfo(r?.success ? (r.data as OriginalsInfo) : null)
      })
      .catch(() => {
        if (!cancelled) setInfo(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [reloadTick])

  const purge = async (includeLossy: boolean): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.library.purgeOriginals(includeLossy)
      if (r?.success) {
        const d = r.data as {
          deleted: number
          bytes: number
          failed: number
          removedDirs?: number
        }
        setResult(
          `Deleted ${d.deleted} file${d.deleted === 1 ? '' : 's'}, freed ${formatBytes(d.bytes)}` +
            // Worth stating: the folders used to be left behind, so seeing them
            // counted confirms the tree was actually tidied up.
            (d.removedDirs ? `, removed ${d.removedDirs} empty folder${d.removedDirs === 1 ? '' : 's'}` : '') +
            (d.failed > 0 ? ` · ${d.failed} could not be removed` : '')
        )
      } else {
        setResult(r?.error || 'Could not delete originals')
      }
    } catch (e) {
      setResult(String(e))
    }
    setBusy(false)
    setConfirming(false)
    setReloadTick((t) => t + 1)
  }

  if (loading) {
    return <p className="text-xs text-fg-faint">Checking archived originals…</p>
  }

  const total = (info?.count ?? 0) + (info?.lossyCount ?? 0)
  if (total === 0) {
    return (
      <p className="text-xs text-fg-faint">
        {result || 'No archived original PDFs.'}
      </p>
    )
  }

  return (
    <div className="p-3 rounded-lg bg-raised/50 border border-line space-y-2">
      <div className="text-xs text-fg-muted">
        <span className="font-medium text-fg">
          {info!.count} archived original{info!.count === 1 ? '' : 's'} · {formatBytes(info!.bytes)}
        </span>
        {info!.lossyCount > 0 && (
          <span className="block mt-0.5">
            Plus {info!.lossyCount} ({formatBytes(info!.lossyBytes)}) that are the better copy of
            their pages and are kept back.
          </span>
        )}
      </div>

      {result && <p className="text-xs text-success">{result}</p>}

      {confirming ? (
        <div className="space-y-2">
          <p className="text-xs text-danger">
            Permanently delete {info!.count} PDF{info!.count === 1 ? '' : 's'} and free{' '}
            {formatBytes(info!.bytes)}? Their CBZ files stay. This cannot be undone.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => purge(false)}
              disabled={busy || info!.count === 0}
              className="px-3 py-1.5 rounded-lg bg-danger-fill text-white text-xs font-medium hover:bg-danger-fill disabled:opacity-50"
            >
              {busy ? 'Deleting…' : 'Delete originals'}
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="px-3 py-1.5 rounded-lg bg-raised text-xs font-medium text-fg hover:bg-raised"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          disabled={info!.count === 0}
          title={info!.count === 0 ? 'Only kept-back originals remain' : undefined}
          className="px-3 py-1.5 rounded-lg bg-danger-wash text-danger text-xs font-medium hover:bg-danger-wash disabled:opacity-50"
        >
          🗑️ Delete archived originals
        </button>
      )}
    </div>
  )
}
