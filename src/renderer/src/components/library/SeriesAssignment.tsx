import { useState } from 'react'
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
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isOpen) return null

  const handleApply = async () => {
    if (!seriesName.trim()) {
      setError('Please enter or select a series name')
      return
    }

    setApplying(true)
    setError(null)

    try {
      const ids = items.map((item) => item.id)
      const result = await window.api.library.assignSeries(ids, seriesName.trim())

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

          {/* Selected items preview */}
          <div>
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Selected Items
            </h4>
            <div className="max-h-48 overflow-y-auto space-y-1 rounded-lg border border-gray-200 dark:border-gray-700 p-2">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 py-1 px-2 rounded hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <span className="text-purple-500">📄</span>
                  <span className="truncate flex-1">
                    {item.customTitle || item.filePath.split('/').pop() || `Item #${item.id}`}
                  </span>
                  <span className="text-xs text-gray-400 shrink-0">
                    {item.primaryArtist}
                  </span>
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
