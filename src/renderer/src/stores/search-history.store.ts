import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Recent and favourited searches for the Search tab's dropdown.
 *
 * Recording is opt-in (`searchSettings.rememberRecentSearches`, default off)
 * because this app's search history is adult-content-specific — unlike the
 * theme or sidebar state this store sits alongside, it is not the kind of
 * thing that should be captured by default and noticed later.
 *
 * The gate lives at the call site (`SearchPage.tsx`, right where a search is
 * submitted) rather than in `recordSearch` itself: the setting is read from
 * the main-process-backed `searchSettings` IPC, and this store has no
 * business knowing about that — it only holds and persists what it is told
 * to. Favourites are a separate, deliberate save action and are never
 * touched by the setting or by `clearRecent`.
 */

export interface RecentSearchEntry {
  query: string
  lastSearchedAt: number
}

/** Enough for "3 most recent" plus "12 more" with a little headroom to spare. */
const MAX_RECENT = 30

interface SearchHistoryState {
  recent: RecentSearchEntry[]
  /** Query strings, most-recently-favourited first. */
  favorites: string[]

  /**
   * Record a submitted search, most-recent-first. A repeat of the exact same
   * query moves to the front and updates its timestamp rather than creating a
   * second entry — otherwise running the same search twice would just push
   * the list further along.
   */
  recordSearch: (query: string) => void
  toggleFavorite: (query: string) => void
  isFavorite: (query: string) => boolean
  /** Wipes recent searches only. Favourites are untouched — see the file docstring. */
  clearRecent: () => void
}

export const useSearchHistoryStore = create<SearchHistoryState>()(
  persist(
    (set, get) => ({
      recent: [],
      favorites: [],

      recordSearch: (query) => {
        const trimmed = query.trim()
        if (!trimmed) return
        set((state) => {
          const rest = state.recent.filter((e) => e.query !== trimmed)
          const recent = [{ query: trimmed, lastSearchedAt: Date.now() }, ...rest].slice(
            0,
            MAX_RECENT
          )
          return { recent }
        })
      },

      toggleFavorite: (query) => {
        const trimmed = query.trim()
        if (!trimmed) return
        set((state) => {
          const already = state.favorites.includes(trimmed)
          const favorites = already
            ? state.favorites.filter((f) => f !== trimmed)
            : [trimmed, ...state.favorites]
          return { favorites }
        })
      },

      isFavorite: (query) => get().favorites.includes(query.trim()),

      clearRecent: () => set({ recent: [] })
    }),
    {
      name: 'doujin-search-history'
    }
  )
)
