import { useState, useEffect } from 'react'
import AutocompleteInput from '../shared/AutocompleteInput'
import type { LibraryItemData } from './LibraryCard'

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
      // Assign series name to all items, then update each item's volume
      const ids = items.map((item) => item.id)
      const result = await window.api.library.assignSeries(ids, seriesName.trim())
      
      // Apply per-item volumes
      for (const item of items) {
        const volStr = volumes.get(item.id)
        if (volStr && volStr.trim()) {
          const volNum = parseFloat(volStr.trim())
          if (!isNaN(volNum)) {
            await window.api.library.updateMetadata(item.id, { seriesIndex: volNum })
          }
        }
      }

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
        className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Assign Series
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {items.length} item{items.length !== 1 ? 's' : ''} selected
          </p>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4">
          {/* Series input */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
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
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Volumes
            </h4>
            <div className="max-h-56 overflow-y-auto space-y-2 rounded-lg border border-gray-200 dark:border-gray-700 p-2">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-2 text-sm py-1 px-2 rounded hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <span className="text-purple-500 shrink-0">📄</span>
                  <span className="truncate flex-1 text-gray-600 dark:text-gray-400">
                    {item.customTitle || item.filePath.split('/').pop() || `Item #${item.id}`}
                  </span>
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
                    className="w-16 px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-xs text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-purple-500 shrink-0"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={applying}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={applying || !seriesName.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
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
