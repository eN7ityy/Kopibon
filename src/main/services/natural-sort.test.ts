import { describe, it, expect } from 'vitest'
import { compareNatural, sortNatural } from './natural-sort'

/**
 * The reported failure: a custom gallery built from a picture folder came out
 * ordered 1, 10, 100, 101, 102, 103, 11, 12 — string order, not page order —
 * while the same folder in a file manager showed the pages correctly.
 */

describe('sortNatural — the reported case', () => {
  it('orders unpadded page numbers the way a file manager does', () => {
    const files = ['1.jpg', '10.jpg', '100.jpg', '101.jpg', '11.jpg', '2.jpg', '20.jpg', '3.jpg']
    expect(sortNatural(files)).toEqual([
      '1.jpg',
      '2.jpg',
      '3.jpg',
      '10.jpg',
      '11.jpg',
      '20.jpg',
      '100.jpg',
      '101.jpg'
    ])
  })

  it('is what a plain sort gets wrong', () => {
    // Guards the premise: if this ever matched, the fix would be pointless.
    const files = ['1.jpg', '2.jpg', '10.jpg']
    expect([...files].sort()).toEqual(['1.jpg', '10.jpg', '2.jpg'])
    expect(sortNatural(files)).toEqual(['1.jpg', '2.jpg', '10.jpg'])
  })

  it('picks the true first page, which decides the cover thumbnail', () => {
    const files = ['10.jpg', '1.jpg', '2.jpg']
    expect(sortNatural(files)[0]).toBe('1.jpg')
  })
})

describe('sortNatural — other real naming schemes', () => {
  it('handles a prefix before the number', () => {
    expect(sortNatural(['page10.png', 'page2.png', 'page1.png'])).toEqual([
      'page1.png',
      'page2.png',
      'page10.png'
    ])
  })

  it('handles zero padding, which was already fine, without breaking it', () => {
    expect(sortNatural(['003.jpg', '001.jpg', '002.jpg'])).toEqual([
      '001.jpg',
      '002.jpg',
      '003.jpg'
    ])
  })

  it('mixes padded and unpadded sensibly', () => {
    expect(sortNatural(['01.jpg', '2.jpg', '10.jpg'])).toEqual(['01.jpg', '2.jpg', '10.jpg'])
  })

  it('handles several number runs in one name', () => {
    expect(sortNatural(['ch2_p10.jpg', 'ch2_p2.jpg', 'ch10_p1.jpg'])).toEqual([
      'ch2_p2.jpg',
      'ch2_p10.jpg',
      'ch10_p1.jpg'
    ])
  })

  it('still orders names with no digits at all', () => {
    expect(sortNatural(['cover.jpg', 'back.jpg', 'a.jpg'])).toEqual([
      'a.jpg',
      'back.jpg',
      'cover.jpg'
    ])
  })

  it('does not group by case ahead of number order', () => {
    expect(sortNatural(['IMG_10.jpg', 'img_2.jpg'])).toEqual(['img_2.jpg', 'IMG_10.jpg'])
  })
})

describe('compareNatural', () => {
  it('never reports two different names as equal', () => {
    // Under 'base' sensitivity the collator calls these equal; a zero would let
    // a caller that deduplicates drop one of the two pages.
    expect(compareNatural('a.jpg', 'A.jpg')).not.toBe(0)
    expect(compareNatural('a.jpg', 'a.jpg')).toBe(0)
  })

  it('is a consistent ordering, so sort results are stable', () => {
    expect(compareNatural('1.jpg', '2.jpg')).toBeLessThan(0)
    expect(compareNatural('2.jpg', '1.jpg')).toBeGreaterThan(0)
  })
})

describe('sortNatural — purity', () => {
  it('does not mutate the input', () => {
    const files = ['10.jpg', '1.jpg']
    sortNatural(files)
    expect(files).toEqual(['10.jpg', '1.jpg'])
  })

  it('handles an empty folder', () => {
    expect(sortNatural([])).toEqual([])
  })
})
