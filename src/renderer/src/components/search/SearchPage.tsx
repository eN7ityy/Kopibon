import { useEffect, useCallback, useRef, useState } from 'react'
import type { DownloadStatus } from '../../types/api.types'
import { SORT_OPTIONS } from '../../types/api.types'
import { useSearchStore } from '../../stores/search.store'
import GalleryGrid from './GalleryGrid'
import GalleryDetail from '../gallery/GalleryDetail'
import LoadingSkeleton from '../shared/LoadingSkeleton'
import EmptyState from '../shared/EmptyState'
import ErrorState from '../shared/ErrorState'
import Pagination from '../shared/Pagination'

interface EntityBanner {
  type: string
  name: string
  nhentaiUrl: string
}

function parseEntitySearch(query: string): EntityBanner | null {
  const match = query.trim().match(/^(artist|group|parody|character):"(.+)"$/)
  if (!match) return null

  const [, type, name] = match
  const slug = name.replace(/\s+/g, '-').toLowerCase()
  const nhentaiUrl = `https://nhentai.net/${type}/${encodeURIComponent(slug)}/`

  return { type, name, nhentaiUrl }
}

export default function SearchPage(): React.JSX.Element {
  const store = useSearchStore()
  const rateLimitTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const prevSortRef = useRef(store.sort)
  const [selectedGalleryId, setSelectedGalleryId] = useState<number | null>(null)
  const resultsContainerRef = useRef<HTMLDivElement>(null)

  // When navigated to from Library nhentai ID click, auto-open GalleryDetail
  useEffect(() => {
    if (store.pendingGalleryId !== null) {
      setSelectedGalleryId(store.pendingGalleryId)
      store.setPendingGalleryId(null)
    }
  }, [store.pendingGalleryId])

  // Auto-load latest uploads on mount (nhentai homepage)
  useEffect(() => {
    const loadLatest = async () => {
      store.setLoading(true)
      try {
        const result = await window.api.getLatest(1)
        if (result.success && result.data) {
          const statuses = await resolveDownloadStatuses(result.data.result.map((r) => r.id))
          store.setResults(result.data.result, statuses, 1, result.data.num_pages)
        }
      } catch {
        // silently ignore
      }
    }
    if (store.results.length === 0 && !store.query.trim()) {
      loadLatest()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
      useSearchStore.getState().mergeDownloadStatuses(statuses)
    }
    refreshStatuses()
    const interval = setInterval(refreshStatuses, 2000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.results])

  // Auto-search when sort changes and query is non-empty
  useEffect(() => {
    if (prevSortRef.current !== store.sort) {
      if (store.query.trim()) {
        performSearch(1)
      } else {
        loadPage(1)
      }
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
      resultsContainerRef.current?.scrollTo(0, 0)

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

  const loadPage = useCallback(
    async (page: number) => {
      if (store.query.trim()) {
        performSearch(page)
        return
      }
      store.setLoading(true)
      resultsContainerRef.current?.scrollTo(0, 0)
      try {
        const isPopular = store.sort === 'popular-today'
        const result = isPopular
          ? await window.api.getPopular()
          : await window.api.getLatest(page)
        if (result.success && result.data) {
          const data = result.data
          const statuses = await resolveDownloadStatuses(data.result.map((r) => r.id))
          store.setResults(data.result, statuses, isPopular ? 1 : page, data.num_pages)
        }
      } catch {
        store.setError('Failed to load')
      }
    },
    [store.query, store.sort, performSearch, resolveDownloadStatuses]
  )

  /**
   * Submit the search box.
   *
   * An empty box means "show me the default listing again". `performSearch`
   * returns early on an empty query, so submitting an emptied field used to do
   * nothing at all — the only way back to the latest uploads was to change the
   * sort and trigger the auto-search. `loadPage` already falls through to
   * latest/popular when the query is empty, so a reset is just page 1 of that.
   */
  const handleSearch = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!store.query.trim()) {
      store.setQuery('')
      loadPage(1)
      return
    }
    performSearch(1)
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
          useSearchStore.getState().setDownloadStatus(galleryId, status)
        }
      } catch {
        // Silently ignore
      }
    },
    [resolveDownloadStatuses]
  )

  const handleDownload = useCallback(
    async (galleryId: number, format?: string): Promise<void> => {
      try {
        await window.api.downloads.addToQueue(galleryId, format)
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
      if (!progress.galleryId) return
      const setStatus = useSearchStore.getState().setDownloadStatus

      // On download completion, re-check library for accurate status
      if (progress.status === 'completed') {
        const libResult = await window.api.library.getByGalleryId(progress.galleryId)
        if (libResult.success && libResult.data) {
          setStatus(progress.galleryId, 'in_library')
        }
        return
      }

      const st = progress.status
      let dlStatus: DownloadStatus = 'not_downloaded'
      if (st === 'downloading' || st === 'converting') dlStatus = 'downloading'
      else if (st === 'queued') dlStatus = 'queued'
      else if (st === 'failed') dlStatus = 'failed'
      setStatus(progress.galleryId, dlStatus)
    })
    return () => { cleanup() }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // F7: Parse entity search from query for banner display
  const entityBanner = parseEntitySearch(store.query)

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

      {/* F7: Entity search banner */}
      {entityBanner && hasResults && (
        <div className="mb-4 p-3 rounded-lg bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 flex items-center justify-between">
          <p className="text-sm text-purple-800 dark:text-purple-300">
            Showing works by{' '}
            <strong className="font-semibold">{entityBanner.name}</strong>
          </p>
          <button
            onClick={() => window.api.shell.openExternal(entityBanner.nhentaiUrl)}
            className="text-xs text-purple-600 dark:text-purple-400 hover:text-purple-800 dark:hover:text-purple-200 underline transition-colors"
          >
            View on nhentai →
          </button>
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
              <Pagination
                page={store.currentPage}
                totalPages={store.totalPages}
                onChange={loadPage}
                disabled={store.loading}
              />
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
