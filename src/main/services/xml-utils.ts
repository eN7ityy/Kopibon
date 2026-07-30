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

/** Map human-readable language names to ISO 639-1 codes for dc:language. */
const LANGUAGE_TO_ISO: Record<string, string> = {
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
  other: 'ot'
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
