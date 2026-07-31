import { create } from 'zustand'
import type { GalleryListItem, DownloadStatus } from '../types/api.types'
import { UNOWNED, type LibraryFacts } from '../components/shared/library-facts'

/**
 * The store holds `LibraryFacts` rather than a bare `DownloadStatus`.
 *
 * Search already looked every result up in the library to work out its download
 * status, then discarded the rest of the row. The cards now show artist,
 * language and format from that same lookup, so the facts have to survive as far
 * as the grid — carrying only the status was what forced the three card designs
 * apart in the first place.
 *
 * `setDownloadStatus` remains, because several call sites know a new status
 * without having re-read the row (a download starting, for one). It merges into
 * whatever facts are already held instead of replacing them.
 */
interface SearchStore {
  query: string
  sort: string
  results: GalleryListItem[]
  libraryFacts: Record<number, LibraryFacts>
  currentPage: number
  totalPages: number
  loading: boolean
  loadingMore: boolean
  error: string | null
  rateLimited: boolean
  rateLimitSeconds: number
  pendingGalleryId: number | null

  setQuery: (query: string) => void
  setPendingGalleryId: (id: number | null) => void
  setSort: (sort: string) => void
  setResults: (
    results: GalleryListItem[],
    facts: Record<number, LibraryFacts>,
    currentPage: number,
    totalPages: number
  ) => void
  appendResults: (
    results: GalleryListItem[],
    facts: Record<number, LibraryFacts>,
    currentPage: number
  ) => void
  /** Update one gallery's status, keeping any facts already known about it. */
  setDownloadStatus: (galleryId: number, status: DownloadStatus) => void
  /** Merge a page's worth of freshly resolved facts. */
  mergeLibraryFacts: (facts: Record<number, LibraryFacts>) => void
  setLoading: (loading: boolean) => void
  setLoadingMore: (loadingMore: boolean) => void
  setError: (error: string | null) => void
  setRateLimited: (seconds: number) => void
  decrementRateLimit: () => void
  clearRateLimited: () => void
  clear: () => void
}

/** True when two fact records would render identically. */
function sameFacts(a: LibraryFacts | undefined, b: LibraryFacts): boolean {
  return (
    a !== undefined &&
    a.status === b.status &&
    a.format === b.format &&
    a.artist === b.artist &&
    a.language === b.language
  )
}

export const useSearchStore = create<SearchStore>()((set) => ({
  query: '',
  sort: '',
  results: [],
  libraryFacts: {},
  currentPage: 0,
  totalPages: 0,
  loading: false,
  loadingMore: false,
  error: null,
  rateLimited: false,
  rateLimitSeconds: 0,
  pendingGalleryId: null,

  setQuery: (query) => set({ query }),
  setSort: (sort) => set({ sort }),
  setPendingGalleryId: (id) => set({ pendingGalleryId: id }),

  setResults: (results, facts, currentPage, totalPages) =>
    set({
      results,
      libraryFacts: facts,
      currentPage,
      totalPages,
      loading: false,
      loadingMore: false,
      error: null,
      rateLimited: false
    }),

  appendResults: (results, facts, currentPage) =>
    set((state) => ({
      results: [...state.results, ...results],
      libraryFacts: { ...state.libraryFacts, ...facts },
      currentPage,
      loading: false,
      loadingMore: false,
      error: null
    })),

  // Callers previously assigned into the store directly, which zustand cannot
  // observe — badges never refreshed until an unrelated re-render happened.
  setDownloadStatus: (galleryId, status) =>
    set((state) => {
      const current = state.libraryFacts[galleryId] ?? UNOWNED
      if (current.status === status) return state
      return {
        libraryFacts: {
          ...state.libraryFacts,
          [galleryId]: { ...current, status }
        }
      }
    }),

  mergeLibraryFacts: (facts) =>
    set((state) => {
      let changed = false
      for (const [id, next] of Object.entries(facts)) {
        if (!sameFacts(state.libraryFacts[Number(id)], next)) {
          changed = true
          break
        }
      }
      if (!changed) return state
      return { libraryFacts: { ...state.libraryFacts, ...facts } }
    }),

  setLoading: (loading) => set({ loading, error: null, rateLimited: false }),
  setLoadingMore: (loadingMore) => set({ loadingMore }),

  setError: (error) =>
    set({
      error,
      loading: false,
      loadingMore: false
    }),

  setRateLimited: (seconds) =>
    set({
      rateLimited: true,
      rateLimitSeconds: seconds,
      loading: false,
      loadingMore: false
    }),

  decrementRateLimit: () =>
    set((state) => {
      const next = state.rateLimitSeconds - 1
      if (next <= 0) {
        return { rateLimited: false, rateLimitSeconds: 0 }
      }
      return { rateLimitSeconds: next }
    }),

  clearRateLimited: () => set({ rateLimited: false, rateLimitSeconds: 0 }),

  clear: () =>
    set({
      query: '',
      results: [],
      libraryFacts: {},
      currentPage: 0,
      totalPages: 0,
      error: null,
      rateLimited: false
    })
}))
