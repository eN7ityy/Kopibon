import { describe, it, expect } from 'vitest'
import { describeGaps } from './series-gaps'

/**
 * The gap summary shown on a series.
 *
 * `findVolumeGaps` in main decides *which* volumes are missing and is tested
 * there. This decides how that list reads, which matters because the real case
 * is eight missing volumes in three separate runs.
 */

describe('describeGaps', () => {
  it('collapses the real Smoking Hypnosis gaps into runs', () => {
    // findVolumeGaps returns these for volumes 1-8, 14, 17-19, 21, 99, 100.
    expect(describeGaps([9, 10, 11, 12, 13, 15, 16, 20])).toBe('9–13, 15–16, 20')
  })

  it('renders a single missing volume as a bare number', () => {
    expect(describeGaps([7])).toBe('7')
  })

  it('renders any consecutive run as a range, including a pair', () => {
    // One rule rather than a special case at two. '15–16' is the same width as
    // '15, 16' and keeps the output uniform.
    expect(describeGaps([15, 16])).toBe('15–16')
    expect(describeGaps([3, 4, 5])).toBe('3–5')
  })

  it('keeps separate runs separate', () => {
    expect(describeGaps([2, 5, 8])).toBe('2, 5, 8')
  })

  it('handles a run at the end of the list', () => {
    // Guards the loop's flush step: the final run is emitted after the last
    // element, so an off-by-one here would silently drop it.
    expect(describeGaps([2, 6, 7, 8])).toBe('2, 6–8')
  })

  it('returns nothing for no gaps', () => {
    expect(describeGaps([])).toBe('')
  })
})
