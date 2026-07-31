/**
 * Shared XML utilities — escaping, entity decoding, and language mapping.
 *
 * Extracted from xmp-inject.ts so both the XMP path and the ComicInfo path
 * use the same escaping/decoding logic without duplication.
 */

// ─── Entities (built by string concatenation to prevent source corruption) ───

const AMP = '&' + 'amp;'
const LT = '&' + 'lt;'
const GT = '&' + 'gt;'
const QUOT = '&' + 'quot;'
const APOS = '&#' + '39;'

// ─── Escaping ─────────────────────────────────────────────────────────────────

/** Characters that are illegal in XML 1.0 even when escaped. */
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g

/**
 * Escape text for inclusion in XML element text or attribute values.
 *
 * Each entity replacement is built via string concatenation so the source
 * file cannot accidentally contain entity-like text that gets mangled.
 */
export function escapeXml(s: string): string {
  return s
    .replace(ILLEGAL_XML_CHARS, '')
    .replace(/&/g, AMP)
    .replace(/</g, LT)
    .replace(/>/g, GT)
    .replace(/"/g, QUOT)
    .replace(/'/g, APOS)
}

/**
 * Decode XML character entities back to their literal characters.
 *
 * This is the inverse of escapeXml(). Must decode `&` last to avoid
 * double-decoding `&lt;` -> `<` instead of `<` -> `<`.
 *
 * Uses the same concatenation trick so the entity patterns are real,
 * not raw characters invisible in the source.
 */
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(new RegExp(escapeRegex(LT), 'g'), '<')
    .replace(new RegExp(escapeRegex(GT), 'g'), '>')
    .replace(new RegExp(escapeRegex(QUOT), 'g'), '"')
    .replace(new RegExp(escapeRegex(APOS), 'g'), "'")
    .replace(new RegExp(escapeRegex(AMP), 'g'), '&') // must come last
}

/** Escape special regex characters in a string so it can be used as a literal pattern. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ─── Language ─────────────────────────────────────────────────────────────────

/**
 * Map language values seen in this library to ISO 639-1 codes.
 *
 * Three sources feed this field, and they do not agree:
 * - nhentai tag names, which are English words (`english`, `japanese`)
 * - `library_item.custom_language`, which the scanner reads out of existing PDF
 *   XMP and which holds **ISO 639-2 three-letter codes** (`eng`, `jpn`, `zho`)
 * - hand-edited values, which are already two-letter codes
 *
 * The three-letter forms are the majority case, not an edge case: measured on
 * this library, 2,390 rows read `eng`, 398 `jpn` and 221 `zho` — together over
 * 60% of the collection. Omitting them meant most converted files carried no
 * language at all.
 */
const LANGUAGE_TO_ISO: Record<string, string> = {
  // nhentai tag names
  english: 'en',
  japanese: 'ja',
  chinese: 'zh',
  korean: 'ko',
  french: 'fr',
  spanish: 'es',
  german: 'de',
  italian: 'it',
  portuguese: 'pt',
  russian: 'ru',
  other: 'ot',
  // ISO 639-2 three-letter codes, as written into PDF XMP. Both the
  // terminological (T) and bibliographic (B) forms appear in the wild, so map
  // both where they differ: zho/chi, deu/ger, fra/fre.
  eng: 'en',
  jpn: 'ja',
  zho: 'zh',
  chi: 'zh',
  kor: 'ko',
  fra: 'fr',
  fre: 'fr',
  spa: 'es',
  deu: 'de',
  ger: 'de',
  ita: 'it',
  por: 'pt',
  rus: 'ru'
}

/**
 * Convert a free-text language value to an ISO 639-1 code.
 *
 * Returns `null` if the input is empty, unrecognisable, or not a valid language
 * (e.g. the free-text value `translated`).
 */
export function toIsoLanguage(lang: string | null | undefined): string | null {
  if (!lang) return null
  const lower = lang.toLowerCase().trim()
  if (!lower) return null
  if (/^[a-z]{2}$/.test(lower)) return lower
  return LANGUAGE_TO_ISO[lower] || null
}

/**
 * The only language values this app stores. Order is priority order.
 *
 * A gallery is one language for our purposes, so a translated Japanese work
 * tagged `japanese, translated, english` resolves to English: that is the
 * language of the text a reader will actually see.
 *
 * Measured on this library, the API only ever returns these four
 * `language`-type tag values — `translated` (27), `english` (20),
 * `japanese` (15), `chinese` (9) — in these combinations:
 *
 *   ('translated', 'english')   18    ('japanese',)   15
 *   ('translated', 'chinese')    9    ('english',)     2
 *
 * Note that `translated` comes *first* whenever it is present, which is why
 * taking the first language tag mislabelled the majority of downloads.
 */
export const CANONICAL_LANGUAGES = ['English', 'Japanese', 'Chinese'] as const

export type CanonicalLanguage = (typeof CANONICAL_LANGUAGES)[number]

/**
 * Every spelling seen for each canonical language: nhentai tag names, ISO 639-1
 * codes, and the ISO 639-2 codes the scanner reads out of existing PDF XMP.
 */
const LANGUAGE_ALIASES: Record<CanonicalLanguage, string[]> = {
  English: ['english', 'en', 'eng'],
  Japanese: ['japanese', 'ja', 'jpn', 'jp'],
  Chinese: ['chinese', 'zh', 'zho', 'chi', 'cn']
}

/**
 * Resolve a gallery's language tags to exactly one canonical name.
 *
 * Values that are not languages — `translated`, `rewrite`, `speechless` — match
 * nothing and are skipped rather than stored. Returns `null` when no candidate
 * names a language we recognise, because an absent language is better than a
 * wrong one: it shows up as missing in the UI and can be corrected, whereas
 * `translated` looks like an answer.
 *
 * @param candidates - Tag names and/or column values, in any order
 */
export function resolveLanguageName(
  candidates: (string | null | undefined)[]
): CanonicalLanguage | null {
  const seen = new Set<string>()
  for (const raw of candidates) {
    if (!raw) continue
    // 'en-US' and 'zh_Hans' both reduce to their primary subtag.
    const norm = raw.toLowerCase().trim().split(/[-_]/)[0]
    if (norm) seen.add(norm)
  }
  if (seen.size === 0) return null

  // Priority order, not input order: 'translated, english' must give English,
  // and if a gallery ever carried both 'japanese' and 'english' the readable
  // language wins.
  for (const name of CANONICAL_LANGUAGES) {
    if (LANGUAGE_ALIASES[name].some((alias) => seen.has(alias))) return name
  }
  return null
}
