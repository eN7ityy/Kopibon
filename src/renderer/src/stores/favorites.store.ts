import { create } from 'zustand'
import type { GalleryListItem } from '../types/api.types'
import type { LibraryFacts } from '../components/shared/library-facts'

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

interface FavoritesStore {
  query: string
  page: number
  results: GalleryListItem[]
  numPages: number
  perPage: number
  libraryFacts: Record<number, LibraryFacts>
  loading: boolean
  error: string | null
  selectedGalleryId: number | null

  setQuery: (query: string) => void
  setPage: (page: number) => void
  setResults: (results: GalleryListItem[], numPages: number, perPage: number) => void
  setLibraryFacts: (facts: Record<number, LibraryFacts>) => void
  mergeLibraryFacts: (facts: Record<number, LibraryFacts>) => void
  /**
   * Drop one gallery from the loaded list without refetching.
   *
   * Used when a gallery is unfavorited while its detail panel is open: the
   * card should vanish immediately once the API call confirms. The page and
   * scroll position are untouched — only the result array and its facts change.
   */
  removeResult: (galleryId: number) => void
  setSelectedGalleryId: (id: number | null) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  clear: () => void
}

export const useFavoritesStore = create<FavoritesStore>()((set) => ({
  query: '',
  page: 1,
  results: [],
  numPages: 0,
  perPage: 25,
  libraryFacts: {},
  loading: false,
  error: null,
  selectedGalleryId: null,

  setQuery: (query) => set({ query }),
  setPage: (page) => set({ page }),
  setResults: (results, numPages, perPage) =>
    set({ results, numPages, perPage, loading: false, error: null }),
  setLibraryFacts: (facts) => set({ libraryFacts: facts }),
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
  removeResult: (galleryId) =>
    set((state) => {
      const results = state.results.filter((r) => r.id !== galleryId)
      if (results.length === state.results.length && state.selectedGalleryId !== galleryId) {
        return state
      }
      const libraryFacts = { ...state.libraryFacts }
      delete libraryFacts[galleryId]
      return {
        results,
        libraryFacts,
        selectedGalleryId: state.selectedGalleryId === galleryId ? null : state.selectedGalleryId
      }
    }),
  setSelectedGalleryId: (id) => set({ selectedGalleryId: id }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
  clear: () =>
    set({
      query: '',
      page: 1,
      results: [],
      numPages: 0,
      perPage: 25,
      libraryFacts: {},
      loading: false,
      error: null,
      selectedGalleryId: null
    })
}))
