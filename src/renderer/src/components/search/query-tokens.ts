/**
 * Caret-aware token utilities for the search box's autocomplete dropdown.
 *
 * The search box holds one query string that can carry several filter terms —
 * `artist:"foo" tag:"big breasts"` — and free text the user is still typing,
 * not yet turned into a filter. Everything here operates on "the token the
 * caret is inside", which is the unit both the live-suggestion query and a
 * suggestion click operate on: what gets sent to nhentai's tag search is that
 * token's text, and what a click replaces is that token's range, leaving
 * every other term in the box untouched.
 *
 * The boundary between tokens is a *completed filter term*, not plain
 * whitespace. Splitting on every space would cut "blue archive" into "blue"
 * and "archive" and search on whichever one the caret happened to be nearer —
 * exactly wrong for a two-word tag name, which is the normal case, not an edge
 * case, on a site where tags read like "blue archive" or "big breasts". A run
 * of free text can contain as many spaces as it likes and stays one token
 * until it butts up against something already recognisable as a finished
 * `type:value` term or a quoted phrase.
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
 * Matches one complete filter term: a recognised `type:` prefix followed by a
 * quoted or bare value, or a standalone quoted phrase. Negation (`-`) is part
 * of the match so a negated term is still recognised as one unit.
 *
 * The bare-value branch excludes `"` (`[^\s"]+`, not `\S+`): a value that
 * starts with a quote but never closes it must fail to match at all rather
 * than have the bare branch swallow the dangling quote character, which
 * would silently treat `tag:"big blue` (still being typed) as the complete,
 * closed term `tag:"big`.
 */
const TERM_RE =
  /-?(?:tag|artist|parody|character|group|language|category|pages|favorites|uploaded|title|jtitle):(?:"[^"]*"|[^\s"]+)|-?"[^"]*"/g

/**
 * The token containing `caret`.
 *
 * If the caret sits inside (or right at the edge of) a completed term, that
 * whole term is the token — editing or replacing it acts on the term as a
 * unit. Otherwise the caret is in a free-text run: its token is that run's
 * full extent, from the end of the nearest earlier term (or the start of the
 * string) to the start of the nearest later term (or the end of the string),
 * trimmed of the single separating space at each edge but keeping any spaces
 * in the middle — that trim is what stops a replacement from eating the space
 * that connects it to a neighbouring term.
 */
export function currentToken(text: string, caret: number): QueryToken {
  const pos = Math.max(0, Math.min(caret, text.length))

  const terms = [...text.matchAll(TERM_RE)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length
  }))

  for (const t of terms) {
    if (pos >= t.start && pos <= t.end) {
      return { start: t.start, end: t.end, text: text.slice(t.start, t.end) }
    }
  }

  let regionStart = 0
  let regionEnd = text.length
  for (const t of terms) {
    if (t.end <= pos) regionStart = Math.max(regionStart, t.end)
    if (t.start >= pos) {
      regionEnd = Math.min(regionEnd, t.start)
      break
    }
  }

  let start = regionStart
  while (start < regionEnd && /\s/.test(text[start])) start++
  let end = regionEnd
  while (end > start && /\s/.test(text[end - 1])) end--

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
