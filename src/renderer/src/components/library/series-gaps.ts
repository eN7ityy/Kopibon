/**
 * How a series' missing volumes read.
 *
 * `findVolumeGaps` in main decides *which* volumes are absent. This decides how
 * that list is phrased, which matters because a real series here is missing
 * eight volumes across three separate runs, and spelling each one out is a wall
 * of digits nobody reads.
 *
 * Its own module rather than a helper inside SeriesDetail: exporting a
 * non-component from a component file breaks fast refresh, and this needs to be
 * exported so it can be tested.
 */

/**
 * Volume list like "9–13, 15–16, 20".
 *
 * Every consecutive run becomes a range, including a run of two — one rule
 * rather than a special case, and "15–16" is no wider than "15, 16".
 */
export function describeGaps(gaps: readonly number[]): string {
  if (gaps.length === 0) return ''

  const runs: string[] = []
  let start = gaps[0]
  let prev = gaps[0]

  // Runs to length inclusive: the extra step flushes the final run, which is
  // otherwise left unemitted.
  for (let i = 1; i <= gaps.length; i++) {
    const current = gaps[i]
    if (current === prev + 1) {
      prev = current
      continue
    }
    runs.push(start === prev ? String(start) : `${start}–${prev}`)
    start = current
    prev = current
  }

  return runs.join(', ')
}
