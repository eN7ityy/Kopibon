/**
 * Caret-aware token utilities for the search box's autocomplete dropdown.
 *
 * The search box holds one query string that can carry several filter terms —
 * `artist:"foo" tag:"big breasts"` — separated by whitespace, except where the
 * whitespace sits inside a quoted phrase. Everything here operates on "the
 * token the caret is inside", which is the unit both the live-suggestion query
 * and a suggestion click operate on: what gets sent to nhentai's tag search is
 * that token's text, and what a click replaces is that token's range, leaving
 * every other term in the box untouched.
 */

/** A token's position and text within the full query string. */
export interface QueryToken {
  /** Index of the token's first character. */
  start: number
  /** Index one past the token's last character. */
  end: number
  text: string
}

/**
 * The token containing (or immediately before) `caret`.
 *
 * Scans outward from the caret rather than tokenizing the whole string and
 * searching, since the caret sits at the end during normal typing and this
 * keeps that case O(distance to the previous boundary) instead of O(length).
 *
 * A quote toggles "inside a phrase" for whitespace purposes, so
 * `tag:"big breasts"` is one token despite its internal space. An unbalanced
 * quote (the phrase is still open) is treated as extending to the nearest
 * actual boundary rather than to the end of the string — the box already
 * contains a quote character to close it, once the user gets there.
 */
export function currentToken(text: string, caret: number): QueryToken {
  const pos = Math.max(0, Math.min(caret, text.length))

  // Whether the caret itself sits inside an open quote, so the two scans
  // below start from the right parity instead of assuming "outside". Scanning
  // backward from the caret hits a run's *closing* boundary before its
  // opening `"`, so a toggle that starts at `false` regardless of context
  // gets an unbalanced quote's interior wrong — the actual state has to come
  // from the real count of quotes between the string start and the caret.
  let startsQuoted = false
  for (let i = 0; i < pos; i++) if (text[i] === '"') startsQuoted = !startsQuoted

  let start = pos
  let quoted = startsQuoted
  while (start > 0) {
    const ch = text[start - 1]
    if (ch === '"') quoted = !quoted
    else if (!quoted && /\s/.test(ch)) break
    start--
  }

  let end = pos
  quoted = startsQuoted
  while (end < text.length) {
    const ch = text[end]
    if (ch === '"') quoted = !quoted
    else if (!quoted && /\s/.test(ch)) break
    end++
  }

  return { start, end, text: text.slice(start, end) }
}

/**
 * Replace the token at `token`'s range with `replacement`, and report where
 * the caret should land — always right after the replacement plus one space,
 * so typing continues into a fresh token rather than gluing onto what was just
 * inserted or onto whatever already followed it.
 *
 * Collapses any whitespace immediately after the replaced range into that
 * single separating space, so clicking a suggestion mid-string (token was not
 * the last one) does not leave a run of blanks behind.
 */
export function replaceToken(
  fullText: string,
  token: QueryToken,
  replacement: string
): { text: string; caret: number } {
  const before = fullText.slice(0, token.start)
  let afterStart = token.end
  while (afterStart < fullText.length && /\s/.test(fullText[afterStart])) afterStart++
  const after = fullText.slice(afterStart)

  const insertion = `${replacement} `
  const text = `${before}${insertion}${after}`
  return { text, caret: before.length + insertion.length }
}

/** The tag types nhentai's search accepts a `{type}:` prefix for. */
export const TAG_TYPES = [
  'tag',
  'artist',
  'parody',
  'character',
  'group',
  'language',
  'category'
] as const

export type TagType = (typeof TAG_TYPES)[number]

/** A token, split into what it means for the autocomplete request. */
export interface ParsedToken {
  /** True for `-artist:foo` — negation is re-applied on insertion, not searched on. */
  negated: boolean
  /** Set once the user has typed a recognised `{type}:` prefix. */
  type: TagType | null
  /** The text to send to tags/search: the token with any prefix and quote stripped. */
  query: string
}

/**
 * Read the current token to decide what to autocomplete against.
 *
 * Without this, typing `artist:blu` after already picking "artist" as the
 * filter would search *every* tag type for the literal text "artist:blu" and
 * find nothing — the whole point of scoping to a type once it is chosen is
 * lost. A leading `-` (negation) is recognised and stripped from the search
 * text; the caller re-applies it when building the replacement.
 */
export function parseTypedToken(token: string): ParsedToken {
  const negated = token.startsWith('-')
  const rest = negated ? token.slice(1) : token

  const match = rest.match(/^(tag|artist|parody|character|group|language|category):"?(.*)$/)
  if (!match) return { negated, type: null, query: rest }

  const [, type, query] = match
  // A trailing quote closing the value is stripped too, so re-selecting a
  // suggestion while a phrase is already quoted does not double the quotes.
  return { negated, type: type as TagType, query: query.replace(/"$/, '') }
}

/**
 * The operator string a chosen tag becomes, e.g. `artist:"blue"`.
 *
 * Always quoted: a bare `artist:blue` and a quoted `artist:"blue"` are
 * equivalent to the API, and quoting unconditionally means a multi-word name
 * never has to be special-cased.
 */
export function buildTagFilter(type: string, name: string, negated = false): string {
  const cleaned = name.replace(/"/g, '')
  return `${negated ? '-' : ''}${type}:"${cleaned}"`
}

/**
 * `13868` -> `"13.9k"`, matching nhentai's own count formatting. Below 1000 is
 * shown exactly, since "999" reads better than a fabricated decimal.
 */
export function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const thousands = n / 1000
    // toFixed(1) on 13.95 rounds to "14.0", which should show as "14k" not
    // "14.0k" — the trailing ".0" is the one case worth trimming.
    const s = thousands.toFixed(1).replace(/\.0$/, '')
    return `${s}k`
  }
  const millions = n / 1_000_000
  const s = millions.toFixed(1).replace(/\.0$/, '')
  return `${s}m`
}
