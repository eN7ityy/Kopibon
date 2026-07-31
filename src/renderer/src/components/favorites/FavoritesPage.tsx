import { useState, useEffect, useCallback } from 'react'
import type { GalleryListItem, DownloadStatus } from '../../types/api.types'
import GalleryGrid from '../search/GalleryGrid'
import GalleryDetail from '../gallery/GalleryDetail'
import LoadingSkeleton from '../shared/LoadingSkeleton'
import EmptyState from '../shared/EmptyState'
import ErrorState from '../shared/ErrorState'
import Pagination from '../shared/Pagination'
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
  const [pageState, setPageState] = useState<PageState>({ status: 'loading' })
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [downloadStatuses, setDownloadStatuses] = useState<Record<number, DownloadStatus>>({})
  const [selectedGalleryId, setSelectedGalleryId] = useState<number | null>(null)

  const resolveDownloadStatuses = useCallback(
    async (ids: number[]): Promise<Record<number, DownloadStatus>> => {
      const statuses: Record<number, DownloadStatus> = {}
      await Promise.all(
        ids.map(async (id) => {
          try {
            const libResult = await window.api.library.getByGalleryId(id)
            if (libResult.success && libResult.data) {
              statuses[id] = libResult.data.isCustom === 2 ? 'downloading' : 'in_library'
            } else {
              statuses[id] = 'not_downloaded'
            }
          } catch {
            statuses[id] = 'not_downloaded'
          }
        })
      )
      return statuses
    },
    []
  )

  const fetchFavorites = useCallback(async (p: number, q?: string): Promise<void> => {
    setPageState({ status: 'loading' })
    try {
      const result = await window.api.getFavorites(p, q || undefined)
      if (result.success) {
        if (result.data.result.length === 0) {
          setPageState({ status: 'empty' })
        } else {
          const ids = result.data.result.map((r) => r.id)
          const statuses = await resolveDownloadStatuses(ids)
          setDownloadStatuses(statuses)
          setPageState({ status: 'loaded', data: result.data })
        }
      } else {
        setPageState({ status: 'error', error: result.error || 'Failed to load favorites' })
      }
    } catch (err) {
      setPageState({ status: 'error', error: String(err) })
    }
  }, [resolveDownloadStatuses])

  useEffect(() => {
    fetchFavorites(page, query || undefined)
  }, [page, query, fetchFavorites])

  useEffect(() => {
    if (pageState.status !== 'loaded') return
    const interval = setInterval(async () => {
      const ids = pageState.data.result.map((r) => r.id)
      const statuses = await resolveDownloadStatuses(ids)
      setDownloadStatuses(statuses)
    }, 2000)
    return () => clearInterval(interval)
  }, [pageState.status, resolveDownloadStatuses])

  /**
   * Submit the search box. An emptied box resets to the full favourites list.
   *
   * The trim matters: submitting whitespace would otherwise set a query that is
   * falsy-but-changed, refetching without filtering while still rendering the
   * "clear" affordance as though a search were active. Refetching explicitly
   * rather than relying on the state change also makes an empty submit work when
   * the query is already empty, so the button never looks inert.
   */
  const handleSearch = (e: React.FormEvent): void => {
    e.preventDefault()
    const next = searchInput.trim()
    setQuery(next)
    setPage(1)
    if (next === query && page === 1) fetchFavorites(1, next || undefined)
  }

  const handleGalleryClick = (id: number): void => {
    setSelectedGalleryId(id)
  }

  const handleTagClick = (_tagType: string, _tagName: string): void => {
    setSelectedGalleryId(null)
  }

  const handleDownload = useCallback(
    async (galleryId: number, format?: string): Promise<void> => {
      try {
        await window.api.downloads.addToQueue(galleryId, format)
        const statuses = await resolveDownloadStatuses([galleryId])
        setDownloadStatuses((prev) => ({ ...prev, ...statuses }))
      } catch {
        // silently ignore
      }
    },
    [resolveDownloadStatuses]
  )

  // One header, outside the state switch.
  //
  // It was previously repeated in all four branches, and had already drifted:
  // the error branch was missing the description the other three had. Rendering
  // it once means a change lands everywhere, and the search form no longer
  // disappears while a page loads.
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
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('')
              setSearchInput('')
              setPage(1)
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
        <ErrorState message={pageState.error} onRetry={() => fetchFavorites(page, query || undefined)} />
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
          description={query ? 'No favorites match your search query.' : 'Favorite some galleries on nhentai.net to see them here.'}
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
            downloadStatus: downloadStatuses[g.id] ?? 'not_downloaded'
          }))}
          onGalleryClick={handleGalleryClick}
        />

        {pageState.data.num_pages > 1 && (
          <div className="mt-6">
            <Pagination
              page={page}
              totalPages={pageState.data.num_pages}
              onChange={setPage}
            />
          </div>
        )}
      </div>

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
