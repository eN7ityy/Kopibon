import { describe, it, expect } from 'vitest'
import { currentToken, replaceToken, formatCount, parseTypedToken, buildTagFilter } from './query-tokens'

describe('currentToken', () => {
  it('returns the whole string when the caret is at the end of one word', () => {
    expect(currentToken('blue', 4)).toEqual({ start: 0, end: 4, text: 'blue' })
  })

  it('returns only the last word when the caret is at the end of several', () => {
    const t = currentToken('artist:"foo" blue', 17)
    expect(t).toEqual({ start: 13, end: 17, text: 'blue' })
  })

  it('treats a quoted phrase as one token despite its internal space', () => {
    const text = 'tag:"big breasts"'
    const t = currentToken(text, text.length)
    expect(t).toEqual({ start: 0, end: text.length, text })
  })

  it('finds the token the caret sits inside, not just the last one', () => {
    // caret between "art" and "ist" of the first term
    const text = 'artist:"foo" tag:"bar"'
    const t = currentToken(text, 3)
    expect(t.text).toBe('artist:"foo"')
  })

  it('returns an empty token when the caret sits on whitespace', () => {
    const text = 'artist:"foo" '
    const t = currentToken(text, text.length)
    expect(t).toEqual({ start: 13, end: 13, text: '' })
  })

  it('returns an empty token for an empty string', () => {
    expect(currentToken('', 0)).toEqual({ start: 0, end: 0, text: '' })
  })

  it('does not run past an unbalanced quote into the rest of the string', () => {
    // The open quote makes everything after it "inside a phrase" until it
    // finds a second quote or the string ends — here there is no second
    // quote, so the token runs to the end rather than stopping at nothing.
    const text = 'tag:"big blue'
    const t = currentToken(text, text.length)
    expect(t.text).toBe(text)
  })

  it('clamps a caret outside the string bounds', () => {
    expect(currentToken('blue', 99)).toEqual({ start: 0, end: 4, text: 'blue' })
    // Clamps to 0, same as a caret sitting right before the word — still
    // inside the token, not an empty one before it.
    expect(currentToken('blue', -5)).toEqual({ start: 0, end: 4, text: 'blue' })
  })

  describe('a multi-word bare phrase (the regression this fixes)', () => {
    // "blue archive" is a real, two-word tag name. Splitting on every space
    // meant the suggestion query was whichever single word the caret
    // happened to be nearer, and a two-word tag could never be found by
    // typing it normally.
    const text = 'blue archive'

    it('stays one token with the caret at the end', () => {
      expect(currentToken(text, text.length)).toEqual({ start: 0, end: 12, text })
    })

    it('stays one token with the caret in the middle of the first word', () => {
      expect(currentToken(text, 2)).toEqual({ start: 0, end: 12, text })
    })

    it('stays one token with the caret in the middle of the second word', () => {
      expect(currentToken(text, 8)).toEqual({ start: 0, end: 12, text })
    })

    it('stays one token with the caret right on the space between them', () => {
      expect(currentToken(text, 4)).toEqual({ start: 0, end: 12, text })
    })
  })

  describe('free text between or after completed terms', () => {
    it('is bounded by a preceding completed term, not merged into it', () => {
      const text = 'artist:"foo" blue archive'
      const t = currentToken(text, text.length)
      expect(t).toEqual({ start: 13, end: 25, text: 'blue archive' })
    })

    it('is bounded by a following completed term too', () => {
      const text = 'blue archive artist:"foo"'
      const t = currentToken(text, 5) // caret inside "archive"
      expect(t).toEqual({ start: 0, end: 12, text: 'blue archive' })
    })

    it('sits between two completed terms without absorbing either', () => {
      const text = 'artist:"foo" blue archive tag:"bar"'
      const t = currentToken(text, 20)
      expect(t.text).toBe('blue archive')
    })

    it('recognises a numeric filter as a boundary term too', () => {
      // pages:>10 is a complete term even though it has no autocomplete of
      // its own — it still has to stop "blue archive" from merging with it.
      const text = 'pages:>10 blue archive'
      const t = currentToken(text, text.length)
      expect(t.text).toBe('blue archive')
    })

    it('still isolates a single bare word when that is all there is', () => {
      // The common single-term case must not regress into always returning
      // the whole free-text run when there is only one word in it anyway.
      const text = 'artist:"foo" blue'
      expect(currentToken(text, text.length).text).toBe('blue')
    })
  })
})

