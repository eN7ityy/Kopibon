import { describe, it, expect } from 'vitest'
import {
  buildSearchQuery,
  matchDimEntries,
  negationTerm,
  queryHasField,
  type BlockedEntry
} from './search-query'

/**
 * The query string is the one place here where a mistake is invisible: a
 * malformed filter returns the wrong galleries rather than erroring, so nothing
 * tells you it went wrong.
 */

const block = (
  type: BlockedEntry['type'],
  value: string,
  mode: BlockedEntry['mode'] = 'exclude'
): BlockedEntry => ({ type, value, mode })

describe('negationTerm', () => {
  it('emits a typed negation', () => {
    expect(negationTerm(block('artist', 'aiue oka'))).toBe('-artist:"aiue oka"')
    expect(negationTerm(block('tag', 'yuri'))).toBe('-tag:yuri')
  })

  it('quotes only values that contain whitespace', () => {
    // The documented examples are `artist:name` bare and `tag:"big breasts"`
    // quoted, so whitespace is the deciding factor.
    expect(negationTerm(block('tag', 'big breasts'))).toBe('-tag:"big breasts"')
    expect(negationTerm(block('tag', 'milf'))).toBe('-tag:milf')
  })

  it('emits a bare negation for free text', () => {
    expect(negationTerm(block('text', 'netorare'))).toBe('-netorare')
    expect(negationTerm(block('text', 'bad end'))).toBe('-"bad end"')
  })

  it('strips embedded quotes rather than escaping them', () => {
    // The syntax documents no escape, and a stray quote would break the whole
    // query rather than just this term.
    expect(negationTerm(block('tag', 'a"b'))).toBe('-tag:ab')
  })

  it('returns null for an empty value', () => {
    expect(negationTerm(block('tag', '   '))).toBeNull()
  })
})

describe('queryHasField', () => {
  it('detects a field the user already constrained', () => {
    expect(queryHasField('language:japanese', 'language')).toBe(true)
    expect(queryHasField('cats language:japanese', 'language')).toBe(true)
    expect(queryHasField('-language:english', 'language')).toBe(true)
  })

  it('does not match a field name inside a word', () => {
    expect(queryHasField('reuploaded:cats', 'uploaded')).toBe(false)
    expect(queryHasField('mylanguage:x', 'language')).toBe(false)
  })

  it('is false for an unrelated query', () => {
    expect(queryHasField('big breasts', 'language')).toBe(false)
  })
})

