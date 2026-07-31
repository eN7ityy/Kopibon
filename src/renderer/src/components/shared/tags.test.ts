import { describe, it, expect } from 'vitest'
import { sortTags, sortDescriptiveTags, tagClass, TAG_COLORS } from './tags'

/**
 * The API returns tags in no useful order, so a detail panel could read Genre,
 * Language, three tags, a Parody, then another Language. Type is the most useful
 * thing about a tag when scanning a list, so it groups.
 */

const mixed = [
  { id: 1, type: 'tag', name: 'milf' },
  { id: 2, type: 'language', name: 'translated' },
  { id: 3, type: 'parody', name: 'original' },
  { id: 4, type: 'tag', name: 'big breasts' },
  { id: 5, type: 'category', name: 'doujinshi' },
  { id: 6, type: 'language', name: 'english' },
  { id: 7, type: 'artist', name: 'aiue oka' },
  { id: 8, type: 'character', name: 'a character' },
  { id: 9, type: 'group', name: 'a group' }
]

describe('sortTags', () => {
  it('groups by type in the intended display order', () => {
    expect(sortTags(mixed).map((t) => t.type)).toEqual([
      'artist',
      'group',
      'category',
      'language',
      'language',
      'parody',
      'character',
      'tag',
      'tag'
    ])
  })

  it('sorts alphabetically within a type', () => {
    const langs = sortTags(mixed)
      .filter((t) => t.type === 'language')
      .map((t) => t.name)
    expect(langs).toEqual(['english', 'translated'])

    const tags = sortTags(mixed)
      .filter((t) => t.type === 'tag')
      .map((t) => t.name)
    expect(tags).toEqual(['big breasts', 'milf'])
  })

  it('does not mutate the input', () => {
    // Callers pass `detail.tags` straight in, which belongs to the fetched
    // object — sorting it in place would reorder the source of truth.
    const input = [...mixed]
    const before = input.map((t) => t.id)
    sortTags(input)
    expect(input.map((t) => t.id)).toEqual(before)
  })

  it('puts unknown types last rather than first', () => {
    const withUnknown = [{ id: 99, type: 'mystery', name: 'x' }, ...mixed]
    const types = sortTags(withUnknown).map((t) => t.type)
    expect(types[types.length - 1]).toBe('mystery')
  })

  it('handles an empty list', () => {
    expect(sortTags([])).toEqual([])
  })
})

describe('sortDescriptiveTags', () => {
  it('drops artist and group, which the panels render separately', () => {
    const types = sortDescriptiveTags(mixed).map((t) => t.type)
    expect(types).not.toContain('artist')
    expect(types).not.toContain('group')
    expect(types).toEqual(['category', 'language', 'language', 'parody', 'character', 'tag', 'tag'])
  })

  it('honours a custom exclusion list', () => {
    const types = sortDescriptiveTags(mixed, ['tag']).map((t) => t.type)
    expect(types).not.toContain('tag')
    expect(types[0]).toBe('artist')
  })
})

describe('tagClass', () => {
  it('returns the type-specific class for known types', () => {
    expect(tagClass('artist')).toBe(TAG_COLORS.artist)
    expect(tagClass('parody')).toBe(TAG_COLORS.parody)
  })

  it('falls back to the neutral tag class for anything unknown', () => {
    expect(tagClass('mystery')).toBe(TAG_COLORS.tag)
  })

  it('keeps the accent for artist only', () => {
    // Artist is the field most often scanned for, and the one type that earns
    // the accent; nothing else should claim it.
    const accented = Object.entries(TAG_COLORS).filter(([, v]) => v.includes('accent'))
    expect(accented.map(([k]) => k)).toEqual(['artist'])
  })
})
