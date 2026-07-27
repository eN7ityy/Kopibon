import { useState, useEffect, useCallback, useRef } from 'react'
import type { SearchResult, DownloadStatus } from '../../types/api.types'
import {
  SORT_OPTIONS,
  LANGUAGE_OPTIONS,
  CATEGORY_OPTIONS
} from '../../types/api.types'
import GalleryGrid from './GalleryGrid'
import LoadingSkeleton from '../shared/LoadingSkeleton'
import EmptyState from '../shared/EmptyState'
import ErrorState from '../shared/ErrorState'

interface SearchState {
  results: SearchResult[]
  downloadStatuses: Map<number, DownloadStatus>
  currentPage: number
  totalPages: number
  loading: boolean
  loadingMore: boolean
  error: string | null
  rateLimited: boolean
  rateLimitSeconds: number
}

export default function SearchPage(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [sort, setSort] = useState<string>('')
  const [language, setLanguage] = useState<string>('')
  const [category, setCategory] = useState<string>('')

  const [state, setState] = useState<SearchState>({
    results: [],
    downloadStatuses: new Map(),
    currentPage: 0,
    totalPages: 0,
    loading: false,
    loadingMore: false,
    error: null,
    rateLimited: false,
    rateLimitSeconds: 0
  })

  const rateLimitTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Cleanup rate limit timer on unmount
  useEffect(() => {
    return () => {
      if (rateLimitTimerRef.current) clearInterval(rateLimitTimerRef.current)
    }
  }, [])

  // Rate limit countdown effect
  useEffect(() => {
    if (state.rateLimited && state.rateLimitSeconds > 0) {
      rateLimitTimerRef.current = setInterval(() => {
        setState((prev) => {
          const next = prev.rateLimitSeconds - 1
          if (next <= 0) {
            if (rateLimitTimerRef.current) clearInterval(rateLimitTimerRef.current)
            return { ...prev, rateLimited: false, rateLimitSeconds: 0 }
          }
          return { ...prev, rateLimitSeconds: next }
        })
      }, 1000)
    }
    return () => {
      if (rateLimitTimerRef.current) clearInterval(rateLimitTimerRef.current)
    }
  }, [state.rateLimited])

  const resolveDownloadStatuses = useCallback(
    async (results: SearchResult[]): Promise<Map<number, DownloadStatus>> => {
      const statuses = new Map<number, DownloadStatus>()

      await Promise.all(
        results.map(async (r) => {
          try {
            // Check if in library
            const libResult = await window.api.library.getByGalleryId(r.id)
            if (libResult.success && libResult.data) {
              statuses.set(r.id, 'in_library')
              return
            }

            // Check download queue
            const dlResult = await window.api.downloads.getByGalleryId(r.id)
            if (dlResult.success && dlResult.data) {
              const dlStatus = dlResult.data.status
              if (dlStatus === 'downloading') {
                statuses.set(r.id, 'downloading')
              } else if (dlStatus === 'queued') {
                statuses.set(r.id, 'queued')
              } else if (dlStatus === 'completed') {
                statuses.set(r.id, 'completed')
              } else if (dlStatus === 'failed') {
                statuses.set(r.id, 'failed')
              } else {
                statuses.set(r.id, 'not_downloaded')
              }
              return
            }

            statuses.set(r.id, 'not_downloaded')
          } catch {
            statuses.set(r.id, 'not_downloaded')
          }
        })
      )

      return statuses
    },
    []
  )

  const performSearch = useCallback(
    async (page: number, append = false) => {
      const trimmedQuery = query.trim()
      if (!trimmedQuery) return

      if (page === 1) {
        setState((prev) => ({ ...prev, loading: true, error: null, rateLimited: false }))
      } else {
        setState((prev) => ({ ...prev, loadingMore: true, error: null }))
      }

      try {
        const result = await window.api.search(trimmedQuery, {
          page,
          sort: sort || undefined,
          language: language || undefined,
          category: category || undefined
        })

        if (result.success && result.data) {
          const data = result.data
          const newResults = append
            ? [...state.results, ...data.result]
            : data.result

          const statuses = await resolveDownloadStatuses(newResults)

          setState((prev) => ({
            ...prev,
            results: newResults,
            downloadStatuses: statuses,
            currentPage: data.num_pages > 0 ? page : 0,
            totalPages: data.num_pages,
            loading: false,
            loadingMore: false,
            error: null,
            rateLimited: false
          }))
        } else {
          const errorMsg = result.error || 'Search failed'
          // Check if it's a rate limit error
          if (errorMsg.includes('429') || errorMsg.toLowerCase().includes('rate')) {
            setState((prev) => ({
              ...prev,
              loading: false,
              loadingMore: false,
              error: errorMsg,
              rateLimited: true,
              rateLimitSeconds: 60
            }))
          } else {
            setState((prev) => ({
              ...prev,
              loading: false,
              loadingMore: false,
              error: errorMsg
            }))
          }
        }
      } catch (err) {
        setState((prev) => ({
          ...prev,
          loading: false,
          loadingMore: false,
          error: err instanceof Error ? err.message : 'Search failed'
        }))
      }
    },
    [query, sort, language, category, state.results, resolveDownloadStatuses]
  )

  const handleSearch = (e: React.FormEvent): void => {
    e.preventDefault()
    performSearch(1, false)
  }

  const handleLoadMore = (): void => {
    if (!state.loadingMore && state.currentPage < state.totalPages) {
      performSearch(state.currentPage + 1, true)
    }
  }

  const handleGalleryClick = (id: number): void => {
    // Will be implemented in P2.2 — navigate to gallery detail
    // For now, open in browser
    window.api.shell.openExternal(`https://nhentai.net/g/${id}`)
  }

  const handleRetry = (): void => {
    performSearch(state.currentPage || 1, false)
  }

  const hasResults = state.results.length > 0
  const hasMorePages = state.currentPage < state.totalPages
  const showLoadMore = hasResults && hasMorePages && !state.loading && !state.loadingMore

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
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
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by title, artist, or tags..."
          className="flex-1 px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
        />
        <button
          type="button"
          onClick={() => setShowFilters(!showFilters)}
          className="px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          title="Filters"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
          </svg>
        </button>
        <button
          type="submit"
          disabled={state.loading}
          className="px-6 py-2.5 rounded-lg bg-purple-600 text-white font-medium hover:bg-purple-700 disabled:opacity-50 transition-colors"
        >
          {state.loading ? 'Searching...' : 'Search'}
        </button>
      </form>

      {/* Filter bar */}
      {showFilters && (
        <div className="mb-4 p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              Sort
            </label>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-1 focus:ring-purple-500"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value === 'recent' ? '' : opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              Language
            </label>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-1 focus:ring-purple-500"
            >
              {LANGUAGE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              Category
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-1 focus:ring-purple-500"
            >
              {CATEGORY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Rate limit overlay */}
      {state.rateLimited && (
        <div className="mb-4 p-3 rounded-lg bg-orange-100 dark:bg-orange-900/30 border border-orange-300 dark:border-orange-700 flex items-center gap-3">
          <span className="text-xl">⏱️</span>
          <div className="flex-1">
            <p className="text-sm font-medium text-orange-800 dark:text-orange-300">
              Rate Limited
            </p>
            <p className="text-xs text-orange-600 dark:text-orange-400">
              Retrying in {state.rateLimitSeconds}s...
            </p>
          </div>
        </div>
      )}

      {/* Content area */}
      <div className="flex-1 overflow-y-auto">
        {/* Loading skeleton */}
        {state.loading && !hasResults && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            <LoadingSkeleton count={12} variant="card" />
          </div>
        )}

        {/* Error state */}
        {state.error && !hasResults && !state.loading && (
          <ErrorState message={state.error} onRetry={handleRetry} />
        )}

        {/* Empty state */}
        {!state.loading && !state.error && hasResults === false && state.currentPage === 0 && query.trim() === '' && (
          <div className="flex-1 flex items-center justify-center border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl">
            <div className="text-center text-gray-400 dark:text-gray-500">
              <span className="text-5xl block mb-3">🔍</span>
              <p className="text-lg font-medium">Search results will appear here</p>
              <p className="text-sm mt-1">Enter a search query to find doujinshi on nhentai</p>
            </div>
          </div>
        )}

        {/* No results */}
        {!state.loading && !state.error && state.currentPage === 0 && query.trim() !== '' && (
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
              galleries={state.results.map((g) => ({
                gallery: g,
                downloadStatus: state.downloadStatuses.get(g.id) ?? 'not_downloaded'
              }))}
              onGalleryClick={handleGalleryClick}
            />

            {/* Load More */}
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

            {/* Loading more indicator */}
            {state.loadingMore && (
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
