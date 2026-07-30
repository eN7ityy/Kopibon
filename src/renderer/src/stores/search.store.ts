import { create } from 'zustand'
import type { GalleryListItem, DownloadStatus } from '../types/api.types'

interface SearchStore {
  query: string
  sort: string
  results: GalleryListItem[]
  downloadStatuses: Record<number, DownloadStatus>
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
    downloadStatuses: Map<number, DownloadStatus>,
    currentPage: number,
    totalPages: number
  ) => void
  appendResults: (
    results: GalleryListItem[],
    downloadStatuses: Map<number, DownloadStatus>,
    currentPage: number
  ) => void
  /** Update a single gallery's download status (triggers a re-render). */
  setDownloadStatus: (galleryId: number, status: DownloadStatus) => void
  /** Merge many statuses at once. */
  mergeDownloadStatuses: (statuses: Map<number, DownloadStatus>) => void
  setLoading: (loading: boolean) => void
  setLoadingMore: (loadingMore: boolean) => void
  setError: (error: string | null) => void
  setRateLimited: (seconds: number) => void
  decrementRateLimit: () => void
  clearRateLimited: () => void
  clear: () => void
}

export const useSearchStore = create<SearchStore>()((set) => ({
  query: '',
  sort: '',
  results: [],
  downloadStatuses: {},
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

  setResults: (results, downloadStatuses, currentPage, totalPages) =>
    set({
      results,
      downloadStatuses: Object.fromEntries(downloadStatuses),
      currentPage,
      totalPages,
      loading: false,
      loadingMore: false,
      error: null,
      rateLimited: false
    }),

  appendResults: (results, downloadStatuses, currentPage) =>
    set((state) => ({
      results: [...state.results, ...results],
      downloadStatuses: {
        ...state.downloadStatuses,
        ...Object.fromEntries(downloadStatuses)
      },
      currentPage,
      loading: false,
      loadingMore: false,
      error: null
    })),

  // Callers previously assigned into store.downloadStatuses directly, which
  // zustand cannot observe — badges never refreshed until an unrelated
  // re-render happened to occur.
  setDownloadStatus: (galleryId, status) =>
    set((state) =>
      state.downloadStatuses[galleryId] === status
        ? state
        : { downloadStatuses: { ...state.downloadStatuses, [galleryId]: status } }
    ),

  mergeDownloadStatuses: (statuses) =>
    set((state) => {
      let changed = false
      for (const [id, status] of statuses) {
        if (state.downloadStatuses[id] !== status) {
          changed = true
          break
        }
      }
      if (!changed) return state
      return {
        downloadStatuses: { ...state.downloadStatuses, ...Object.fromEntries(statuses) }
      }
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
      downloadStatuses: {},
      currentPage: 0,
      totalPages: 0,
      error: null,
      rateLimited: false
    })
}))
