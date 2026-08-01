/**
 * Filename ordering that matches what a file manager shows.
 *
 * A plain `.sort()` compares strings character by character, so "10" sorts
 * before "2" and a folder of page images comes out as 1, 10, 100, 101, 11, 12.
 * That is what a custom gallery built from a picture folder was getting: the
 * pages were in the archive in string order, not page order, while the user's
 * file explorer showed them correctly because explorers sort numerically.
 *
 * `Intl.Collator` with `numeric: true` is the same rule the explorer uses —
 * runs of digits compare as numbers, everything else as text — so it handles
 * unpadded numbering, mixed prefixes like `page2` vs `page10`, and names that
 * are not numeric at all.
 */

/**
 * `sensitivity: 'base'` so case and accents do not split otherwise-equal names,
 * which keeps `IMG_2` and `img_10` in numeric order rather than grouping by case
 * first. Built once: constructing a Collator per comparison is measurably slow
 * on a folder with hundreds of files.
 */
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base'
})

/** Compare two filenames the way a file manager would. */
export function compareNatural(a: string, b: string): number {
  const byName = collator.compare(a, b)
  // Collator can call two distinct names equal — 'a' and 'A' under 'base'
  // sensitivity. Fall back to a byte comparison so the order stays stable and
  // one of them is not dropped by callers that deduplicate.
  return byName !== 0 ? byName : a < b ? -1 : a > b ? 1 : 0
}

/** A new array in natural order. Does not mutate the input. */
export function sortNatural(names: readonly string[]): string[] {
  return [...names].sort(compareNatural)
}
