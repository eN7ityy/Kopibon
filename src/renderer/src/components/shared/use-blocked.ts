import { useState, useEffect, useCallback } from 'react'

/**
 * The blocked list, for marking tag chips.
 *
 * Detail panels show blocked tags struck through rather than hiding them: the
 * exclusion is a search preference, and a gallery already in your Library or
 * Favorites is one you have. Removing the chip would just make its metadata
 * look wrong.
 */
export interface BlockedEntryLite {
  type: string
  value: string
  mode: string
}

/** Matches a tag against the blocked list. Null when nothing matches. */
export type BlockedMatcher = (type: string, value: string) => BlockedEntryLite | null

/**
 * Load the blocked list once and return a matcher over it.
 *
 * Matching is exact on the name and case-insensitive, the same rule the main
 * process uses — a substring match would strike "grape" for a block on "rape".
 * Free-text entries are ignored here: they match titles, not tags.
 */
export function useBlocked(): { matcher: BlockedMatcher; loaded: boolean } {
  const [entries, setEntries] = useState<BlockedEntryLite[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.blocked
      .list()
      .then((r) => {
        if (cancelled) return
        if (r.success && Array.isArray(r.data)) setEntries(r.data as BlockedEntryLite[])
        setLoaded(true)
      })
      .catch(() => {
        // An empty list is a valid state: nothing gets struck through.
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const matcher = useCallback<BlockedMatcher>(
    (type, value) => {
      const needle = value.trim().toLowerCase()
      if (!needle) return null
      return (
        entries.find(
          (entry) =>
            entry.type !== 'text' &&
            entry.type === type &&
            entry.value.trim().toLowerCase() === needle
        ) ?? null
      )
    },
    [entries]
  )

  return { matcher, loaded }
}

/**
 * Extra classes for a blocked chip.
 *
 * Struck through and faded, but still fully clickable — the chip remains a way
 * to search for that tag, which is occasionally exactly what you want to do
 * after noticing it.
 */
export function blockedChipClass(match: BlockedEntryLite | null): string {
  if (!match) return ''
  return 'line-through decoration-2 opacity-60'
}

/** Tooltip text explaining why a chip is struck through. */
export function blockedChipTitle(match: BlockedEntryLite | null): string | undefined {
  if (!match) return undefined
  return match.mode === 'exclude'
    ? 'Blocked — galleries with this tag are hidden from search'
    : 'Blocked — galleries with this tag are marked in search'
}
