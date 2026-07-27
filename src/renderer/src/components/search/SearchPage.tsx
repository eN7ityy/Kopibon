import { useEffect, useCallback, useRef, useState } from 'react'
import type { DownloadStatus } from '../../types/api.types'
import { SORT_OPTIONS } from '../../types/api.types'
import { useSearchStore } from '../../stores/search.store'
import GalleryGrid from './GalleryGrid'
import GalleryDetail from '../gallery/GalleryDetail'
import LoadingSkeleton from '../shared/LoadingSkeleton'
import EmptyState from '../shared/EmptyState'
import ErrorState from '../shared/ErrorState'

export default function SearchPage(): React.JSX.Element {
  const store = useSearchStore()
  const rateLimitTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const prevSortRef = useRef(store.sort)
  const [selectedGalleryId, setSelectedGalleryId] = useState<number | null>(null)
  const resultsContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return () => {
      if (rateLimitTimerRef.current) clearInterval(rateLimitTimerRef.current)
    }
  }, [])

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

  // Refresh statuses on mount + poll every 2s for real-time updates
  useEffect(() => {
    const refreshStatuses = async () => {
      if (store.results.length === 0) return
      const ids = store.results.map((r) => r.id)
      const statuses = await resolveDownloadStatuses(ids)
      for (const [id, status] of statuses) {
        store.downloadStatuses[id] = status
      }
    }
    refreshStatuses()
    const interval = setInterval(refreshStatuses, 2000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.results])

  // Auto-search when sort changes and query is non-empty
  useEffect(() => {
    if (prevSortRef.current !== store.sort && store.query.trim()) {
      performSearch(1)
    }
    prevSortRef.current = store.sort
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.sort])

  const resolveDownloadStatuses = useCallback(
    async (ids: number[]): Promise<Map<number, DownloadStatus>> => {
      const statuses = new Map<number, DownloadStatus>()

      // Library is the single source of truth for download status.
      // - isCustom=0 with filePath → "in_library" (on disk)
      // - isCustom=2 → "downloading" (placeholder, not yet complete)
      // - not found → "not_downloaded"
      await Promise.all(
        ids.map(async (id) => {
          try {
            const libResult = await window.api.library.getByGalleryId(id)
            if (libResult.success && libResult.data) {
              const item = libResult.data
              if (item.isCustom === 2) {
                // Placeholder created when download started
                statuses.set(id, 'downloading')
              } else {
                statuses.set(id, 'in_library')
              }
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
    async (page: number, overrideQuery?: string) => {
      const trimmedQuery = (overrideQuery ?? store.query).trim()
      if (!trimmedQuery) return

      store.setLoading(true)

      try {
        const result = await window.api.search(trimmedQuery, {
          page,
          sort: store.sort || undefined
        })

        if (result.success && result.data) {
          const data = result.data
          const statuses = await resolveDownloadStatuses(data.result.map((r) => r.id))
          store.setResults(data.result, statuses, page > 0 ? page : 0, data.num_pages)
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
    [store.query, store.sort, resolveDownloadStatuses]
  )

  const handleSearch = (e: React.FormEvent): void => {
    e.preventDefault()
    performSearch(1)
  }

  const handlePrevPage = (): void => {
    const prev = Math.max(1, store.currentPage - 1)
    if (prev !== store.currentPage) performSearch(prev)
  }

  const handleNextPage = (): void => {
    if (store.currentPage < store.totalPages) {
      performSearch(store.currentPage + 1)
    }
  }

  const handleGalleryClick = (id: number): void => {
    setSelectedGalleryId(id)
  }

  const handleRetry = (): void => {
    performSearch(store.currentPage || 1)
  }

  const handleTagClick = (tagType: string, tagName: string): void => {
    setSelectedGalleryId(null)

    let query: string
    switch (tagType) {
      case 'artist':
        query = `artist:"${tagName}"`
        break
      case 'group':
        query = `group:"${tagName}"`
        break
      case 'parody':
        query = `parody:"${tagName}"`
        break
      case 'character':
        query = `character:"${tagName}"`
        break
      default:
        query = `"${tagName}"`
        break
    }

    store.setQuery(query)
    // Scroll to top of results
    resultsContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    // Pass query explicitly to avoid stale closure
    performSearch(1, query)
  }

  const refreshSingleDownloadStatus = useCallback(
    async (galleryId: number): Promise<void> => {
      try {
        const statuses = await resolveDownloadStatuses([galleryId])
        const status = statuses.get(galleryId)
        if (status) {
          store.downloadStatuses[galleryId] = status
        }
      } catch {
        // Silently ignore
      }
    },
    [resolveDownloadStatuses]
  )

  const handleDownload = useCallback(
    async (galleryId: number): Promise<void> => {
      try {
        await window.api.downloads.addToQueue(galleryId)
        await refreshSingleDownloadStatus(galleryId)
      } catch {
        // Silently ignore
      }
    },
    [refreshSingleDownloadStatus]
  )

  // C4: Listen for download progress events from main process to refresh statuses
  useEffect(() => {
    const cleanup = window.api.onDownloadProgress(async (progress) => {
      // On download completion, re-check library for accurate status
      if (progress.status === 'completed' && progress.galleryId) {
        const libResult = await window.api.library.getByGalleryId(progress.galleryId)
        if (libResult.success && libResult.data) {
          store.downloadStatuses[progress.galleryId] = 'in_library'
        }
      } else if (progress.galleryId) {
        const st = progress.status
        let dlStatus: DownloadStatus = 'not_downloaded'
        if (st === 'downloading' || st === 'converting') dlStatus = 'downloading'
        else if (st === 'queued') dlStatus = 'queued'
        else if (st === 'failed') dlStatus = 'failed'
        store.downloadStatuses[progress.galleryId] = dlStatus
      }
    })
    return () => { cleanup() }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const hasResults = store.results.length > 0
  const hasMultiplePages = store.totalPages > 1

  return (
    <div className="flex flex-col h-full">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Search</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Search nhentai for doujinshi to download
        </p>
      </div>

      {/* Search bar */}
      <form onSubmit={handleSearch} className="flex gap-2 mb-4">
        <input
          type="text"
          value={store.query}
          onChange={(e) => store.setQuery(e.target.value)}
          placeholder="Search by title, artist, or tags..."
          className="flex-1 px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
        />
        <select
          value={store.sort}
          onChange={(e) => store.setSort(e.target.value)}
          className="px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-1 focus:ring-purple-500"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={store.loading}
          className="px-6 py-2.5 rounded-lg bg-purple-600 text-white font-medium hover:bg-purple-700 disabled:opacity-50 transition-colors"
        >
          {store.loading ? 'Searching...' : 'Search'}
        </button>
      </form>

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
      <div ref={resultsContainerRef} className="flex-1 overflow-y-auto">
        {store.loading && !hasResults && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            <LoadingSkeleton count={12} variant="card" />
          </div>
        )}

        {store.error && !hasResults && !store.loading && (
          <ErrorState message={store.error} onRetry={handleRetry} />
        )}

        {!store.loading && !store.error && !hasResults && store.totalPages === 0 && store.query.trim() === '' && (
          <div className="flex-1 flex items-center justify-center border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl">
            <div className="text-center text-gray-400 dark:text-gray-500">
              <span className="text-5xl block mb-3">🔍</span>
              <p className="text-lg font-medium">Search results will appear here</p>
              <p className="text-sm mt-1">Enter a search query to find doujinshi on nhentai</p>
            </div>
          </div>
        )}

        {!store.loading && !store.error && store.totalPages === 0 && store.query.trim() !== '' && (
          <EmptyState
            icon="🔍"
            title="No results found"
            description="Try adjusting your search query"
          />
        )}

        {hasResults && (
          <div className="space-y-6">
            <GalleryGrid
              galleries={store.results.map((g) => ({
                gallery: g,
                downloadStatus: (store.downloadStatuses[g.id] as DownloadStatus) ?? 'not_downloaded'
              }))}
              onGalleryClick={handleGalleryClick}
            />

            {hasMultiplePages && (
              <div className="flex items-center justify-center gap-2 pb-4">
                <button
                  onClick={handlePrevPage}
                  disabled={store.currentPage <= 1 || store.loading}
                  className="px-3 py-1.5 rounded text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  ← Prev
                </button>
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  Page {store.currentPage} of {store.totalPages}
                </span>
                <button
                  onClick={handleNextPage}
                  disabled={store.currentPage >= store.totalPages || store.loading}
                  className="px-3 py-1.5 rounded text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Next →
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Gallery Detail Overlay */}
      {selectedGalleryId !== null && (
        <GalleryDetail
          galleryId={selectedGalleryId}
          onClose={() => setSelectedGalleryId(null)}
          onDownload={handleDownload}
          onTagClick={handleTagClick}
          onGalleryChange={(id) => setSelectedGalleryId(id)}
        />
      )}
    </div>
  )
}