describe('replaceToken', () => {
  it('replaces the only token and adds a trailing space to continue typing', () => {
    const token = currentToken('blue', 4)
    const result = replaceToken('blue', token, 'parody:"blue archive"')
    expect(result.text).toBe('parody:"blue archive" ')
    expect(result.caret).toBe(result.text.length)
  })

  it('leaves an earlier term intact when replacing the last one', () => {
    const text = 'artist:"foo" blue'
    const token = currentToken(text, text.length)
    const result = replaceToken(text, token, 'parody:"blue archive"')
    expect(result.text).toBe('artist:"foo" parody:"blue archive" ')
  })

  it('leaves a later term intact when replacing one in the middle', () => {
    const text = 'blue tag:"big breasts"'
    const token = currentToken(text, 2) // caret inside "blue"
    const result = replaceToken(text, token, 'parody:"blue archive"')
    expect(result.text).toBe('parody:"blue archive" tag:"big breasts"')
  })

  it('collapses a run of existing whitespace after the replaced token', () => {
    const text = 'blue    tag:"x"'
    const token = currentToken(text, 2)
    const result = replaceToken(text, token, 'parody:"blue archive"')
    expect(result.text).toBe('parody:"blue archive" tag:"x"')
  })

  it('replaces a whole multi-word free-text run in one go, not just the word the caret is on', () => {
    const text = 'blue archive'
    const token = currentToken(text, 2) // caret inside "blue", not "archive"
    const result = replaceToken(text, token, 'parody:"blue archive"')
    expect(result.text).toBe('parody:"blue archive" ')
  })

  it('inserts into an empty token without leaving a double space', () => {
    const text = 'artist:"foo" '
    const token = currentToken(text, text.length)
    const result = replaceToken(text, token, 'tag:"big breasts"')
    expect(result.text).toBe('artist:"foo" tag:"big breasts" ')
  })
})

describe('parseTypedToken', () => {
  it('treats a bare word as an all-types query', () => {
    expect(parseTypedToken('blue')).toEqual({ negated: false, type: null, query: 'blue' })
  })

  it('keeps a multi-word bare phrase intact, as one query', () => {
    expect(parseTypedToken('blue archive')).toEqual({
      negated: false,
      type: null,
      query: 'blue archive'
    })
  })

  it('recognises an explicit type prefix', () => {
    expect(parseTypedToken('artist:blu')).toEqual({
      negated: false,
      type: 'artist',
      query: 'blu'
    })
  })

  it('strips an opening quote left over from a previous selection', () => {
    expect(parseTypedToken('artist:"blu')).toEqual({
      negated: false,
      type: 'artist',
      query: 'blu'
    })
  })

  it('strips a trailing quote too, so re-editing a finished value does not double it', () => {
    expect(parseTypedToken('artist:"blue"')).toEqual({
      negated: false,
      type: 'artist',
      query: 'blue'
    })
  })

  it('recognises negation and keeps it out of the search text', () => {
    expect(parseTypedToken('-artist:blu')).toEqual({
      negated: true,
      type: 'artist',
      query: 'blu'
    })
  })

  it('recognises a negated bare word', () => {
    expect(parseTypedToken('-blue')).toEqual({ negated: true, type: null, query: 'blue' })
  })

  it('does not treat an unrecognised prefix as a type', () => {
    // "uploaded" is a real filter but not a tag type — it has no autocomplete.
    expect(parseTypedToken('uploaded:7d')).toEqual({
      negated: false,
      type: null,
      query: 'uploaded:7d'
    })
  })
})

describe('buildTagFilter', () => {
  it('always quotes the value', () => {
    expect(buildTagFilter('artist', 'blue')).toBe('artist:"blue"')
  })

  it('quotes a multi-word value the same way', () => {
    expect(buildTagFilter('parody', 'blue archive')).toBe('parody:"blue archive"')
  })

  it('strips a stray quote already in the name', () => {
    expect(buildTagFilter('tag', 'big "breasts"')).toBe('tag:"big breasts"')
  })

  it('applies negation when asked', () => {
    expect(buildTagFilter('artist', 'blue', true)).toBe('-artist:"blue"')
  })
})

describe('formatCount', () => {
  it('shows small counts exactly', () => {
    expect(formatCount(1)).toBe('1')
    expect(formatCount(999)).toBe('999')
  })

  it('formats thousands with one decimal, dropping a trailing .0', () => {
    expect(formatCount(13868)).toBe('13.9k')
    expect(formatCount(1000)).toBe('1k')
    expect(formatCount(1500)).toBe('1.5k')
  })

  it('formats millions the same way', () => {
    expect(formatCount(2_300_000)).toBe('2.3m')
    expect(formatCount(1_000_000)).toBe('1m')
  })
})
