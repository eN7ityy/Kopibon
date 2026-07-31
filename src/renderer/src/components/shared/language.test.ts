import { describe, it, expect } from 'vitest'
import { displayLanguage } from './language'

/**
 * The stored language data is inconsistent because it accumulated from several
 * writers. Measured across the 4,632 library rows at the time of writing:
 *
 *   custom_language: eng 2390 | null 1165 | jpn 398 | en 236 | zho 221
 *                    translated 106 | japanese 79 | english 19
 *   language:        null on every single row
 *
 * So the rules under test are: normalise every observed form, prefer a real
 * language over `translated`, and return null rather than an empty chip.
 */

describe('displayLanguage — stored forms', () => {
  it('maps the ISO 639-2 codes that dominate the data', () => {
    expect(displayLanguage('eng')).toBe('English')
    expect(displayLanguage('jpn')).toBe('Japanese')
    expect(displayLanguage('zho')).toBe('Chinese')
  })

  it('maps ISO 639-1 codes', () => {
    expect(displayLanguage('en')).toBe('English')
    expect(displayLanguage('ja')).toBe('Japanese')
    expect(displayLanguage('zh')).toBe('Chinese')
  })

  it('maps the plain names nhentai uses as tags', () => {
    expect(displayLanguage('english')).toBe('English')
    expect(displayLanguage('japanese')).toBe('Japanese')
  })

  it('is case and whitespace insensitive', () => {
    expect(displayLanguage('  ENG  ')).toBe('English')
    expect(displayLanguage('Japanese')).toBe('Japanese')
  })

  it('reduces a locale to its language subtag', () => {
    expect(displayLanguage('en-US')).toBe('English')
    expect(displayLanguage('zh_Hant')).toBe('Chinese')
  })
})

describe('displayLanguage — the translated rule', () => {
  it('prefers a real language over translated, whatever the order', () => {
    // This is the whole point: `translated` is a language-type tag that is not a
    // language, and it comes first often enough that taking the first value was
    // why file metadata had the wrong language.
    expect(displayLanguage('translated', 'eng')).toBe('English')
    expect(displayLanguage('eng', 'translated')).toBe('English')
  })

  it('falls back to translated only when nothing better exists', () => {
    expect(displayLanguage('translated')).toBe('Translated')
    expect(displayLanguage(null, 'translated')).toBe('Translated')
  })

  it('ignores unrecognised values when a known one follows', () => {
    expect(displayLanguage('rewrite', 'jpn')).toBe('Japanese')
  })
})

describe('displayLanguage — nothing to show', () => {
  it('returns null when every candidate is empty', () => {
    // A quarter of rows have no language at all, and the card must not reserve
    // space for a chip it cannot fill.
    expect(displayLanguage(null, undefined)).toBeNull()
    expect(displayLanguage('', '   ')).toBeNull()
    expect(displayLanguage()).toBeNull()
  })

  it('returns null for a value it does not recognise', () => {
    expect(displayLanguage('speechless')).toBeNull()
  })

  it('handles the real column pairing, where language is always null', () => {
    // resolveLibraryFacts passes (item.language, item.customLanguage) in that
    // order, and item.language is null on every row in practice.
    expect(displayLanguage(null, 'eng')).toBe('English')
    expect(displayLanguage(null, null)).toBeNull()
  })
})
