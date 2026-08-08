import { useState, useEffect, useMemo } from 'react'
import AutocompleteInput from '../shared/AutocompleteInput'
import type { LibraryItemData } from './LibraryCard'
import { FileText, ListX, Sparkles, Check } from 'lucide-react'
import { findCommonSeriesName, extractChapterNumber } from './series-auto-detect'

// ─── Types ───────────────────────────────────────────────────────────────────

interface SeriesAssignmentProps {
  isOpen: boolean
  /** The selected rows this dialog can display and prefill volumes for. */
  items: LibraryItemData[]
  /**
   * Every selected id, which may exceed `items`.
   *
   * The grid is virtualised, so "Select all" can select ids whose rows were
   * never loaded. The series name applies to all of them; per-item volumes only
   * exist for the rows above, so the rest are assigned the series with no volume
   * rather than being silently skipped.
   */
  allSelectedIds?: number[]
  onClose: () => void
  onAssigned: () => void
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function SeriesAssignment({
  isOpen,
  items,
  allSelectedIds,
  onClose,
  onAssigned
}: SeriesAssignmentProps): React.JSX.Element | null {
  const [seriesName, setSeriesName] = useState('')
  // Per-item volume map: itemId → volume string
  const [volumes, setVolumes] = useState<Map<number, string>>(new Map())
  const [applying, setApplying] = useState(false)
  const selectionSize = allSelectedIds?.length ?? items.length
  const [error, setError] = useState<string | null>(null)

  /**
   * Whether the current series name and per-item volumes were auto-detected
   * from the titles. Drives the "auto" badges and the accept-suggestions
   * button. Editing a value clears its flag.
   */
  const [seriesAuto, setSeriesAuto] = useState(false)
  const [volumesAuto, setVolumesAuto] = useState<Set<number>>(new Set())

  /**
   * A stable signature of the selection, so auto-detection re-runs when the
   * set of selected galleries changes but not on unrelated re-renders (the
   * parent rebuilds the `items` array on every render, so it cannot be a dep).
   */
  const selectionSignature = useMemo(
    () =>
      items
        .map((i) => `${i.id}|${i.customTitle ?? ''}|${i.seriesName ?? ''}|${i.seriesIndex ?? ''}`)
        .join('§'),
    [items]
  )

  // Auto-detect series name + chapters from the selected titles.
  useEffect(() => {
    if (!isOpen) return

    // Series: prefer an existing series shared by every item, else detect the
    // common title substring.
    const allSeries = items.map((i) => i.seriesName).filter(Boolean)
    const sharedExisting = allSeries.length === items.length && new Set(allSeries).size === 1
    if (sharedExisting) {
      setSeriesName(allSeries[0]!)
      setSeriesAuto(false)
    } else {
      const titles = items.map((i) => i.customTitle || '')
      const detected = findCommonSeriesName(titles)
      setSeriesName(detected)
      setSeriesAuto(detected.length > 0)
    }

    // Chapters: keep an existing seriesIndex, else parse the title. Low
    // confidence leaves the field blank rather than guessing a sequential
    // number that is probably wrong.
    const next = new Map<number, string>()
    const nextAuto = new Set<number>()
    items.forEach((item) => {
      if (item.seriesIndex != null) {
        next.set(item.id, String(item.seriesIndex))
      } else {
        const chapter = extractChapterNumber(item.customTitle || '')
        if (chapter != null) {
          next.set(item.id, String(chapter))
          nextAuto.add(item.id)
        }
      }
    })
    setVolumes(next)
    setVolumesAuto(nextAuto)
  }, [isOpen, selectionSignature])

  const hasSuggestions = seriesAuto || volumesAuto.size > 0

  /** Accept every suggestion: the values stay, the "auto" badges clear. */
  const acceptSuggestions = (): void => {
    setSeriesAuto(false)
    setVolumesAuto(new Set())
  }

  if (!isOpen) return null

  const handleApply = async () => {
    if (!seriesName.trim()) {
      setError('Please enter or select a series name')
      return
    }

    setApplying(true)
    setError(null)

    try {
      // Send each item's volume with the assignment so the series and the
      // volume are embedded in a single pass. This used to assign the series
      // first and then call updateMetadata() per item to correct the volume,
      // rewriting every PDF twice.
      const entries = items.map((item) => {
        const volStr = (volumes.get(item.id) ?? '').trim()
        const volNum = volStr ? parseFloat(volStr) : NaN
        return {
          id: item.id,
          seriesIndex: Number.isFinite(volNum) ? volNum : null
        }
      })

      // Ids with no loaded row still get the series, just without a volume.
      const displayed = new Set(items.map((item) => item.id))
      const extra = (allSelectedIds ?? [])
        .filter((id) => !displayed.has(id))
        .map((id) => ({ id, seriesIndex: null }))

      const result = await window.api.library.assignSeries(
        [...entries, ...extra],
        seriesName.trim()
      )

      if (result.success) {
        onAssigned()
        onClose()
      } else {
        setError(result.error || 'Failed to assign series')
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setApplying(false)
    }
  }

  /**
   * Clear the series from every selected item.
   *
   * Lives here rather than as its own button in the selection bar: assigning and
   * clearing a series are the same decision, and the bar was carrying two
   * buttons for it. Clearing is also the destructive half, so it belongs behind
   * the dialog you already opened to change series, not one click away in a
   * toolbar.
   */
  const handleUnassign = async (): Promise<void> => {
    setApplying(true)
    setError(null)
    try {
      const ids =
        allSelectedIds && allSelectedIds.length > 0
          ? allSelectedIds
          : items.map((item) => item.id)
      for (const id of ids) {
        await window.api.library.updateMetadata(id, {
          seriesName: null,
          seriesIndex: null
        })
      }
      onAssigned()
      onClose()
    } catch (err) {
      setError(String(err))
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-surface rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-line">
          <h2 className="text-section font-semibold text-fg">
            Assign Series
          </h2>
          <p className="text-sm text-fg-muted mt-1">
            {selectionSize} item{selectionSize !== 1 ? 's' : ''} selected
          </p>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4">
          {/* Series input */}
          <div>
            <label className="flex items-center gap-1.5 text-sm font-medium text-fg mb-1">
              Series Name
              {seriesAuto && (
                <span
                  className="inline-flex items-center gap-0.5 text-xs font-normal text-accent"
                  title="Detected from the selected titles"
                >
                  <Sparkles size={11} aria-hidden="true" />
                  auto
                </span>
              )}
            </label>
            <AutocompleteInput
              kind="series"
              value={seriesName}
              onChange={(value) => {
                setSeriesName(value)
                setSeriesAuto(false)
              }}
              placeholder="Search or type a series name..."
            />
          </div>

          {/* Accept all auto-detected values at once */}
          {hasSuggestions && (
            <button
              type="button"
              onClick={acceptSuggestions}
              className="inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent-wash px-3 py-1.5 text-sm font-medium text-accent transition-colors hover:bg-accent-wash"
              title="Keep the suggested series name and chapters and clear the auto markers"
            >
              <Check size={14} aria-hidden="true" />
              Accept suggestions
            </button>
          )}

          {/* Selected items with per-item volume */}
          <div>
            <h4 className="text-sm font-medium text-fg mb-2">
              Volumes
            </h4>
            <div className="max-h-56 overflow-y-auto space-y-2 rounded-lg border border-line p-2">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-2 text-sm py-1 px-2 rounded hover:bg-raised"
                >
                  <FileText size={14} className="text-accent shrink-0" aria-hidden="true" />
                  <input
                    type="text"
                    readOnly
                    value={item.customTitle || item.filePath.split('/').pop() || `Item #${item.id}`}
                    className="flex-1 min-w-0 bg-transparent border-none text-fg-muted text-sm cursor-text select-all focus:outline-none"
                  />
                  {volumesAuto.has(item.id) && (
                    <Sparkles
                      size={12}
                      className="text-accent shrink-0"
                      aria-label="Auto-detected chapter"
                    />
                  )}
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={volumes.get(item.id) ?? ''}
                    onChange={(e) => {
                      setVolumes((prev) => {
                        const next = new Map(prev)
                        next.set(item.id, e.target.value)
                        return next
                      })
                      // Editing a volume is an explicit override — drop its auto marker.
                      setVolumesAuto((prev) => {
                        if (!prev.has(item.id)) return prev
                        const next = new Set(prev)
                        next.delete(item.id)
                        return next
                      })
                    }}
                    placeholder="Vol"
                    className="w-16 px-2 py-1 rounded border border-line bg-surface text-xs text-fg focus:ring-2 focus:ring-accent shrink-0"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="p-3 rounded-lg bg-danger-wash border border-danger text-danger text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-line flex items-center gap-3">
          {/*
            Clearing the series sits apart from Cancel and Apply, on the left,
            because it acts on the selection rather than confirming the form —
            and unlike Apply it does not need a series name to be typed.

            Always shown rather than gated on the selection having a series: the
            check could only look at the loaded rows, so once "Select all" reached
            past them the button would hide exactly when it was still needed.
          */}
          <button
            onClick={handleUnassign}
            disabled={applying}
            className="inline-flex items-center gap-1.5 rounded-lg border border-danger px-3 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger-wash disabled:opacity-50"
          >
            <ListX size={14} aria-hidden="true" />
            Remove from series
          </button>

          <div className="flex-1" />

          <button
            onClick={onClose}
            disabled={applying}
            className="px-4 py-2 rounded-lg text-sm font-medium text-fg bg-raised hover:bg-raised transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={applying || !seriesName.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-accent-fill hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {applying ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Applying...
              </>
            ) : (
              'Apply'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
