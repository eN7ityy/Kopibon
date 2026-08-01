import { useState, useEffect } from 'react'
import { Layers, X } from 'lucide-react'
import type { LibraryItemData } from './LibraryCard'
import type { SeriesCardModel } from './SeriesCard'
import { mergeDisplayLanguages } from '../shared/language'
import { formatBytes } from '../shared/format'

/**
 * Everything inside a series.
 *
 * Clicking a series has to lead somewhere, so this is what a click opens: the
 * galleries the card stands for, in reading order, each one a way into the
 * normal gallery detail.
 *
 * Deliberately narrow for now — the aggregate header, merged tag block, gap
 * warnings and series-level actions are the next piece of work. What is here is
 * the part the grid cannot function without.
 */

interface SeriesDetailProps {
  series: SeriesCardModel
  onClose: () => void
  /** Open one gallery's own detail panel. */
  onOpenItem: (item: LibraryItemData) => void
}

export default function SeriesDetail({
  series,
  onClose,
  onOpenItem
}: SeriesDetailProps): React.JSX.Element {
  /*
   * `loading` starts true rather than being set true inside the effect.
   *
   * Resetting state from an effect body runs a render with the previous
   * series' members still on screen, and eslint's set-state-in-effect rule
   * rejects it. The parent mounts this keyed by series id, so switching series
   * is a remount and these initial values are correct every time.
   */
  const [members, setMembers] = useState<LibraryItemData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  /*
   * The card carries member ids but not their rows, so the panel fetches them.
   *
   * Ids come from the card rather than from a fresh query, so the panel shows
   * exactly what the card counted — under a filter that is the matching
   * members, not the whole series.
   *
   * No sorting here. Main already returned them in reading order, by volume
   * then title with unnumbered members last, and Promise.all preserves that
   * order. Re-sorting would be a second copy of a rule that is already tested
   * in one place, and the copy would be the one to drift.
   */
  useEffect(() => {
    let cancelled = false

    Promise.all(series.members.map((m) => window.api.library.getById(m.id)))
      .then((results) => {
        if (cancelled) return
        setMembers(
          results
            .filter((r) => r?.success && r.data)
            .map((r) => r.data as unknown as LibraryItemData)
        )
      })
      .catch((err) => {
        if (!cancelled) setError(String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [series])

  const languages = mergeDisplayLanguages(series.languages)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="mx-4 flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-line px-6 py-4">
          <Layers size={20} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="text-section font-semibold text-fg">{series.name}</h2>
            <p className="mt-1 text-sm text-fg-muted">
              {series.matchCount < series.totalCount
                ? `${series.matchCount} of ${series.totalCount} galleries match the current filters`
                : `${series.totalCount} galleries`}
              {series.artists.length > 0 && <> · {series.artists.join(', ')}</>}
              {languages.length > 0 && <> · {languages.join(', ')}</>}
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-1 text-fg-muted transition-colors hover:bg-raised hover:text-fg"
            aria-label="Close"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {loading && <p className="text-sm text-fg-muted">Loading…</p>}
          {error && (
            <div className="rounded-lg border border-danger bg-danger-wash p-3 text-sm text-danger">
              {error}
            </div>
          )}

          {!loading && !error && (
            <ul className="space-y-1">
              {members.map((item) => (
                <li key={item.id}>
                  <button
                    onClick={() => onOpenItem(item)}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-raised"
                  >
                    {/*
                      Volume leads the row. It is the one field that orders the
                      series, and an unnumbered member has to be visibly
                      unnumbered rather than silently sorted last.
                    */}
                    <span className="tnum w-10 shrink-0 text-xs font-medium text-accent">
                      {item.seriesIndex != null ? `V${item.seriesIndex}` : '—'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">
                      {item.customTitle || `Item #${item.id}`}
                    </span>
                    <span className="shrink-0 text-xs uppercase text-fg-faint">
                      {item.format || 'pdf'}
                    </span>
                    <span className="tnum w-16 shrink-0 text-right text-xs text-fg-faint">
                      {item.fileSize ? formatBytes(item.fileSize) : '—'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
