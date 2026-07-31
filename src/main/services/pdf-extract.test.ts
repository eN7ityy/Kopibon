import { describe, it, expect } from 'vitest'
import { numericSortKey } from './pdf-extract'

/**
 * Regression cover for a shipped bug that reversed every converted book.
 *
 * `numericSortKey` used `/(-?\d+)$/`, which reads poppler's separator hyphen in
 * `page-031` as a minus sign. Every key came out negative, so sorting ascending
 * produced page 32 first and page 1 last. The archive still looked correct from
 * the outside — entries named 0001.jpg…0032.jpg in sequence — which is why an
 * "names are ordered" check passed while the pages were backwards.
 */
describe('numericSortKey', () => {
  it('reads the trailing index as a positive number', () => {
    expect(numericSortKey('page-000.jpg')).toBe(0)
    expect(numericSortKey('page-001.jpg')).toBe(1)
    expect(numericSortKey('page-031.jpg')).toBe(31)
  })

  it('never returns a negative key for a hyphen-separated name', () => {
    // The actual bug: the hyphen is a separator, not a sign.
    for (const n of ['page-000.jpg', 'page-007.png', 'page-1000.jpg', 'a-b-42.jpg']) {
      expect(numericSortKey(n)).toBeGreaterThanOrEqual(0)
    }
  })

  it('sorts poppler output into true page order', () => {
    const names = [
      'page-031.jpg', 'page-002.jpg', 'page-000.jpg', 'page-010.jpg', 'page-001.jpg'
    ]
    const sorted = names.slice().sort((a, b) => numericSortKey(a) - numericSortKey(b))
    expect(sorted).toEqual([
      'page-000.jpg', 'page-001.jpg', 'page-002.jpg', 'page-010.jpg', 'page-031.jpg'
    ])
  })

  it('orders past the padding boundary, where a string sort fails', () => {
    // The reason the numeric key exists at all: poppler's zero-padding grows,
    // so '-1000' sorts before '-999' lexicographically.
    const names = ['page-1000.jpg', 'page-999.jpg', 'page-100.jpg']
    const sorted = names.slice().sort((a, b) => numericSortKey(a) - numericSortKey(b))
    expect(sorted).toEqual(['page-100.jpg', 'page-999.jpg', 'page-1000.jpg'])
    expect(names.slice().sort()).not.toEqual(sorted) // a plain sort really does differ
  })

  it('handles both poppler extensions and multi-digit widths', () => {
    expect(numericSortKey('page-05.png')).toBe(5)
    expect(numericSortKey('out-0001.jpeg')).toBe(1)
  })

  it('falls back to 0 when there is no trailing number', () => {
    expect(numericSortKey('cover.jpg')).toBe(0)
  })
})
