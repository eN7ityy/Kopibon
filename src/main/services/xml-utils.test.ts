import { describe, it, expect } from 'vitest'
import {
  escapeXml,
  decodeXmlEntities,
  toIsoLanguage,
  resolveLanguageName,
  CANONICAL_LANGUAGES
} from './xml-utils'

/**
 * Regression cover for the escaping bug that shipped TWICE in this project:
 * once in xmp-inject's escXml() and again in the shared escapeXml() during the
 * CBZ work. Both times every character was replaced with itself, so `&` in a
 * title produced invalid XML that no downstream reader could parse.
 *
 * The entity literals below are built by concatenation on purpose. Writing
 * '&amp;' directly in a source file is exactly what got mangled before, so the
 * tests must not depend on it either.
 */
const AMP_ENT = '&' + 'amp;'
const LT_ENT = '&' + 'lt;'
const GT_ENT = '&' + 'gt;'
const QUOT_ENT = '&' + 'quot;'
const APOS_ENT = '&' + '#39;'

const AMP = '&'
const LT = '<'
const GT = '>'
const QUOT = '"'
const APOS = String.fromCharCode(39)

describe('escapeXml', () => {
  it.each([
    ['ampersand', AMP, AMP_ENT],
    ['less-than', LT, LT_ENT],
    ['greater-than', GT, GT_ENT],
    ['double quote', QUOT, QUOT_ENT],
    ['apostrophe', APOS, APOS_ENT]
  ])('escapes %s', (_name, char, entity) => {
    expect(escapeXml(`a${char}b`)).toBe(`a${entity}b`)
  })

  it('does not leave the character unchanged (the original bug)', () => {
    expect(escapeXml(AMP)).not.toBe(AMP)
    expect(escapeXml(LT)).not.toBe(LT)
  })

  it('escapes the ampersand first so entities are not double-escaped', () => {
    // If '<' were escaped before '&', the '&' of '&lt;' would be escaped again.
    expect(escapeXml(LT)).toBe(LT_ENT)
  })

  it('strips control characters illegal in XML 1.0', () => {
    const withControl = 'a' + String.fromCharCode(1) + String.fromCharCode(31) + 'b'
    expect(escapeXml(withControl)).toBe('ab')
  })

  it('keeps tab, newline and carriage return', () => {
    expect(escapeXml('a\tb\nc\rd')).toBe('a\tb\nc\rd')
  })

  it('leaves non-ASCII text alone', () => {
    expect(escapeXml('火星の敗北')).toBe('火星の敗北')
  })

  it('produces no bare ampersand for a realistic title', () => {
    const out = escapeXml(`Fate ${AMP} Grand Order ${LT}Alt${GT} Jane${APOS}s`)
    expect(out).not.toMatch(/&(?!(amp|lt|gt|quot|#39);)/)
  })
})

describe('decodeXmlEntities', () => {
  it.each([
    ['ampersand', AMP_ENT, AMP],
    ['less-than', LT_ENT, LT],
    ['greater-than', GT_ENT, GT],
    ['double quote', QUOT_ENT, QUOT],
    ['apostrophe', APOS_ENT, APOS]
  ])('decodes %s', (_name, entity, char) => {
    expect(decodeXmlEntities(`a${entity}b`)).toBe(`a${char}b`)
  })

  it('decodes decimal and hex numeric entities', () => {
    expect(decodeXmlEntities('&' + '#65;')).toBe('A')
    expect(decodeXmlEntities('&' + '#x41;')).toBe('A')
  })

  it('decodes the ampersand last, so entity-looking text is not double-decoded', () => {
    // '&amp;lt;' means the literal text '&lt;', NOT '<'
    expect(decodeXmlEntities(AMP_ENT + 'lt;')).toBe(LT_ENT)
  })
})

describe('escape/decode round trip', () => {
  it.each([
    `Fate ${AMP} Grand Order`,
        `Smoking Hypnosis EP.13 ${AMP} Jane${APOS}s Husband Story`,
    `${LT}tag${GT} and ${QUOT}quoted${QUOT}`,
    // Input that already looks like markup must survive verbatim
    LT_ENT,
    AMP_ENT,
    AMP_ENT + 'lt;',
    `100${GT}50 ${AMP}${AMP} done`,
    '火星の敗北2-対決！'
  ])('round-trips %j unchanged', (original) => {
    expect(decodeXmlEntities(escapeXml(original))).toBe(original)
  })
})

describe('toIsoLanguage', () => {
  it.each([
    ['english', 'en'],
    ['Japanese', 'ja'],
    ['CHINESE', 'zh'],
    ['korean', 'ko']
  ])('maps %s to %s', (input, expected) => {
    expect(toIsoLanguage(input)).toBe(expected)
  })

  it('passes through an existing two-letter code', () => {
    expect(toIsoLanguage('en')).toBe('en')
  })

  it.each([
    ['eng', 'en'],
    ['jpn', 'ja'],
    ['zho', 'zh'],
    ['chi', 'zh'],
    ['KOR', 'ko'],
    ['ger', 'de'],
    ['deu', 'de']
  ])('maps the ISO 639-2 code %s to %s', (input, expected) => {
    // These are what the scanner actually reads out of existing PDF XMP, and
    // they are the majority of the library: 2,390 rows read 'eng', 398 'jpn',
    // 221 'zho'. Unmapped, they produced files with no language at all.
    expect(toIsoLanguage(input)).toBe(expected)
  })

  it('returns null rather than fabricating a code for a non-language', () => {
    // 'translated' is an nhentai tag, not a language, and really does appear in
    // the library's language column. A wrong ISO code is worse than none.
    expect(toIsoLanguage('translated')).toBeNull()
    expect(toIsoLanguage('scanlated')).toBeNull()
  })

  it('returns null for empty and nullish input', () => {
    expect(toIsoLanguage('')).toBeNull()
    expect(toIsoLanguage('   ')).toBeNull()
    expect(toIsoLanguage(null)).toBeNull()
    expect(toIsoLanguage(undefined)).toBeNull()
  })
})

describe('resolveLanguageName', () => {
  // The four combinations the API actually returns for this library, with their
  // observed frequencies. 'translated' always comes FIRST when present, which is
  // why taking the first language tag mislabelled most downloads.
  it.each([
    [['translated', 'english'], 'English', 18],
    [['japanese'], 'Japanese', 15],
    [['translated', 'chinese'], 'Chinese', 9],
    [['english'], 'English', 2]
  ])('resolves %j to %s (seen %i times)', (tags, expected) => {
    expect(resolveLanguageName(tags as string[])).toBe(expected)
  })

  it('never returns a non-language, whatever the order', () => {
    expect(resolveLanguageName(['translated'])).toBeNull()
    expect(resolveLanguageName(['translated', 'rewrite', 'speechless'])).toBeNull()
    expect(resolveLanguageName(['english', 'translated'])).toBe('English')
  })

  it('prefers the readable language over the original', () => {
    // A translated Japanese work: the text a reader sees is English.
    expect(resolveLanguageName(['japanese', 'translated', 'english'])).toBe('English')
  })

  it('accepts ISO 639-1 and 639-2 spellings, and is case-insensitive', () => {
    expect(resolveLanguageName(['en'])).toBe('English')
    expect(resolveLanguageName(['eng'])).toBe('English')
    expect(resolveLanguageName(['ENGLISH'])).toBe('English')
    expect(resolveLanguageName(['jpn'])).toBe('Japanese')
    expect(resolveLanguageName(['ja'])).toBe('Japanese')
    expect(resolveLanguageName(['zho'])).toBe('Chinese')
    expect(resolveLanguageName(['chi'])).toBe('Chinese')
    expect(resolveLanguageName(['  Chinese  '])).toBe('Chinese')
  })

  it('reduces a locale tag to its primary subtag', () => {
    expect(resolveLanguageName(['en-US'])).toBe('English')
    expect(resolveLanguageName(['zh_Hans'])).toBe('Chinese')
  })

  it('only ever returns one of the three canonical names, or null', () => {
    const inputs = [
      'english', 'japanese', 'chinese', 'translated', 'rewrite', 'korean',
      'en', 'jpn', 'zho', '', '   ', 'nonsense'
    ]
    for (const a of inputs) {
      for (const b of inputs) {
        const out = resolveLanguageName([a, b])
        expect(out === null || CANONICAL_LANGUAGES.includes(out)).toBe(true)
      }
    }
  })

  it('returns null for empty input rather than guessing', () => {
    expect(resolveLanguageName([])).toBeNull()
    expect(resolveLanguageName([null, undefined, ''])).toBeNull()
  })

  it('feeds toIsoLanguage cleanly, so emitted files get a real ISO code', () => {
    // The canonical name is what gets stored; the emitters convert on write.
    expect(toIsoLanguage(resolveLanguageName(['translated', 'english']))).toBe('en')
    expect(toIsoLanguage(resolveLanguageName(['japanese']))).toBe('ja')
    expect(toIsoLanguage(resolveLanguageName(['translated', 'chinese']))).toBe('zh')
  })
})
