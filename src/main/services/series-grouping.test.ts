import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MIN_SERIES_MEMBERS,
  findVolumeGaps,
  isGroupableSeriesName,
  mergeSeriesFacts,
  normaliseSeriesName,
  pickSeriesCover,
  sortSeriesMembers,
  type SeriesFactsMember
} from './series-grouping'

/**
 * The cases here are taken from the live library rather than invented, because
 * every one of them broke a plausible-looking first implementation:
 *
 *   'Smoking Hypnosis'  15 members, volumes 1-8, 14, 17-19, 21, then 99 and 100
 *   'unspecified'       4 members, 4 different artists, not a series at all
 *   7 items             in a multi-member series with no volume number
 *   13 series           with two members sharing one volume number
 */

describe('isGroupableSeriesName', () => {
  it('rejects the placeholder names that are in the library', () => {
    // Four unrelated one-shots by four artists carry this. Grouping them would
    // invent a series.
    expect(isGroupableSeriesName('unspecified')).toBe(false)
    expect(isGroupableSeriesName('Unspecified')).toBe(false)
    expect(isGroupableSeriesName('  N/A  ')).toBe(false)
    expect(isGroupableSeriesName('')).toBe(false)
    expect(isGroupableSeriesName('   ')).toBe(false)
    expect(isGroupableSeriesName(null)).toBe(false)
    expect(isGroupableSeriesName(undefined)).toBe(false)
  })

  it('accepts real series names', () => {
    expect(isGroupableSeriesName('Smoking Hypnosis')).toBe(true)
    expect(isGroupableSeriesName('Dolls')).toBe(true)
    // Non-Latin names must not be filtered by any incidental ASCII assumption.
    expect(isGroupableSeriesName('吸烟洗脑')).toBe(true)
  })

  it('does not reject a name just because it could be a title', () => {
    // 2,337 items default series_name to their own title. Those are excluded by
    // the member threshold, not by guessing here — two items that genuinely
    // share a title and a series are a series.
    expect(isGroupableSeriesName('Mousou Log 04')).toBe(true)
  })

  it('normalises away surrounding whitespace', () => {
    expect(normaliseSeriesName('  Dolls  ')).toBe('Dolls')
    expect(normaliseSeriesName('   ')).toBeNull()
    expect(normaliseSeriesName(null)).toBeNull()
  })
})

describe('sortSeriesMembers', () => {
  it('orders by volume', () => {
    const members = [
      { id: 3, seriesIndex: 3, title: 'c' },
      { id: 1, seriesIndex: 1, title: 'a' },
      { id: 2, seriesIndex: 2, title: 'b' }
    ]
    expect(sortSeriesMembers(members).map((m) => m.id)).toEqual([1, 2, 3])
  })

  it('sorts volume 10 after volume 9, not after volume 1', () => {
    // Guards the premise: these are numbers, and a string sort would be wrong.
    const members = [
      { id: 10, seriesIndex: 10, title: 'ten' },
      { id: 1, seriesIndex: 1, title: 'one' },
      { id: 9, seriesIndex: 9, title: 'nine' }
    ]
    expect(sortSeriesMembers(members).map((m) => m.seriesIndex)).toEqual([1, 9, 10])
  })

  it('puts members with no volume last', () => {
    // Seven live items are in this state. Ahead of volume 1 they would decide
    // the group's cover.
    const members = [
      { id: 1, seriesIndex: null, title: 'unnumbered' },
      { id: 2, seriesIndex: 2, title: 'two' },
      { id: 3, seriesIndex: 1, title: 'one' }
    ]
    expect(sortSeriesMembers(members).map((m) => m.id)).toEqual([3, 2, 1])
  })

  it('breaks a shared volume number by title', () => {
    // Thirteen series have two members on one number.
    const members = [
      { id: 1, seriesIndex: 4, title: 'Beta' },
      { id: 2, seriesIndex: 4, title: 'Alpha' }
    ]
    expect(sortSeriesMembers(members).map((m) => m.id)).toEqual([2, 1])
  })

  it('does not mutate its input', () => {
    const members = [
      { id: 2, seriesIndex: 2, title: 'b' },
      { id: 1, seriesIndex: 1, title: 'a' }
    ]
    sortSeriesMembers(members)
    expect(members.map((m) => m.id)).toEqual([2, 1])
  })
})

describe('pickSeriesCover', () => {
  const members = [
    { id: 20, seriesIndex: 2, title: 'two' },
    { id: 10, seriesIndex: 1, title: 'one' }
  ]

  it('defaults to the first volume', () => {
    expect(pickSeriesCover(members)).toEqual({ memberId: 10 })
  })

  it('honours a chosen member', () => {
    expect(pickSeriesCover(members, { coverItemId: 20 })).toEqual({ memberId: 20 })
  })

  it('falls back when the chosen member has been deleted', () => {
    // The whole reason the override is validated against the members: a series
    // whose cover item was removed should quietly revert, not render blank.
    expect(pickSeriesCover(members, { coverItemId: 999 })).toEqual({ memberId: 10 })
  })

  it('lets an explicit image win over a chosen member', () => {
    expect(pickSeriesCover(members, { coverItemId: 20, coverPath: '/covers/x.jpg' })).toEqual({
      coverPath: '/covers/x.jpg'
    })
  })

  it('ignores a blank cover path rather than treating it as a choice', () => {
    expect(pickSeriesCover(members, { coverPath: '   ' })).toEqual({ memberId: 10 })
  })

  it('returns null for an empty series', () => {
    expect(pickSeriesCover([])).toBeNull()
  })
})

