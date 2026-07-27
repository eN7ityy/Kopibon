import { useState, useEffect, useCallback, useRef } from 'react'
import type { DownloadStatus } from '../../types/api.types'
import { SORT_OPTIONS } from '../../types/api.types'
import { useSearchStore } from '../../stores/search.store'
import GalleryGrid from './GalleryGrid'
import LoadingSkeleton from '../shared/LoadingSkeleton'
import EmptyState from '../shared/EmptyState'
import ErrorState from '../shared/ErrorState'

export default function SearchPage(): React.JSX.Element {
  const store = useSearchStore()
  const [showFilters, setShowFilters] = useState(false)
  const rateLimitTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Track when sort changes to auto-search (skip initial mount)
  const prevSortRef = useRef(store.sort)

  // Cleanup rate limit timer
  useEffect(() => {
    return () => {
      if (rateLimitTimerRef.current) clearInterval(rateLimitTimerRef.current)
    }
  }, [])

  // Rate limit countdown
  useEffect(() => {
    if (store.rateLimited && store.rateLimitSeconds > 0) {
      rateLimitTimerRef.current = setInterval(() => {
        store.decrementRateLimit()
      }, 1000)
    }
    return () => {
      if (rateLimitTimerRef.current) clearInterval(rateLimitTimerRef.current)
    }
  }, [store.rateLimited])

  // Auto-search when sort changes and query is non-empty
  useEffect(() => {
    if (prevSortRef.current !== store.sort && store.query.trim()) {
      performSearch(1, false)
    }
    prevSortRef.current = store.sort
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.sort])

  const resolveDownloadStatuses = useCallback(
    async (ids: number[]): Promise<Map<number, DownloadStatus>> => {
      const statuses = new Map<number, DownloadStatus>()

      await Promise.all(
        ids.map(async (id) => {
          try {
            const libResult = await window.api.library.getByGalleryId(id)
            if (libResult.success && libResult.data) {
              statuses.set(id, 'in_library')
              return
            }

            const dlResult = await window.api.downloads.getByGalleryId(id)
            if (dlResult.success && dlResult.data) {
              const dlStatus = dlResult.data.status
              if (dlStatus === 'downloading') statuses.set(id, 'downloading')
              else if (dlStatus === 'queued') statuses.set(id, 'queued')
              else if (dlStatus === 'completed') statuses.set(id, 'completed')
              else if (dlStatus === 'failed') statuses.set(id, 'failed')
              else statuses.set(id, 'not_downloaded')
              return
            }

            statuses.set(id, 'not_downloaded')
          } catch {
            statuses.set(id, 'not_downloaded')
          }
        })
      )

      return statuses
    },
    []
  )

  const performSearch = useCallback(
    async (page: number, append = false) => {
      const trimmedQuery = store.query.trim()
      if (!trimmedQuery) return

      if (page === 1) {
        store.setLoading(true)
      } else {
        store.setLoadingMore(true)
      }

      try {
        const result = await window.api.search(trimmedQuery, {
          page,
          sort: store.sort || undefined
        })

        if (result.success && result.data) {
          const data = result.data
          const newResults = append ? [...store.results, ...data.result] : data.result

          const statuses = await resolveDownloadStatuses(newResults.map((r) => r.id))

          if (append) {
            store.appendResults(data.result, statuses, page)
          } else {
            store.setResults(data.result, statuses, page > 0 ? page : 0, data.num_pages)
          }
        } else {
          const errorMsg = result.error || 'Search failed'
          if (errorMsg.includes('429') || errorMsg.toLowerCase().includes('rate')) {
            store.setRateLimited(60)
          } else {
            store.setError(errorMsg)
          }
        }
      } catch (err) {
        store.setError(err instanceof Error ? err.message : 'Search failed')
      }
    },
    [store.query, store.sort, store.results, resolveDownloadStatuses]
  )

  const handleSearch = (e: React.FormEvent): void => {
    e.preventDefault()
    performSearch(1, false)
  }

  const handleLoadMore = (): void => {
    if (!store.loadingMore && store.currentPage < store.totalPages) {
      performSearch(store.currentPage + 1, true)
    }
  }

  const handleGalleryClick = (id: number): void => {
    window.api.shell.openExternal(`https://nhentai.net/g/${id}`)
  }

  const handleRetry = (): void => {
    performSearch(store.currentPage || 1, false)
  }

  const handleSortChange = (newSort: string): void => {
    store.setSort(newSort)
  }

  const hasResults = store.results.length > 0
  const hasMorePages = store.currentPage < store.totalPages
  const showLoadMore = hasResults && hasMorePages && !store.loading && !store.loadingMore
  const currentSortLabel = SORT_OPTIONS.find((o) => o.value === store.sort)?.label ?? 'Date'

  return (
    <div className="flex flex-col h-full">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Search</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Search nhentai for doujinshi to download
        </p>
      </div>

      {/* Search bar */}
      <form onSubmit={handleSearch} className="flex gap-2 mb-3">
        <input
          type="text"
          value={store.query}
          onChange={(e) => store.setQuery(e.target.value)}
          placeholder="Search by title, artist, or tags..."
          className="flex-1 px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
        />
        <button
          type="button"
          onClick={() => setShowFilters(!showFilters)}
          className={`px-3 py-2.5 rounded-lg border transition-colors ${
            showFilters
              ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400'
              : 'border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
          }`}
          title="Sort"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
          </svg>
        </button>
        <button
          type="submit"
          disabled={store.loading}
          className="px-6 py-2.5 rounded-lg bg-purple-600 text-white font-medium hover:bg-purple-700 disabled:opacity-50 transition-colors"
        >
          {store.loading ? 'Searching...' : 'Search'}
        </button>
      </form>

      {/* Active sort indicator */}
      {store.sort !== '' && (
        <div className="mb-3 flex items-center gap-2">
          <span className="text-xs text-gray-500 dark:text-gray-400">Sorting by:</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 font-medium">
            {currentSortLabel}
          </span>
          <button
            onClick={() => handleSortChange('')}
            className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 ml-1"
          >
            ✕ reset
          </button>
        </div>
      )}

      {/* Sort panel */}
      {showFilters && (
        <div className="mb-4 p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700">
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            Sort by
          </label>
          <select
            value={store.sort}
            onChange={(e) => handleSortChange(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-1 focus:ring-purple-500"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Rate limit overlay */}
      {store.rateLimited && (
        <div className="mb-4 p-3 rounded-lg bg-orange-100 dark:bg-orange-900/30 border border-orange-300 dark:border-orange-700 flex items-center gap-3">
          <span className="text-xl">⏱️</span>
          <div className="flex-1">
            <p className="text-sm font-medium text-orange-800 dark:text-orange-300">Rate Limited</p>
            <p className="text-xs text-orange-600 dark:text-orange-400">
              Retrying in {store.rateLimitSeconds}s...
            </p>
          </div>
        </div>
      )}

      {/* Content area */}
      <div className="flex-1 overflow-y-auto">
        {/* Loading skeleton */}
        {store.loading && !hasResults && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            <LoadingSkeleton count={12} variant="card" />
          </div>
        )}

        {/* Error state */}
        {store.error && !hasResults && !store.loading && (
          <ErrorState message={store.error} onRetry={handleRetry} />
        )}

        {/* Initial empty state */}
        {!store.loading && !store.error && !hasResults && store.totalPages === 0 && store.query.trim() === '' && (
          <div className="flex-1 flex items-center justify-center border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl">
            <div className="text-center text-gray-400 dark:text-gray-500">
              <span className="text-5xl block mb-3">🔍</span>
              <p className="text-lg font-medium">Search results will appear here</p>
              <p className="text-sm mt-1">Enter a search query to find doujinshi on nhentai</p>
            </div>
          </div>
        )}

        {/* No results */}
        {!store.loading && !store.error && store.totalPages === 0 && store.query.trim() !== '' && (
          <EmptyState
            icon="🔍"
            title="No results found"
            description="Try adjusting your search query or filters"
          />
        )}

        {/* Results */}
        {hasResults && (
          <div className="space-y-6">
            <GalleryGrid
              galleries={store.results.map((g) => ({
                gallery: g,
                downloadStatus: (store.downloadStatuses[g.id] as DownloadStatus) ?? 'not_downloaded'
              }))}
              onGalleryClick={handleGalleryClick}
            />

            {showLoadMore && (
              <div className="flex justify-center pb-4">
                <button
                  onClick={handleLoadMore}
                  className="px-6 py-2.5 rounded-lg bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 font-medium hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
                >
                  Load More
                </button>
              </div>
            )}

            {store.loadingMore && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 pb-4">
                <LoadingSkeleton count={6} variant="card" />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
