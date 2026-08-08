/**
 * Pure auto-detection helpers for the "Assign to Series" dialog.
 *
 * Both functions are deliberately pure: they take strings and return strings or
 * numbers, with no React or IPC in sight, so they can be unit-tested in
 * isolation. All the heuristics about doujinshi title conventions live here —
 * the dialog just calls them and displays the result.
 *
 * The conventions handled:
 *   [Circle (Artist)] Series Name Ch. 1 [English]
 *   (C92) [Circle (Artist)] Series Name Chapter 2 [English]
 *   Series Name Ep.3
 *   Series Name part4
 *   Series Name #5
 *   Series Name 6          (standalone trailing number)
 */

// ─── Chapter detection ───────────────────────────────────────────────────────

/**
 * Patterns that mark an explicit chapter/volume indicator.
 *
 * `g` is required so `matchAll` finds every occurrence; we keep the one closest
 * to the end of the title, which is the most likely to be the chapter. `\d{1,3}`
 * deliberately caps at three digits so a 4-digit year like `2024` is never read
 * as a chapter, while `10` and `100` still parse.
 */
const CHAPTER_PATTERNS = [
  /\b(?:ch(?:apter)?)\s*[.:]?\s*#?\s*(\d{1,3}(?:\.\d+)?)/gi,
  /\b(?:ep(?:isode)?)\s*[.:]?\s*#?\s*(\d{1,3}(?:\.\d+)?)/gi,
  /\bpart\s*#?\s*(\d{1,3}(?:\.\d+)?)/gi,
  /#(\d{1,3}(?:\.\d+)?)/g
]

/** A trailing bracketed tag — language, format, etc. — removed before parsing. */
const TRAILING_TAG = /\s*\[[^\]]+\]\s*$/

/**
 * A standalone number at the very end, preceded by a typical delimiter.
 *
 * Only applies when no explicit indicator was found. The number must sit at the
 * end of the (tag-stripped) title, so "Foo 6" yields 6 but "Foo 6 Bar" yields
 * nothing — that number is not clearly a chapter.
 */
const STANDALONE_TRAILING = /(?:^|[\s\-_.:])(\d{1,3}(?:\.\d+)?)\s*$/

/**
 * Extract the chapter number from a gallery title.
 *
 * Priority: an explicit indicator (Ch/Chapter/Ep/Episode/part/#) wins; when
 * several are present the last one (closest to the end) is used. Failing that,
 * a standalone number at the end of the tag-stripped title is used. Returns
 * null when nothing is confidently a chapter, so callers can leave the field
 * blank rather than guess.
 */
export function extractChapterNumber(title: string): number | null {
  if (!title) return null

  // Strip a trailing [English] / [Digital] / [Chinese] style tag so "the end"
  // is the end of the meaningful title, not the tag.
  const base = title.replace(TRAILING_TAG, '').trim()
  if (!base) return null

  // Collect every indicator match across all patterns and keep the last one.
  let last: { value: number; index: number } | null = null
  for (const pattern of CHAPTER_PATTERNS) {
    for (const m of base.matchAll(pattern)) {
      const n = Number.parseFloat(m[1])
      if (Number.isFinite(n) && (last === null || (m.index ?? 0) > last.index)) {
        last = { value: n, index: m.index ?? 0 }
      }
    }
  }
  if (last) return last.value

  const trailing = base.match(STANDALONE_TRAILING)
  if (trailing) {
    const n = Number.parseFloat(trailing[1])
    if (Number.isFinite(n)) return n
  }

  return null
}

// ─── Series name detection ───────────────────────────────────────────────────

/** A common result shorter than this is too noisy to be a real series name. */
const MIN_COMMON_LENGTH = 4

/**
 * Strip the leading circle/artist/event convention and trailing language tag
 * from a title before searching for a common substring.
 *
 * Only leading and trailing bracket/paren groups are removed — interior
 * brackets that are part of the series name are preserved.
 */
function cleanTitleForSeries(title: string): string {
  let s = title.trim()
  // Leading conventions: [Circle (Artist)], (C92), possibly several.
  s = s.replace(/^\s*(?:\[[^\]]*\]|\([^)]*\)|\s+)+/, '').trim()
  // Trailing language/format tags.
  s = s.replace(/\s*\[[^\]]+\]\s*$/, '').trim()
  return s
}

/**
 * Longest common substring of two strings (classic DP).
 */
function longestCommonSubstring(a: string, b: string): string {
  const n = a.length
  const m = b.length
  let maxLen = 0
  let endA = 0
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
        if (dp[i][j] > maxLen) {
          maxLen = dp[i][j]
          endA = i
        }
      }
    }
  }
  return a.slice(endA - maxLen, endA)
}

/** Collapse a common substring into a clean series name. */
function cleanCommon(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-_.:]+/, '')
    .replace(/[\s\-_.:]+$/, '')
    .trim()
}

/**
 * A trailing chapter marker that a common substring may still carry.
 *
 * The number is optional because the common substring often stops right at the
 * point where two titles differ — "My Favorite Series Ch. " (before the 1/2) —
 * so "Ch. " appears with no digit.
 */
const TRAILING_CHAPTER_MARKER =
  /\s*(?:ch(?:apter)?|ep(?:isode)?|part|vol(?:ume)?)\s*[.:]?\s*#?\s*\d*(?:\.\d+)?\s*$/i

/**
 * Find the longest meaningful common substring across all given titles.
 *
 * Returns '' when there is no reliable common segment: fewer than two titles,
 * the shared text is too short, or the titles share nothing but noise.
 * Special characters (brackets, parentheses, Japanese text) in the series name
 * are preserved.
 */
export function findCommonSeriesName(titles: string[]): string {
  const cleaned = titles.map(cleanTitleForSeries).filter((t) => t.length > 0)
  if (cleaned.length < 2) return ''

  // Iteratively narrow: the longest substring common to every title is at most
  // the longest substring of the running result and the next title.
  let common = cleaned[0]
  for (let i = 1; i < cleaned.length; i++) {
    common = longestCommonSubstring(common, cleaned[i])
    if (common.length < MIN_COMMON_LENGTH) return ''
  }

  let result = cleanCommon(common)
    .replace(TRAILING_CHAPTER_MARKER, '')
    .trim()
    .replace(/[\s\-_.:]+$/, '')
    .trim()

  if (result.length < MIN_COMMON_LENGTH) return ''
  return result
}