describe('buildSearchQuery', () => {
  it('uses the typed query and appends the defaults', () => {
    const q = buildSearchQuery('cats', { language: 'english', minPages: 10 }, [])
    expect(q).toBe('cats language:english pages:>10')
  })

  it('falls back to the default search only when nothing is typed', () => {
    const defaults = { defaultQuery: 'artist:aiue-oka' }
    expect(buildSearchQuery('', defaults, [])).toBe('artist:aiue-oka')
    expect(buildSearchQuery('cats', defaults, [])).toBe('cats')
  })

  it('does not override a filter the user typed explicitly', () => {
    // Searching language:japanese with an English default must not ask for both.
    const q = buildSearchQuery('language:japanese', { language: 'english' }, [])
    expect(q).toBe('language:japanese')
  })

  it('appends numeric and date filters in the documented forms', () => {
    const q = buildSearchQuery(
      'cats',
      { minPages: 10, minFavorites: 100, uploadedWithinDays: 30 },
      []
    )
    expect(q).toContain('pages:>10')
    expect(q).toContain('favorites:>=100')
    expect(q).toContain('uploaded:<30d')
  })

  it('ignores zero and negative thresholds', () => {
    const q = buildSearchQuery('cats', { minPages: 0, minFavorites: -5 }, [])
    expect(q).toBe('cats')
  })

  it('adds a negation for each exclude entry', () => {
    const q = buildSearchQuery('cats', {}, [block('tag', 'yuri'), block('artist', 'someone else')])
    expect(q).toBe('cats -tag:yuri -artist:"someone else"')
  })

  it('never negates a dim entry', () => {
    // The whole point of dimming is that the gallery still arrives.
    const q = buildSearchQuery('cats', {}, [block('tag', 'yuri', 'dim')])
    expect(q).toBe('cats')
  })

  it('does not repeat an identical negation', () => {
    const q = buildSearchQuery('cats', {}, [block('tag', 'Yuri'), block('tag', 'yuri')])
    expect(q).toBe('cats -tag:Yuri')
  })

  it('produces a usable query when everything is empty', () => {
    expect(buildSearchQuery('', {}, [])).toBe('')
  })

  it('can build a query from defaults and blocks alone', () => {
    const q = buildSearchQuery('', { defaultQuery: 'artist:aiue-oka', language: 'english' }, [
      block('tag', 'guro')
    ])
    expect(q).toBe('artist:aiue-oka language:english -tag:guro')
  })

  it('treats the default query as terms, so a bare keyword does not suppress the language default', () => {
    // `defaultQuery: 'english'` is a keyword search, not `language:english`, so
    // the language default still applies. Only an explicit `language:` field
    // suppresses it — the check is on the field, not on the word.
    const q = buildSearchQuery('', { defaultQuery: 'english', language: 'english' }, [])
    expect(q).toBe('english language:english')

    const explicit = buildSearchQuery(
      '',
      { defaultQuery: 'language:english', language: 'japanese' },
      []
    )
    expect(explicit).toBe('language:english')
  })
})

describe('matchDimEntries', () => {
  const facts = {
    title: 'A Story About Cats',
    tags: [
      { type: 'tag', name: 'big breasts' },
      { type: 'artist', name: 'aiue oka' },
      { type: 'language', name: 'english' }
    ]
  }

  it('matches a dim entry on tag name and type', () => {
    const hits = matchDimEntries(facts, [block('tag', 'big breasts', 'dim')])
    expect(hits).toEqual([{ type: 'tag', value: 'big breasts' }])
  })

  it('ignores exclude entries, which are handled by the query', () => {
    expect(matchDimEntries(facts, [block('tag', 'big breasts', 'exclude')])).toEqual([])
  })

  it('requires the type to match, not just the name', () => {
    // 'aiue oka' is an artist here; blocking it as a tag must not match.
    expect(matchDimEntries(facts, [block('tag', 'aiue oka', 'dim')])).toEqual([])
    expect(matchDimEntries(facts, [block('artist', 'aiue oka', 'dim')])).toHaveLength(1)
  })

  it('compares tag names exactly, not as substrings', () => {
    // Substring matching would make a block on 'breast' catch 'big breasts',
    // and a block on 'rape' catch 'grape'.
    expect(matchDimEntries(facts, [block('tag', 'breast', 'dim')])).toEqual([])
  })

  it('is case insensitive', () => {
    expect(matchDimEntries(facts, [block('artist', 'AIUE OKA', 'dim')])).toHaveLength(1)
  })

  it('matches free text as a substring of the title', () => {
    expect(matchDimEntries(facts, [block('text', 'cats', 'dim')])).toHaveLength(1)
    expect(matchDimEntries(facts, [block('text', 'dogs', 'dim')])).toEqual([])
  })

  it('returns every match so the UI can say why', () => {
    const hits = matchDimEntries(facts, [
      block('tag', 'big breasts', 'dim'),
      block('text', 'story', 'dim')
    ])
    expect(hits).toHaveLength(2)
  })

  it('matches nothing when the tags have not been resolved yet', () => {
    // Search results carry tag ids only, so until the cache resolves them a
    // gallery has no tag names and must not be dimmed on a guess.
    expect(matchDimEntries({ title: 'x' }, [block('tag', 'yuri', 'dim')])).toEqual([])
  })
})
