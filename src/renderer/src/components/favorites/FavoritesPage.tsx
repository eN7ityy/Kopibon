import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../stores/auth.store'

interface SearchResult {
  id: number
  media_id: string
  title: {
    english: string
    japanese: string | null
    pretty: string
  }
  images: {
    cover: { t: string; w: number; h: number }
    pages: Array<{ t: string; w: number; h: number }>
    thumbnail: { t: string; w: number; h: number }
  }
  num_pages: number
  num_favorites: number
  upload_date: number
  tags: Array<{
    id: number
    type: string
    name: string
    url: string
  }>
}

interface FavoritesResponse {
  result: SearchResult[]
  num_pages: number
  per_page: number
}

type PageState =
  | { status: 'loading' }
  | { status: 'loaded'; data: FavoritesResponse }
  | { status: 'error'; error: string }
  | { status: 'empty' }

export default function FavoritesPage(): React.JSX.Element {
  const auth = useAuthStore()
  const navigate = useNavigate()
  const [pageState, setPageState] = useState<PageState>({ status: 'loading' })
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [searchInput, setSearchInput] = useState('')

  const fetchFavorites = useCallback(async (p: number, q?: string): Promise<void> => {
    setPageState({ status: 'loading' })
    try {
      const result = await window.api.getFavorites(p, q || undefined)
      if (result.success) {
        if (result.data.result.length === 0) {
          setPageState({ status: 'empty' })
        } else {
          setPageState({ status: 'loaded', data: result.data })
        }
      } else {
        setPageState({ status: 'error', error: result.error || 'Failed to load favorites' })
      }
    } catch (err) {
      setPageState({ status: 'error', error: String(err) })
    }
  }, [])

  useEffect(() => {
    if (!auth.loggedIn) {
      navigate('/search', { replace: true })
      return
    }
    fetchFavorites(page, query || undefined)
  }, [auth.loggedIn, navigate, page, query, fetchFavorites])

  const handleSearch = (e: React.FormEvent): void => {
    e.preventDefault()
    setQuery(searchInput)
    setPage(1)
  }

  const getCoverUrl = (gallery: SearchResult): string => {
    // Use the official nhentai CDN pattern
    const ext = gallery.images.cover.t === 'j' ? 'jpg' : 'png'
    return `https://i.nhentai.net/galleries/${gallery.media_id}/thumb.${ext}`
  }

  const getArtistName = (gallery: SearchResult): string => {
    const artistTag = gallery.tags.find((t) => t.type === 'artist')
    return artistTag?.name ?? 'Unknown'
  }

  const getLanguageBadge = (gallery: SearchResult): string | null => {
    const langTag = gallery.tags.find((t) => t.type === 'language')
    return langTag?.name ?? null
  }

  if (!auth.loaded) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-400 dark:text-gray-500">Loading...</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Favorites</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Browse your nhentai favorites
          {auth.username && (
            <span>
              {' '}
              — logged in as <span className="font-medium">{auth.username}</span>
            </span>
          )}
        </p>
      </div>

      {/* Search within favorites */}
      <form onSubmit={handleSearch} className="flex gap-2 mb-6">
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search your favorites..."
          className="flex-1 px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
        />
        <button
          type="submit"
          className="px-6 py-2.5 rounded-lg bg-purple-600 text-white font-medium hover:bg-purple-700 transition-colors"
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
            className="px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            Clear
          </button>
        )}
      </form>

      {/* Content */}
      {pageState.status === 'loading' && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-gray-400 dark:text-gray-500">
            <span className="text-5xl block mb-3">⏳</span>
            <p className="text-lg font-medium">Loading favorites...</p>
          </div>
        </div>
      )}

      {pageState.status === 'empty' && (
        <div className="flex-1 flex items-center justify-center border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl">
          <div className="text-center text-gray-400 dark:text-gray-500">
            <span className="text-5xl block mb-3">⭐</span>
            <p className="text-lg font-medium">No favorites found</p>
            <p className="text-sm mt-1">
              {query
                ? 'No favorites match your search query.'
                : 'Favorite some galleries on nhentai.net to see them here.'}
            </p>
          </div>
        </div>
      )}

      {pageState.status === 'error' && (
        <div className="flex-1 flex items-center justify-center border-2 border-dashed border-red-300 dark:border-red-700 rounded-xl">
          <div className="text-center text-red-400 dark:text-red-500">
            <span className="text-5xl block mb-3">⚠️</span>
            <p className="text-lg font-medium">Failed to load favorites</p>
            <p className="text-sm mt-1">{pageState.error}</p>
            <button
              onClick={() => fetchFavorites(page, query || undefined)}
              className="mt-4 px-4 py-2 rounded-lg bg-purple-600 text-white font-medium hover:bg-purple-700 transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {pageState.status === 'loaded' && (
        <>
          {/* Gallery Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {pageState.data.result.map((gallery) => (
              <div
                key={gallery.id}
                className="group relative bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden hover:shadow-lg transition-shadow cursor-pointer"
              >
                {/* Cover image */}
                <div className="aspect-[3/4] overflow-hidden bg-gray-100 dark:bg-gray-900">
                  <img
                    src={getCoverUrl(gallery)}
                    alt={gallery.title.pretty}
                    draggable={false}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                    loading="lazy"
                  />
                </div>

                {/* Info overlay at bottom */}
                <div className="p-2.5">
                  <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {gallery.title.pretty}
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">
                    {getArtistName(gallery)}
                  </p>
                  <div className="flex items-center justify-between mt-1.5">
                    <span className="text-xs text-gray-400 dark:text-gray-500">
                      {gallery.num_pages}p
                    </span>
                    <div className="flex items-center gap-1.5">
                      {getLanguageBadge(gallery) && (
                        <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                          {getLanguageBadge(gallery)}
                        </span>
                      )}
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        ★ {gallery.num_favorites}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {pageState.data.num_pages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-6 pb-4">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-3 py-1.5 rounded text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                ← Prev
              </button>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                Page {page} of {pageState.data.num_pages}
              </span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= pageState.data.num_pages}
                className="px-3 py-1.5 rounded text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
