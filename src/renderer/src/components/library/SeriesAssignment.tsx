import { useState, useEffect } from 'react'
import AutocompleteInput from '../shared/AutocompleteInput'
import type { LibraryItemData } from './LibraryCard'
import { FileText } from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────────────────

interface SeriesAssignmentProps {
  isOpen: boolean
  items: LibraryItemData[]
  onClose: () => void
  onAssigned: () => void
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function SeriesAssignment({
  isOpen,
  items,
  onClose,
  onAssigned
}: SeriesAssignmentProps): React.JSX.Element | null {
  const [seriesName, setSeriesName] = useState('')
  // Per-item volume map: itemId → volume string
  const [volumes, setVolumes] = useState<Map<number, string>>(new Map())
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Pre-fill series name and volumes from existing data
  useEffect(() => {
    if (!isOpen) return

    // Pre-fill series name if all items have the same series
    const allSeries = items.map((i) => i.seriesName).filter(Boolean)
    if (allSeries.length === items.length && new Set(allSeries).size === 1) {
      setSeriesName(allSeries[0]!)
    } else {
      setSeriesName('')
    }

    // Pre-fill volumes from existing seriesIndex, title regex, or sequential
    const volumePatterns = [
      /vol\.?\s*(\d+(?:\.\d+)?)/i,
      /ch\.?\s*(\d+(?:\.\d+)?)/i,
      /chapter\s*(\d+(?:\.\d+)?)/i,
      /ep\.?\s*(\d+(?:\.\d+)?)/i,
      /episode\s*(\d+(?:\.\d+)?)/i,
      /part\s*(\d+(?:\.\d+)?)/i,
      /#(\d+(?:\.\d+)?)/
    ]

    const next = new Map<number, string>()
    items.forEach((item, idx) => {
      if (item.seriesIndex != null) {
        next.set(item.id, String(item.seriesIndex))
      } else {
        // Try regex patterns on title first
        const title = item.customTitle || ''
        let found = false
        for (const pattern of volumePatterns) {
          const match = title.match(pattern)
          if (match) {
            next.set(item.id, match[1])
            found = true
            break
          }
        }
        // Fall back to sequential
        if (!found) {
          next.set(item.id, String(idx + 1))
        }
      }
    })
    setVolumes(next)
  }, [isOpen])

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

      const result = await window.api.library.assignSeries(entries, seriesName.trim())

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
            {items.length} item{items.length !== 1 ? 's' : ''} selected
          </p>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4">
          {/* Series input */}
          <div>
            <label className="block text-sm font-medium text-fg mb-1">
              Series Name
            </label>
            <AutocompleteInput
              kind="series"
              value={seriesName}
              onChange={setSeriesName}
              placeholder="Search or type a series name..."
            />
          </div>

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
        <div className="px-6 py-4 border-t border-line flex justify-end gap-3">
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