describe('findVolumeGaps', () => {
  it('reports the gaps in Smoking Hypnosis without inventing 77 more', () => {
    // The real volume list. 21 → 99 is a change of numbering scheme for bonus
    // chapters; reporting volumes 22 to 98 as missing would make the warning
    // useless everywhere else.
    const volumes = [1, 2, 3, 4, 5, 6, 7, 8, 14, 17, 18, 19, 21, 99, 100]
    expect(findVolumeGaps(volumes)).toEqual([9, 10, 11, 12, 13, 15, 16, 20])
  })

  it('finds nothing in a complete run', () => {
    expect(findVolumeGaps([1, 2, 3, 4, 5])).toEqual([])
  })

  it('ignores fractional volumes rather than reporting them as gaps', () => {
    // 1.5 is an extra between volumes, not evidence that anything is missing.
    expect(findVolumeGaps([1, 1.5, 2])).toEqual([])
  })

  it('does not report anything before the first or after the last volume', () => {
    // A series numbered from 3 is far more likely numbered that way than
    // missing its first two volumes.
    expect(findVolumeGaps([3, 4, 5])).toEqual([])
  })

  it('tolerates missing and duplicate numbers', () => {
    expect(findVolumeGaps([null, 1, 1, 3, null])).toEqual([2])
  })

  it('needs at least two volumes to say anything', () => {
    expect(findVolumeGaps([5])).toEqual([])
    expect(findVolumeGaps([])).toEqual([])
    expect(findVolumeGaps([null, null])).toEqual([])
  })
})

describe('mergeSeriesFacts', () => {
  const member = (over: Partial<SeriesFactsMember> = {}): SeriesFactsMember => ({
    format: 'cbz',
    language: 'english',
    customLanguage: null,
    primaryArtist: 'dr. stein',
    customTags: null,
    ...over
  })

  it('reports one format when the members agree', () => {
    expect(mergeSeriesFacts([member(), member()]).format).toBe('cbz')
  })

  it('reports mixed when they do not', () => {
    // A part-converted series is exactly the case where showing 'cbz' would
    // mislead someone into thinking conversion had finished.
    expect(mergeSeriesFacts([member(), member({ format: 'pdf' })]).format).toBe('mixed')
  })

  it('has no format when no member states one', () => {
    expect(mergeSeriesFacts([member({ format: null }), member({ format: '' })]).format).toBeNull()
  })

  it('orders artists by how many members they wrote', () => {
    // Twelve live series span more than one artist, so the card has to choose
    // which to lead with.
    const facts = mergeSeriesFacts([
      member({ primaryArtist: 'guest' }),
      member({ primaryArtist: 'dr. stein' }),
      member({ primaryArtist: 'dr. stein' })
    ])
    expect(facts.artists).toEqual(['dr. stein', 'guest'])
  })

  it('unions tags by frequency and merges differing capitalisation', () => {
    const facts = mergeSeriesFacts([
      member({ customTags: 'netorare, big breasts' }),
      member({ customTags: 'Netorare, corruption' })
    ])
    // 'netorare' twice, then the two singles alphabetically. The first spelling
    // seen is the one displayed.
    expect(facts.tags).toEqual(['netorare', 'big breasts', 'corruption'])
  })

  it('orders equally common tags alphabetically so the display is stable', () => {
    // Without the tiebreak, adding an unrelated volume would silently reshuffle
    // the tag row of an untouched series.
    const facts = mergeSeriesFacts([member({ customTags: 'zebra, alpha' })])
    expect(facts.tags).toEqual(['alpha', 'zebra'])
  })

  it('lets a corrected language replace the one it overrides', () => {
    // customLanguage overrides language on an item; listing both would show a
    // series as being in two languages when a member was simply corrected.
    const facts = mergeSeriesFacts([
      member({ language: 'japanese', customLanguage: 'english' }),
      member({ language: 'english', customLanguage: null })
    ])
    expect(facts.languages).toEqual(['english'])
  })

  it('drops empty tag fragments from trailing commas', () => {
    expect(mergeSeriesFacts([member({ customTags: 'anal,, ,mosaic,' })]).tags).toEqual([
      'anal',
      'mosaic'
    ])
  })

  it('survives a series with no metadata at all', () => {
    const facts = mergeSeriesFacts([
      { format: null, language: null, customLanguage: null, primaryArtist: null, customTags: null }
    ])
    expect(facts).toEqual({ format: null, artists: [], languages: [], tags: [] })
  })
})

describe('DEFAULT_MIN_SERIES_MEMBERS', () => {
  it('is two, which is what keeps 2,493 defaulted names invisible', () => {
    expect(DEFAULT_MIN_SERIES_MEMBERS).toBe(2)
  })
})
