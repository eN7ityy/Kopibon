import { describe, it, expect } from 'vitest'
import { findCommonSeriesName, extractChapterNumber } from './series-auto-detect'

// ─── extractChapterNumber ────────────────────────────────────────────────────

describe('extractChapterNumber', () => {
  it('parses Ch. / Chapter with and without spacing', () => {
    expect(extractChapterNumber('My Favorite Series Ch. 1')).toBe(1)
    expect(extractChapterNumber('My Favorite Series Chapter 2')).toBe(2)
    expect(extractChapterNumber('My Favorite Series ch3')).toBe(3)
    expect(extractChapterNumber('My Favorite Series Ch. 12')).toBe(12)
  })

  it('parses Ep. / Episode', () => {
    expect(extractChapterNumber('My Favorite Series Ep.3')).toBe(3)
    expect(extractChapterNumber('My Favorite Series Episode 4')).toBe(4)
    expect(extractChapterNumber('My Favorite Series ep5')).toBe(5)
  })

  it('parses part and # forms', () => {
    expect(extractChapterNumber('My Favorite Series part4')).toBe(4)
    expect(extractChapterNumber('My Favorite Series Part 5')).toBe(5)
    expect(extractChapterNumber('My Favorite Series #6')).toBe(6)
  })

  it('parses a standalone trailing number', () => {
    expect(extractChapterNumber('My Favorite Series 6')).toBe(6)
    expect(extractChapterNumber('My Favorite Series 7')).toBe(7)
    expect(extractChapterNumber('My Favorite Series-8')).toBe(8)
    expect(extractChapterNumber('My Favorite Series_9')).toBe(9)
  })

  it('parses double- and triple-digit chapters', () => {
    expect(extractChapterNumber('My Favorite Series Ch. 10')).toBe(10)
    expect(extractChapterNumber('My Favorite Series Ch. 100')).toBe(100)
    expect(extractChapterNumber('My Favorite Series 23')).toBe(23)
  })

  it('ignores a trailing language tag when picking the chapter', () => {
    expect(extractChapterNumber('My Favorite Series Ch. 1 [English]')).toBe(1)
    expect(extractChapterNumber('My Favorite Series Chapter 2 [Chinese]')).toBe(2)
    expect(extractChapterNumber('My Favorite Series 6 [English]')).toBe(6)
  })

  it('handles the (C92) event convention', () => {
    expect(extractChapterNumber('(C92) [Circle (Artist)] My Series Ch. 1 [English]')).toBe(1)
  })

  it('uses the last indicator when several numbers are present', () => {
    expect(extractChapterNumber('My Series Part 1 Ch. 2')).toBe(2)
    expect(extractChapterNumber('My Series Ch. 1 Chapter 3')).toBe(3)
  })

  it('does not read a 4-digit year as a chapter', () => {
    expect(extractChapterNumber('My Series 2024')).toBeNull()
    expect(extractChapterNumber('My Series (2024)')).toBeNull()
  })

  it('leaves the chapter blank when nothing is confident', () => {
    expect(extractChapterNumber('My Series [English]')).toBeNull()
    expect(extractChapterNumber('My Series (2)')).toBeNull()
    expect(extractChapterNumber('My Series Volume')).toBeNull()
    expect(extractChapterNumber('My Series')).toBeNull()
    expect(extractChapterNumber('')).toBeNull()
    expect(extractChapterNumber(null as unknown as string)).toBeNull()
  })

  it('does not mistake a number mid-title for a chapter', () => {
    expect(extractChapterNumber('My 2 Series')).toBeNull()
  })
})

// ─── findCommonSeriesName ────────────────────────────────────────────────────

describe('findCommonSeriesName', () => {
  it('extracts the common series from numbered instalments', () => {
    expect(
      findCommonSeriesName(['My Favorite Series Ch. 1 [English]', 'My Favorite Series Ch. 2 [English]'])
    ).toBe('My Favorite Series')
  })

  it('strips the [Circle (Artist)] and (C92) conventions', () => {
    expect(
      findCommonSeriesName([
        '(C92) [Circle (Artist)] My Series Ch. 1 [English]',
        '(C92) [Circle (Artist)] My Series Ch. 2 [English]'
      ])
    ).toBe('My Series')
  })

  it('handles titles that are identical except the chapter', () => {
    expect(
      findCommonSeriesName(['Same Title Ch. 1', 'Same Title Ch. 2', 'Same Title Ch. 3'])
    ).toBe('Same Title')
  })

  it('handles different chapter words across instalments', () => {
    expect(
      findCommonSeriesName(['My Series Chapter 1', 'My Series Ch. 2', 'My Series Ep. 3'])
    ).toBe('My Series')
  })

  it('preserves Japanese text in the series name', () => {
    expect(findCommonSeriesName(['シリーズ Ch. 1', 'シリーズ Ch. 2'])).toBe('シリーズ')
  })

  it('preserves special characters that are part of the name', () => {
    expect(
      findCommonSeriesName(['Series [Side] Ch. 1', 'Series [Side] Ch. 2'])
    ).toBe('Series [Side]')
  })

  it('returns empty when titles share nothing meaningful', () => {
    expect(findCommonSeriesName(['Alpha One', 'Beta Two'])).toBe('')
    expect(findCommonSeriesName(['The Fox', 'The Dog'])).toBe('')
  })

  it('returns empty for a single title', () => {
    expect(findCommonSeriesName(['My Series Ch. 1'])).toBe('')
  })

  it('returns empty when the shared fragment is only noise', () => {
    // Both share " Ch. " but nothing else — not a series name.
    expect(findCommonSeriesName(['Alpha Ch. 1', 'Beta Ch. 2'])).toBe('')
  })

  it('returns empty for empty input', () => {
    expect(findCommonSeriesName([])).toBe('')
  })
})
