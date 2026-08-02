import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { GalleryListItem } from '../../types/api.types'
import GalleryGrid from '../search/GalleryGrid'
import { resolveLibraryFacts } from '../shared/library-facts'
import GalleryDetail from '../gallery/GalleryDetail'
import LoadingSkeleton from '../shared/LoadingSkeleton'
import EmptyState from '../shared/EmptyState'
import ErrorState from '../shared/ErrorState'
import Pagination from '../shared/Pagination'
import { useFavoritesStore } from '../../stores/favorites.store'
import { Star } from 'lucide-react'

interface FavoritesResponse {
  result: GalleryListItem[]
  num_pages: number
  per_page: number
}

type PageState =
  | { status: 'loading' }
  | { status: 'loaded'; data: FavoritesResponse }
  | { status: 'error'; error: string }
  | { status: 'empty' }

export default function FavoritesPage(): React.JSX.Element {
  const store = useFavoritesStore()
  const [searchInput, setSearchInput] = useState('')

  const loadPage = useCallback(async (p: number, q?: string): Promise<void> => {
    store.setLoading(true)
    try {
      const result = await window.api.getFavorites(p, q || undefined)
      if (result.success) {
        if (result.data.result.length === 0) {
          store.setResults([], 0, result.data.per_page)
        } else {
          const ids = result.data.result.map((r) => r.id)
          const facts = await resolveLibraryFacts(ids)
          store.setLibraryFacts(facts)
          store.setResults(result.data.result, result.data.num_pages, result.data.per_page)
        }
      } else {
        store.setError(result.error || 'Failed to load favorites')
      }
    } catch (err) {
      store.setError(String(err))
    }
  }, [store])

  // Fetch on mount unless the store already holds results for the current
  // query/page — that is a return visit, so show the cache and let the 2s
  // polling refresh the facts in the background.
  useEffect(() => {
    if (store.results.length === 0) {
      loadPage(store.page, store.query || undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fetch when page or query changes from user actions. The ref skips the
  // initial mount run so a return visit never double-fetches.
  const firstRenderRef = useRef(true)
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false
      return
    }
    loadPage(store.page, store.query || undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.page, store.query])

  // 2s polling for library facts. Merges rather than replaces, reads the
  // current results at tick time, and re-arms when the results array changes —
  // so facts for one page can never overwrite (and blank) another page's.
  useEffect(() => {
    const refreshStatuses = async () => {
      const state = useFavoritesStore.getState()
      if (state.results.length === 0) return
      const ids = state.results.map((r) => r.id)
      const facts = await resolveLibraryFacts(ids)
      useFavoritesStore.getState().mergeLibraryFacts(facts)
    }
    refreshStatuses()
    const interval = setInterval(refreshStatuses, 2000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.results])

  const handleSearch = (e: React.FormEvent): void => {
    e.preventDefault()
    const next = searchInput.trim()
    // Submitting the same query on page one would leave the store deps
    // unchanged, so the change-effect below would not fire and the button would
    // look inert. Refetch explicitly in that case, matching the original.
    if (next === store.query && store.page === 1) {
      loadPage(1, next || undefined)
      return
    }
    store.setQuery(next)
    store.setPage(1)
  }

  const handleGalleryClick = (id: number): void => {
    store.setSelectedGalleryId(id)
  }

  const handleTagClick = (_tagType: string, _tagName: string): void => {
    store.setSelectedGalleryId(null)
  }

  const handleDownload = useCallback(
    async (galleryId: number, format?: string): Promise<void> => {
      try {
        await window.api.downloads.addToQueue(galleryId, format)
        const facts = await resolveLibraryFacts([galleryId])
        store.mergeLibraryFacts(facts)
      } catch {
        // silently ignore
      }
    },
    [store]
  )

  // Derive pageState from store for the four-branch render
  const pageState = useMemo<PageState>(() => {
    if (store.loading && store.results.length === 0) return { status: 'loading' }
    if (store.error && store.results.length === 0) return { status: 'error', error: store.error }
    if (!store.loading && store.results.length === 0) return { status: 'empty' }
    return {
      status: 'loaded',
      data: { result: store.results, num_pages: store.numPages, per_page: store.perPage }
    }
  }, [store.loading, store.error, store.results, store.numPages, store.perPage])

  // One header, outside the state switch.
  const header = (
    <div className="mb-4 shrink-0">
      <h1 className="text-2xl font-bold tracking-tight text-fg">Favorites</h1>
      <p className="mt-1 text-sm text-fg-muted">Browse your nhentai favorites</p>
    </div>
  )

  const searchForm = (
    <form onSubmit={handleSearch} className="flex gap-2 mb-4 shrink-0">
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search your favorites..."
          className="flex-1 px-4 py-2.5 rounded-lg border border-line bg-surface text-fg placeholder-fg-faint focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <button
          type="submit"
          className="px-6 py-2.5 rounded-lg bg-accent-fill text-white font-medium hover:bg-accent-hover transition-colors"
        >
          Search
        </button>
        {store.query && (
          <button
            type="button"
            onClick={() => {
              store.setQuery('')
              setSearchInput('')
              store.setPage(1)
            }}
            className="px-4 py-2.5 rounded-lg border border-line text-fg-muted hover:bg-raised transition-colors"
          >
            Clear
          </button>
        )}
      </form>
  )

  if (pageState.status === 'loading') {
    return (
      <div className="flex flex-col h-full">
        {header}
        {searchForm}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          <LoadingSkeleton count={12} variant="card" />
        </div>
      </div>
    )
  }

  if (pageState.status === 'error') {
    return (
      <div className="flex flex-col h-full">
        {header}
        {searchForm}
        <ErrorState message={pageState.error} onRetry={() => loadPage(store.page, store.query || undefined)} />
      </div>
    )
  }

  if (pageState.status === 'empty') {
    return (
      <div className="flex flex-col h-full">
        {header}
        {searchForm}
        <EmptyState
          icon={Star}
          title="No favorites found"
          description={store.query ? 'No favorites match your search query.' : 'Favorite some galleries on nhentai.net to see them here.'}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {header}
      {searchForm}

      <div className="flex-1 overflow-y-auto">
        <GalleryGrid
          galleries={pageState.data.result.map((g) => ({
            gallery: g,
            facts: store.libraryFacts[g.id]
          }))}
          onGalleryClick={handleGalleryClick}
        />

        {pageState.data.num_pages > 1 && (
          <div className="mt-6">
            <Pagination
              page={store.page}
              totalPages={pageState.data.num_pages}
              onChange={(newPage) => store.setPage(newPage)}
            />
          </div>
        )}
      </div>

      {store.selectedGalleryId !== null && (
        <GalleryDetail
          galleryId={store.selectedGalleryId}
          onClose={() => store.setSelectedGalleryId(null)}
          onDownload={handleDownload}
          onTagClick={handleTagClick}
          onGalleryChange={(id) => store.setSelectedGalleryId(id)}
        />
      )}
    </div>
  )
}
