import { useState } from 'react'

interface PaginationProps {
  page: number
  totalPages: number
  onChange: (page: number) => void
  disabled?: boolean
}

const BTN =
  'px-3 py-1.5 rounded text-sm font-medium border border-gray-300 dark:border-gray-700 ' +
  'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 ' +
  'disabled:opacity-40 disabled:cursor-not-allowed transition-colors'

/**
 * Page navigation shared by Search and Favorites.
 *
 * Includes a typable page number, which the browser site only offers by editing
 * the URL, plus first/last jumps — with thousands of pages of results, stepping
 * one page at a time is the only option the old two-button version left.
 */
export default function Pagination({
  page,
  totalPages,
  onChange,
  disabled = false
}: PaginationProps): React.JSX.Element {
  const [draft, setDraft] = useState(String(page))
  const [syncedPage, setSyncedPage] = useState(page)

  // Follow the real page when it changes elsewhere (prev/next, a new search, or
  // the server clamping a request), so the field never shows a stale number.
  // Adjusted during render rather than in an effect: React discards this pass
  // and re-renders immediately, so the input never paints the old number, and it
  // avoids the cascading-render an effect would cause.
  if (syncedPage !== page) {
    setSyncedPage(page)
    setDraft(String(page))
  }

  const go = (target: number): void => {
    const clamped = Math.max(1, Math.min(totalPages, target))
    if (clamped !== page) onChange(clamped)
  }

  /** Accept the typed value, or snap back if it is not a usable page. */
  const commit = (): void => {
    const n = parseInt(draft, 10)
    if (!Number.isFinite(n) || n < 1) {
      setDraft(String(page))
      return
    }
    const clamped = Math.min(totalPages, n)
    setDraft(String(clamped))
    if (clamped !== page) onChange(clamped)
  }

  const atFirst = disabled || page <= 1
  const atLast = disabled || page >= totalPages

  return (
    <div className="flex items-center justify-center gap-2 pb-4">
      <button onClick={() => go(1)} disabled={atFirst} title="First page" className={BTN}>
        ⇤ First
      </button>
      <button onClick={() => go(page - 1)} disabled={atFirst} className={BTN}>
        ← Prev
      </button>

      <div className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
        <span>Page</span>
        <input
          type="text"
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
              // Enter in a page field means "go" — dropping focus makes that
              // obvious and stops a second Enter re-submitting the same page.
              ;(e.target as HTMLInputElement).blur()
            } else if (e.key === 'Escape') {
              setDraft(String(page))
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          disabled={disabled}
          aria-label="Page number"
          className="w-16 px-2 py-1 text-center rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 tabular-nums focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50"
        />
        <span>of {totalPages}</span>
      </div>

      <button onClick={() => go(page + 1)} disabled={atLast} className={BTN}>
        Next →
      </button>
      <button onClick={() => go(totalPages)} disabled={atLast} title="Last page" className={BTN}>
        Last ⇥
      </button>
    </div>
  )
}
