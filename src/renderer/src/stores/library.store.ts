import { create } from 'zustand'
import type { LibraryItemData } from '../components/library/LibraryCard'
import type { SeriesCardModel } from '../components/library/SeriesCard'
import type { SeriesRef } from '../components/library/SeriesDetail'

type SortField = 'added' | 'title' | 'artist'
type ViewMode = 'grid' | 'compact' | 'list'

export type LibraryRow =
  | { kind: 'item'; item: LibraryItemData }
  | { kind: 'series'; series: SeriesCardModel }

interface LibraryStore {
  searchQuery: string
  sortField: SortField
  selectedArtistFilters: string[]
  selectedSeriesFilters: string[]
  selectedTagFilters: string[]
  showUnmatchedOnly: boolean
  viewMode: ViewMode
  /** Whether the filter panel is open. Persisted so it stays open across tab
   *  switches along with the filters it shows. */
  showFilters: boolean

  currentOffset: number
  rows: LibraryRow[]
  totalCount: number
  galleryCount: number

  detailItem: LibraryItemData | null
  detailSeries: SeriesRef | null

  loading: boolean
  loadingMore: boolean
  error: string | null

  setSearchQuery: (q: string) => void
  setSortField: (field: SortField) => void
  setSelectedArtistFilters: (filters: string[]) => void
  setSelectedSeriesFilters: (filters: string[]) => void
  setSelectedTagFilters: (filters: string[]) => void
  setShowUnmatchedOnly: (show: boolean) => void
  setViewMode: (mode: ViewMode) => void
  setShowFilters: (show: boolean) => void

  setResults: (
    rows: LibraryRow[],
    totalCount: number,
    galleryCount: number,
    replace: boolean
  ) => void
  setOffset: (offset: number) => void
  setLoading: (loading: boolean) => void
  setLoadingMore: (loadingMore: boolean) => void
  setError: (error: string | null) => void
  setDetailItem: (item: LibraryItemData | null) => void
  setDetailSeries: (series: SeriesRef | null) => void

  resetFilters: () => void
  clear: () => void
}

export const useLibraryStore = create<LibraryStore>()((set) => ({
  searchQuery: '',
  sortField: 'added',
  selectedArtistFilters: [],
  selectedSeriesFilters: [],
  selectedTagFilters: [],
  showUnmatchedOnly: false,
  viewMode: 'grid',
  showFilters: false,

  currentOffset: 0,
  rows: [],
  totalCount: 0,
  galleryCount: 0,

  detailItem: null,
  detailSeries: null,

  loading: false,
  loadingMore: false,
  error: null,

  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSortField: (sortField) => set({ sortField }),
  setSelectedArtistFilters: (selectedArtistFilters) => set({ selectedArtistFilters }),
  setSelectedSeriesFilters: (selectedSeriesFilters) => set({ selectedSeriesFilters }),
  setSelectedTagFilters: (selectedTagFilters) => set({ selectedTagFilters }),
  setShowUnmatchedOnly: (showUnmatchedOnly) => set({ showUnmatchedOnly }),
  setViewMode: (viewMode) => set({ viewMode }),
  setShowFilters: (showFilters) => set({ showFilters }),

  setResults: (rows, totalCount, galleryCount, replace) =>
    set((state) => {
      if (replace) {
        return { rows, totalCount, galleryCount, loading: false, loadingMore: false, error: null }
      }
      // Deduplicate on row identity (same logic as the original component)
      const seen = new Set(state.rows.map((r) => rowKey(r)))
      const newRows = rows.filter((r) => !seen.has(rowKey(r)))
      return {
        rows: [...state.rows, ...newRows],
        totalCount,
        galleryCount,
        loading: false,
        loadingMore: false,
        error: null
      }
    }),
  setOffset: (currentOffset) => set({ currentOffset }),
  setLoading: (loading) => set({ loading, error: null }),
  setLoadingMore: (loadingMore) => set({ loadingMore }),
  setError: (error) => set({ error, loading: false, loadingMore: false }),
  setDetailItem: (detailItem) => set({ detailItem }),
  setDetailSeries: (detailSeries) => set({ detailSeries }),

  resetFilters: () =>
    set({
      selectedArtistFilters: [],
      selectedSeriesFilters: [],
      selectedTagFilters: [],
      showUnmatchedOnly: false
    }),

  clear: () =>
    set({
      searchQuery: '',
      sortField: 'added',
      selectedArtistFilters: [],
      selectedSeriesFilters: [],
      selectedTagFilters: [],
      showUnmatchedOnly: false,
      viewMode: 'grid',
      showFilters: false,
      currentOffset: 0,
      rows: [],
      totalCount: 0,
      galleryCount: 0,
      detailItem: null,
      detailSeries: null,
      loading: false,
      loadingMore: false,
      error: null
    })
}))

/** A row's identity for deduplication, matching rowKey() in LibraryPage. */
function rowKey(row: LibraryRow): string {
  return row.kind === 'item' ? `i${row.item.id}` : `s${row.series.id}`
}
