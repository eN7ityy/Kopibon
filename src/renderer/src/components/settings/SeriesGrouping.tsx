import { useState, useEffect } from 'react'
import { Layers } from 'lucide-react'

/**
 * Turn Kavita-style series grouping on or off.
 *
 * Off by default. Switching it on links the whole library in one pass, so the
 * grid is grouped as soon as the dialog closes rather than filling in as items
 * are touched.
 *
 * The confirmation quotes real numbers, computed before anything is written.
 * That matters here: a library holds far more distinct series *names* than
 * actual series — most one-shots carry their own title in the field — so a
 * dialog quoting the name count would promise something entirely different
 * from what appears.
 */

interface GroupingPreview {
  groups: number
  galleries: number
}

export default function SeriesGrouping(): React.JSX.Element {
  const [enabled, setEnabled] = useState(false)
  const [preview, setPreview] = useState<GroupingPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  // Driven by a counter so state is only ever set from a promise callback,
  // never synchronously during the effect.
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.api.settings.get('seriesGrouping'),
      window.api.library.previewSeriesGrouping()
    ])
      .then(([setting, p]) => {
        if (cancelled) return
        setEnabled(setting?.data === 'true')
        if (p?.success) setPreview(p.data as GroupingPreview)
      })
      .catch(() => {
        /* the toggle stays off and the preview simply does not render */
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reloadTick])

  const apply = async (next: boolean): Promise<void> => {
    setBusy(true)
    setConfirming(false)
    setResult(null)
    try {
      const r = await window.api.library.setSeriesGrouping(next)
      if (r?.success) {
        setEnabled(next)
        const d = r.data as GroupingPreview
        setResult(
          next
            ? `Grouped ${d.galleries} galleries into ${d.groups} series.`
            : 'Grouping switched off. The groups are kept, so switching it back on is instant.'
        )
        setReloadTick((t) => t + 1)
      } else {
        setResult(r?.error || 'Could not change the setting')
      }
    } catch (err) {
      setResult(String(err))
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return <p className="text-xs text-fg-faint">Checking series grouping…</p>
  }

  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex items-start gap-3">
        <Layers size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(e) => {
                // Switching on does real work, so it asks first. Switching off
                // only flips a setting and needs no confirmation.
                if (e.target.checked) setConfirming(true)
                else void apply(false)
              }}
              className="h-4 w-4 rounded border-line text-accent focus:ring-accent"
            />
            <span className="text-sm font-medium text-fg">Group galleries into series</span>
          </label>

          <p className="mt-1 text-xs text-fg-muted">
            Galleries sharing a series name are shown as one entry in the library, the way Kavita
            groups them. A series needs at least two galleries — a one-shot stays a single entry.
          </p>

          {preview && !confirming && (
            <p className="tnum mt-2 text-xs text-fg-faint">
              {preview.groups > 0
                ? `${preview.groups} series across ${preview.galleries} galleries in your library.`
                : 'No series with two or more galleries yet.'}
            </p>
          )}

          {/*
            Stated before anything is written, with the real counts. Also says
            what is left alone, since "grouping my library" sounds like it might
            move or rewrite files, and it does neither.
          */}
          {confirming && preview && (
            <div className="mt-3 rounded-lg border border-accent/40 bg-accent-wash p-3">
              <p className="text-sm text-fg">
                Group <span className="tnum font-semibold">{preview.galleries}</span> galleries into{' '}
                <span className="tnum font-semibold">{preview.groups}</span> series?
              </p>
              <p className="mt-1 text-xs text-fg-muted">
                Nothing on disk changes and no metadata is rewritten — this only affects how the
                library is displayed. You can switch it off again at any time.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => void apply(true)}
                  disabled={busy}
                  className="rounded-lg bg-accent-fill px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  {busy ? 'Grouping…' : 'Group them'}
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                  className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:bg-raised disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {result && <p className="mt-2 text-xs text-fg-muted">{result}</p>}
        </div>
      </div>
    </div>
  )
}
