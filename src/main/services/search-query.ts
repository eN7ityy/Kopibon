/**
 * Search query composition and blocked-value matching.
 *
 * Kept pure and free of Electron, the database and the network so the rules can
 * be tested directly — the query string is the one place where a mistake is both
 * easy to make and invisible, since a malformed filter silently returns the
 * wrong galleries rather than failing.
 *
 * The query syntax is nhentai's, per the v2 reference:
 *   keywords, "exact phrases", -negation, tag:name, artist:name,
 *   pages:>10, favorites:>=100, uploaded:<7d
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** The nhentai tag types that can be blocked, plus a free-text phrase. */
export type BlockedType = 'tag' | 'artist' | 'group' | 'parody' | 'character' | 'language' | 'text'

export type BlockedMode = 'exclude' | 'dim'

export interface BlockedEntry {
  type: BlockedType
  value: string
  mode: BlockedMode
}

export interface SearchDefaults {
  /** Applied when the user has not typed a query of their own. */
  defaultQuery?: string | null
  sort?: string | null
  /** Appended as `language:x` unless the query already names a language. */
  language?: string | null
  /** Appended as `pages:>N`. */
  minPages?: number | null
  /** Appended as `favorites:>=N`. */
  minFavorites?: number | null
  /** Appended as `uploaded:<Nd`, in days. */
  uploadedWithinDays?: number | null
}

// ─── Quoting ─────────────────────────────────────────────────────────────────

/**
 * Quote a value only when it needs it.
 *
 * The documented examples are `artist:name` bare and `tag:"big breasts"` quoted,
 * so whitespace is the deciding factor. Embedded quotes are stripped rather than
 * escaped: the syntax has no documented escape, and a stray quote would break
 * the whole query rather than just this term.
 */
function quoteIfNeeded(value: string): string {
  const cleaned = value.replace(/"/g, '').trim()
  return /\s/.test(cleaned) ? `"${cleaned}"` : cleaned
}

/** The negation term for one blocked entry, or null when it cannot be expressed. */
export function negationTerm(entry: BlockedEntry): string | null {
  const value = quoteIfNeeded(entry.value)
  if (!value) return null
  if (entry.type === 'text') return `-${value}`
  return `-${entry.type}:${value}`
}

// ─── Detecting filters the user already typed ────────────────────────────────

/**
 * True when the query already constrains `field`.
 *
 * A default must never override something typed explicitly: searching
 * `language:japanese` with an English default should not end up asking for both.
 * Matches the field at a term boundary so `uploaded:` does not match a title
 * word ending in "uploaded".
 */
export function queryHasField(query: string, field: string): boolean {
  return new RegExp(`(^|\\s)-?${field}:`, 'i').test(query)
}

// ─── Composition ─────────────────────────────────────────────────────────────

/**
 * Build the query string to send to the API.
 *
 * Order is: the user's own terms first, then defaults, then negations. Only
 * `exclude` entries become negations — `dim` entries deliberately do not, since
 * the point of dimming is that the gallery still arrives.
 */
export function buildSearchQuery(
  userQuery: string,
  defaults: SearchDefaults,
  blocked: readonly BlockedEntry[] = []
): string {
  const typed = userQuery.trim()
  // The default search stands in only when nothing was typed, so it behaves like
  // a starting point rather than a filter the user cannot escape.
  const base = typed || (defaults.defaultQuery ?? '').trim()

  const terms: string[] = []
  if (base) terms.push(base)

  if (defaults.language && !queryHasField(base, 'language')) {
    terms.push(`language:${quoteIfNeeded(defaults.language)}`)
  }
  if (defaults.minPages != null && defaults.minPages > 0 && !queryHasField(base, 'pages')) {
    terms.push(`pages:>${Math.floor(defaults.minPages)}`)
  }
  if (
    defaults.minFavorites != null &&
    defaults.minFavorites > 0 &&
    !queryHasField(base, 'favorites')
  ) {
    terms.push(`favorites:>=${Math.floor(defaults.minFavorites)}`)
  }
  if (
    defaults.uploadedWithinDays != null &&
    defaults.uploadedWithinDays > 0 &&
    !queryHasField(base, 'uploaded')
  ) {
    terms.push(`uploaded:<${Math.floor(defaults.uploadedWithinDays)}d`)
  }

  const seen = new Set<string>()
  for (const entry of blocked) {
    if (entry.mode !== 'exclude') continue
    const term = negationTerm(entry)
    // The unique index prevents duplicates in the table, but a caller could pass
    // anything, and a repeated negation makes the query longer for no gain.
    if (term && !seen.has(term.toLowerCase())) {
      seen.add(term.toLowerCase())
      terms.push(term)
    }
  }

  return terms.join(' ').trim()
}

// ─── Dim matching ────────────────────────────────────────────────────────────

/** What is known about a gallery when deciding whether to dim it. */
export interface GalleryFacts {
  title?: string | null
  /** Resolved tag names by type. Missing types are treated as absent, not empty. */
  tags?: ReadonlyArray<{ type: string; name: string }>
  /** nhentai's own blacklist flag from the search result. */
  blacklisted?: boolean
}

export interface DimMatch {
  type: BlockedType
  value: string
}

/**
 * Which `dim` entries a gallery matches.
 *
 * Returns every match rather than a boolean so the UI can say *why* something is
 * marked, which matters when the reason is a tag the card does not display.
 *
 * Tag comparison is case-insensitive and exact on the name; a `text` entry is a
 * case-insensitive substring of the title. Substring matching on tag names would
 * make a block on "rape" also catch "grape", which is the kind of surprise that
 * makes a feature untrustworthy.
 */
export function matchDimEntries(facts: GalleryFacts, blocked: readonly BlockedEntry[]): DimMatch[] {
  const matches: DimMatch[] = []
  const title = (facts.title ?? '').toLowerCase()
  const tags = facts.tags ?? []

  for (const entry of blocked) {
    if (entry.mode !== 'dim') continue
    const needle = entry.value.trim().toLowerCase()
    if (!needle) continue

    if (entry.type === 'text') {
      if (title.includes(needle)) matches.push({ type: entry.type, value: entry.value })
      continue
    }

    const hit = tags.some(
      (tag) => tag.type === entry.type && tag.name.trim().toLowerCase() === needle
    )
    if (hit) matches.push({ type: entry.type, value: entry.value })
  }

  return matches
}
