import { useEffect, useCallback, useRef, useState } from 'react'
import type { DownloadStatus, GalleryListItem } from '../../types/api.types'
import { SORT_OPTIONS } from '../../types/api.types'
import { useSearchStore } from '../../stores/search.store'
import { useSearchHistoryStore } from '../../stores/search-history.store'
import GalleryGrid from './GalleryGrid'
import SearchBox from './SearchBox'
import { resolveLibraryFacts } from '../shared/library-facts'
import GalleryDetail from '../gallery/GalleryDetail'
import LoadingSkeleton from '../shared/LoadingSkeleton'
import EmptyState from '../shared/EmptyState'
import ErrorState from '../shared/ErrorState'
import Pagination from '../shared/Pagination'
import { Search } from 'lucide-react'

/**
 * Per-result marking, keyed by gallery id.
 *
 * Named at module scope rather than inferred from the state via `typeof marks`:
 * referencing the state variable inside the memoised callback below made it a
 * dependency and broke the memoisation.
 */
type GalleryMarkMap = Record<
  number,
  {
    matches: Array<{ type: string; value: string }>
    blacklisted: boolean
    /** Matches a `exclude` entry. Only meaningful on the browse views. */
    excluded: boolean
  }
>

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

  /**
   * Which results are marked, and why.
   *
   * Kept local rather than in the store: it is derived from the blocked list
   * plus the current page, and nothing outside this view needs it.
   */
  const [marks, setMarks] = useState<GalleryMarkMap>({})
  /** Set once the stored defaults have been read, so the first load waits for them. */
  const [defaultsReady, setDefaultsReady] = useState(false)
  const defaultQueryRef = useRef<string>('')
  const [selectedGalleryId, setSelectedGalleryId] = useState<number | null>(null)
  const resultsContainerRef = useRef<HTMLDivElement>(null)
  /**
   * Read once with the other defaults rather than through a second IPC round
   * trip. A ref, not state: recording a search never needs to re-render
   * anything, it only needs the current value at the moment of submission.
   */
  const rememberRecentRef = useRef(false)

  // When navigated to from Library nhentai ID click, auto-open GalleryDetail
  useEffect(() => {
    if (store.pendingGalleryId !== null) {
      setSelectedGalleryId(store.pendingGalleryId)
      store.setPendingGalleryId(null)
    }
  }, [store.pendingGalleryId])

  /**
   * Ask main which of these results match a `dim` entry.
   *
   * Runs after the results are shown rather than before: tag resolution can need
   * several requests on a cold cache, and blocking the grid on it would make
   * search feel slow to save a visual cue.
   */
  const evaluateMarks = useCallback(
    async (galleries: Array<{ id: number; english_title?: string; japanese_title?: string | null; tag_ids?: number[]; blacklisted?: boolean }>) => {
      if (galleries.length === 0) {
        setMarks({})
        return
      }
      try {
        const r = await window.api.searchSettings.evaluateResults(
          galleries.map((g) => ({
            id: g.id,
            title: g.english_title || g.japanese_title || '',
            tag_ids: g.tag_ids,
            blacklisted: g.blacklisted
          }))
        )
        if (r.success && r.data) setMarks(r.data as GalleryMarkMap)
      } catch {
        /* an unmarked result is the safe fallback */
      }
    },
    []
  )

  /**
   * Evaluate a browse page and drop anything a `exclude` entry matches.
   *
   * Only the /search endpoint takes a query, so the negations that hide galleries
   * cannot be applied to latest or popular — those accept no query at all. On
   * those views the exclusion has to be applied to the results instead.
   *
   * Unlike the search path this is awaited before the results are shown: letting
   * a hidden gallery appear and then vanish is worse than a slightly slower load.
   */
  const filterBrowseResults = useCallback(
    async (galleries: GalleryListItem[]): Promise<GalleryListItem[]> => {
      if (galleries.length === 0) {
        setMarks({})
        return galleries
      }
      try {
        const r = await window.api.searchSettings.evaluateResults(
          galleries.map((g) => ({
            id: g.id,
            title: g.english_title || g.japanese_title || '',
            tag_ids: g.tag_ids,
            blacklisted: g.blacklisted
          }))
        )
        if (!r.success || !r.data) return galleries
        const evaluated = r.data as GalleryMarkMap
        setMarks(evaluated)
        return galleries.filter((g) => !evaluated[g.id]?.excluded)
      } catch {
        // Showing everything is the safe failure: it never hides something the
        // user wanted to see.
        return galleries
      }
    },
    []
  )

  /**
   * Read the stored search defaults before the first load.
   *
   * The default sort goes into the store so the sort control shows it, and the
   * default query is remembered for the initial load below. Nothing is fetched
   * here — this only settles what the first request should be.
   */
  useEffect(() => {
    let cancelled = false
    window.api.searchSettings
      .get()
      .then((r) => {
        if (cancelled || !r.success || !r.data) {
          if (!cancelled) setDefaultsReady(true)
          return
        }
        const settings = r.data as {
          sort?: string | null
          defaultQuery?: string | null
          rememberRecentSearches?: boolean
        }
        defaultQueryRef.current = (settings.defaultQuery ?? '').trim()
        rememberRecentRef.current = settings.rememberRecentSearches ?? false
        if (settings.sort) useSearchStore.getState().setSort(settings.sort)
        setDefaultsReady(true)
      })
      .catch(() => {
        // Without settings the tab still works, it just has no defaults.
        if (!cancelled) setDefaultsReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // First load: the default search if one is configured, otherwise latest uploads.
  useEffect(() => {
    if (!defaultsReady) return

    const loadInitial = async () => {
      const configured = defaultQueryRef.current
      if (configured) {
        // Seed the box so it is obvious why these results are showing, and so
        // clearing it gets you back to plain latest uploads.
        useSearchStore.getState().setQuery(configured)
        await performSearch(1, configured)
        return
      }

      store.setLoading(true)
      try {
        const result = await window.api.getLatest(1)
        if (result.success && result.data) {
          const visible = await filterBrowseResults(result.data.result)
          const facts = await resolveLibraryFacts(visible.map((r) => r.id))
          store.setResults(visible, facts, 1, result.data.num_pages)
        }
      } catch {
        // silently ignore
      }
    }

    if (store.results.length === 0 && !store.query.trim()) {
      void loadInitial()
    }
    // `defaultsReady` has to be a dependency: with an empty array this ran once
    // while it was still false, returned early, and never ran again — leaving
    // Search permanently empty. The other values are deliberately not
    // dependencies, since this is a first-load effect and re-running it on every
    // store change would refetch continuously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultsReady])

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

  // Refresh facts on mount + poll every 2s for real-time updates
  useEffect(() => {
    const refreshStatuses = async () => {
      if (store.results.length === 0) return
      const ids = store.results.map((r) => r.id)
      const facts = await resolveLibraryFacts(ids)
      useSearchStore.getState().mergeLibraryFacts(facts)
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




  const performSearch = useCallback(
    async (page: number, overrideQuery?: string) => {
      const trimmedQuery = (overrideQuery ?? store.query).trim()
      if (!trimmedQuery) return

      store.setLoading(true)
      resultsContainerRef.current?.scrollTo(0, 0)

      try {
        // Composed in main, so the search defaults and every `exclude` entry are
        // applied without this view knowing the query syntax.
        const composed = await window.api.searchSettings.buildQuery(trimmedQuery)
        const effectiveQuery = composed.success && composed.data?.query ? composed.data.query : trimmedQuery

        const result = await window.api.search(effectiveQuery, {
          page,
          sort: store.sort || undefined
        })

        if (result.success && result.data) {
          const data = result.data
          const facts = await resolveLibraryFacts(data.result.map((r) => r.id))
          store.setResults(data.result, facts, page > 0 ? page : 0, data.num_pages)
          void evaluateMarks(data.result)
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
    [store.query, store.sort, evaluateMarks]
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
          const visible = await filterBrowseResults(data.result)
          const facts = await resolveLibraryFacts(visible.map((r) => r.id))
          store.setResults(visible, facts, isPopular ? 1 : page, data.num_pages)
        }
      } catch {
        store.setError('Failed to load')
      }
    },
    [store.query, store.sort, performSearch, filterBrowseResults]
  )

  /**
   * Record a submitted query to recent-searches history, if the user has
   * opted in. An empty query is never recorded — there is nothing there to
   * show back to them later.
   */
  const recordIfEnabled = useCallback((query: string): void => {
    if (rememberRecentRef.current && query.trim()) {
      useSearchHistoryStore.getState().recordSearch(query)
    }
  }, [])

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
    recordIfEnabled(store.query)
    performSearch(1)
  }

  /** A recent/favourite row from the search box's dropdown: run it as-is. */
  const handleRunStoredQuery = (query: string): void => {
    recordIfEnabled(query)
    performSearch(1, query)
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
    recordIfEnabled(query)
    // Pass query explicitly to avoid stale closure
    performSearch(1, query)
  }

  const refreshSingleDownloadStatus = useCallback(
    async (galleryId: number): Promise<void> => {
      try {
        // Merge the whole record, not just the status: this lookup returns the
        // format, artist and language too, so a card gains its metadata the
        // moment a download finishes rather than waiting for the next poll.
        const facts = await resolveLibraryFacts([galleryId])
        useSearchStore.getState().mergeLibraryFacts(facts)
      } catch {
        // Silently ignore
      }
    },
    []
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

  // C4: Listen for download progress events from main process to refresh facts
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
        <h1 className="text-2xl font-bold tracking-tight text-fg">Search</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Search nhentai for doujinshi to download
        </p>
      </div>

      {/* Search bar */}
      <form onSubmit={handleSearch} className="flex gap-2 mb-4">
        <SearchBox
          value={store.query}
          onChange={store.setQuery}
          onRunSearch={handleRunStoredQuery}
          placeholder="Search by title, artist, or tags..."
          className="flex-1"
        />
        <select
          value={store.sort}
          onChange={(e) => store.setSort(e.target.value)}
          className="px-3 py-2.5 rounded-lg border border-line bg-surface text-fg text-sm focus:outline-none focus:ring-1 focus:ring-accent"
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
          className="px-6 py-2.5 rounded-lg bg-accent-fill text-white font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors"
        >
          {store.loading ? 'Searching...' : 'Search'}
        </button>
      </form>

      {/* Rate limit overlay */}
      {store.rateLimited && (
        <div className="mb-4 p-3 rounded-lg bg-warning-wash border border-warning flex items-center gap-3">
          <span className="text-xl">⏱️</span>
          <div className="flex-1">
            <p className="text-sm font-medium text-warning">Rate Limited</p>
            <p className="text-xs text-warning">
              Retrying in {store.rateLimitSeconds}s...
            </p>
          </div>
        </div>
      )}

      {/* F7: Entity search banner */}
      {entityBanner && hasResults && (
        <div className="mb-4 p-3 rounded-lg bg-accent-wash border border-accent flex items-center justify-between">
          <p className="text-sm text-accent">
            Showing works by{' '}
            <strong className="font-semibold">{entityBanner.name}</strong>
          </p>
          <button
            onClick={() => window.api.shell.openExternal(entityBanner.nhentaiUrl)}
            className="text-xs text-accent hover:text-accent underline transition-colors"
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
          <div className="flex-1 flex items-center justify-center border-2 border-dashed border-line rounded-xl">
            <div className="text-center text-fg-faint">
              <Search size={40} strokeWidth={1.5} className="mx-auto mb-3 text-fg-faint" aria-hidden="true" />
              <p className="text-lg font-medium">Search results will appear here</p>
              <p className="text-sm mt-1">Enter a search query to find doujinshi on nhentai</p>
            </div>
          </div>
        )}

        {!store.loading && !store.error && store.totalPages === 0 && store.query.trim() !== '' && (
          <EmptyState
            icon={Search}
            title="No results found"
            description="Try adjusting your search query"
          />
        )}

        {hasResults && (
          <div className="space-y-6">
            <GalleryGrid
              galleries={store.results.map((g) => ({
                gallery: g,
                facts: store.libraryFacts[g.id],
                mark: marks[g.id]
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
