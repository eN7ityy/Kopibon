/**
 * ComicInfo.xml — build and parse.
 *
 * Pure synchronous functions with no file or ZIP access, making them
 * trivially unit-testable (§10.1).
 *
 * Kavita supports v2.1 (draft) of the Anansi Project ComicInfo schema.
 * The bundled ComicInfo.xsd in oldScripts/ is v1.0 and MUST NOT be used
 * as the validation target (§4.1).
 */

import { escapeXml, decodeXmlEntities, toIsoLanguage } from './xml-utils'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ComicInfoMetadata {
  title: string
  series: string // never empty — §4.3
  volume?: number | null
  summary?: string | null
  writers: string[] // -> Writer + Penciller
  publisher?: string | null
  genres: string[] // nhentai category tags
  tags: string[] // nhentai tag-type tags
  characters: string[]
  webUrl?: string | null
  notes?: string | null
  pageCount: number
  languageIso?: string | null // en / ja / zh — emit nothing if unrecognised (§4.2)
  releaseDate?: Date | null // -> Year/Month/Day — omit on scanner stubs (§C.2)
  ageRating: string // 'Adults Only 18+'
  manga: 'Yes' | 'YesAndRightToLeft' | 'No'
  seriesGroup?: string | null // optional parody -> collections
  /**
   * Whether this file genuinely belongs to a series.
   *
   * Decides whether it gets a Number. It has to be stated rather than inferred:
   * the old test was `series !== title`, which is wrong whenever a series is
   * named after its first instalment — a very common case. "Seijo no Mita
   * Yume" volume 1 is titled exactly that, so it went unnumbered while volume 2
   * got a number, and Kavita filed volume 1 as a Special. That is the bug this
   * field exists to close.
   *
   * Callers know the answer: they either had a series name to pass or they did
   * not. Left unset, the old heuristic still applies.
   */
  partOfSeries?: boolean
}

// ─── Build ────────────────────────────────────────────────────────────────────

/**
 * Build a ComicInfo.xml string from structured metadata.
 *
 * Rules enforced:
 * - `Series` is always written (§4.3)
 * - `Number` is written only for a genuine series member; `Volume` never is
 * - `Count` and `Format` are NEVER written (§4.4, §4.6)
 * - `Year/Month/Day` only written when releaseDate is provided (§C.2)
 * - `LanguageISO` only written when value is a recognised ISO code (§4.2, §C.5)
 * - Empty arrays are omitted
 * - null/undefined optional fields are omitted
 */
export function buildComicInfoXml(meta: ComicInfoMetadata): string {
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="utf-8"?>')
  lines.push('<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="ComicInfo.xsd">')

  // Title (maps to Kavita Chapter Title)
  lines.push(`  <Title>${escapeXml(meta.title)}</Title>`)

  // Series — ALWAYS written (§4.3). Falls back to title when no series name.
  lines.push(`  <Series>${escapeXml(meta.series)}</Series>`)

  /*
   * Number — the position of this file within its series.
   *
   * Kavita groups on Series and orders on Number. A file carrying neither
   * Number nor Volume is filed as a **Special**, which is what a library of
   * these looked like: every instalment of a series showing up loose, and some
   * of them as Specials.
   *
   * Number rather than Volume. Each file here is one instalment, so Number
   * gives a series with N ordered chapters. Volume would nest each file in a
   * volume of its own containing a single chapter — it groups, but describes
   * something the data does not mean.
   *
   * Still gated on the series being real. When Series falls back to the title
   * the file is a one-shot, and a one-shot is not chapter 1 of anything;
   * numbering it would create a one-chapter series per file, which is the same
   * mess from the other direction.
   *
   * This replaces a rule that wrote Volume under the same condition and never
   * wrote Number at all. That rule cited a spec section which is not in this
   * repository, and it produced exactly the grouping failure above.
   */
  const inSeries = meta.partOfSeries ?? meta.series !== meta.title
  if (meta.volume != null && meta.volume > 0 && inSeries) {
    lines.push(`  <Number>${meta.volume}</Number>`)
  }

  // Count and Format are still never written.

  // Summary
  if (meta.summary) {
    lines.push(`  <Summary>${escapeXml(meta.summary)}</Summary>`)
  }

  // Writer + Penciller (doujin artists both write and draw)
  if (meta.writers.length > 0) {
    const writerStr = meta.writers.map((w) => escapeXml(w)).join(', ')
    lines.push(`  <Writer>${writerStr}</Writer>`)
    lines.push(`  <Penciller>${writerStr}</Penciller>`)
  }

  // Publisher — group as publisher
  if (meta.publisher) {
    lines.push(`  <Publisher>${escapeXml(meta.publisher)}</Publisher>`)
  }

  // Genre — nhentai category tags (usually empty for stubs, §C.3)
  if (meta.genres.length > 0) {
    lines.push(`  <Genre>${meta.genres.map((g) => escapeXml(g)).join(', ')}</Genre>`)
  }

  // Tags — nhentai tag-type tags (v2.0+ field)
  if (meta.tags.length > 0) {
    lines.push(`  <Tags>${meta.tags.map((t) => escapeXml(t)).join(', ')}</Tags>`)
  }

  // Characters — schema-correct, harmless enrichment
  if (meta.characters.length > 0) {
    lines.push(`  <Characters>${meta.characters.map((c) => escapeXml(c)).join(', ')}</Characters>`)
  }

  // Web — ID recovery path
  if (meta.webUrl) {
    lines.push(`  <Web>${escapeXml(meta.webUrl)}</Web>`)
  }

  // Notes — provenance + second ID recovery path
  if (meta.notes) {
    lines.push(`  <Notes>${escapeXml(meta.notes)}</Notes>`)
  }

  // PageCount
  lines.push(`  <PageCount>${meta.pageCount}</PageCount>`)

  // LanguageISO — only if the value is a recognised ISO code (§4.2, §C.5).
  // No raw-value fallback: nhentai's language-type tags include 'translated'
  // and 'rewrite', which are not languages. Emitting one produced
  // <LanguageISO>translated</LanguageISO> on a real conversion. An absent
  // language is better than a wrong one, which is what toIsoLanguage()
  // returning null is telling us.
  const iso = toIsoLanguage(meta.languageIso)
  if (iso) {
    lines.push(`  <LanguageISO>${escapeXml(iso)}</LanguageISO>`)
  }

  // Year/Month/Day — only when releaseDate is provided (real gallery row, §C.2)
  // and only when it is a *valid* Date. `new Date('garbage')` is an Invalid
  // Date, which is truthy, and getFullYear() on it returns NaN — guarding here
  // rather than at each caller makes "never emits NaN" a property of this
  // function regardless of who calls it.
  if (meta.releaseDate && Number.isFinite(meta.releaseDate.getTime())) {
    const y = meta.releaseDate.getFullYear()
    const m = String(meta.releaseDate.getMonth() + 1).padStart(2, '0')
    const d = String(meta.releaseDate.getDate()).padStart(2, '0')
    lines.push(`  <Year>${y}</Year>`)
    lines.push(`  <Month>${m}</Month>`)
    lines.push(`  <Day>${d}</Day>`)
  }

  // AgeRating
  lines.push(`  <AgeRating>${escapeXml(meta.ageRating)}</AgeRating>`)

  // Manga (reading direction)
  lines.push(`  <Manga>${escapeXml(meta.manga)}</Manga>`)

  // SeriesGroup — optional parody/collection behind a setting (§4.2)
  if (meta.seriesGroup) {
    lines.push(`  <SeriesGroup>${escapeXml(meta.seriesGroup)}</SeriesGroup>`)
  }

  lines.push('</ComicInfo>')
  return lines.join('\n')
}

// ─── Parse ────────────────────────────────────────────────────────────────────

/**
 * Parse a ComicInfo.xml string into a Partial<ComicInfoMetadata>.
 *
 * Uses per-field regex extraction rather than a full XML parser (the schema
 * is flat — no nesting except optional <Pages>, which we do not read).
 * Entities are decoded so that e.g. `&` round-trips to `&` (§4.7).
 *
 * Returns a partial object — only fields found in the XML are set.
 */
export function parseComicInfoXml(xml: string): Partial<ComicInfoMetadata> {
  const result: Partial<ComicInfoMetadata> = {}

  const text = (raw: string): string => decodeXmlEntities(raw.trim())

  const extract = (tag: string): string | null => {
    const re = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, 'i')
    const m = xml.match(re)
    return m ? text(m[1]) : null
  }

  const title = extract('Title')
  if (title) result.title = title

  const series = extract('Series')
  if (series) result.series = series

  /*
   * Position within the series, from Number first and Volume second.
   *
   * The writer emits Number. Volume is still read because every file written
   * before that change used it, and the scanner takes `seriesIndex` from here
   * — reading only Number would drop the index from the whole existing library
   * on the next rescan, and reading only Volume would drop it from everything
   * written from now on.
   */
  const indexStr = extract('Number') || extract('Volume')
  if (indexStr) {
    const parsed = parseFloat(indexStr)
    if (!isNaN(parsed)) result.volume = parsed
  }

  const summary = extract('Summary')
  if (summary) result.summary = summary

  const writers = extract('Writer')
  if (writers) {
    result.writers = writers.split(',').map((s) => s.trim()).filter(Boolean)
  }

  const publisher = extract('Publisher')
  if (publisher) result.publisher = publisher

  const genres = extract('Genre')
  if (genres) {
    result.genres = genres.split(',').map((s) => s.trim()).filter(Boolean)
  }

  const tags = extract('Tags')
  if (tags) {
    result.tags = tags.split(',').map((s) => s.trim()).filter(Boolean)
  }

  const characters = extract('Characters')
  if (characters) {
    result.characters = characters.split(',').map((s) => s.trim()).filter(Boolean)
  }

  const webUrl = extract('Web')
  if (webUrl) result.webUrl = webUrl

  const notes = extract('Notes')
  if (notes) result.notes = notes

  const pageCountStr = extract('PageCount')
  if (pageCountStr) {
    const parsed = parseInt(pageCountStr, 10)
    if (!isNaN(parsed)) result.pageCount = parsed
  }

  const languageIso = extract('LanguageISO')
  if (languageIso) result.languageIso = languageIso

  // Year/Month/Day — only if Year is present
  const yearStr = extract('Year')
  if (yearStr) {
    const y = parseInt(yearStr, 10)
    const mStr = extract('Month')
    const dStr = extract('Day')
    const m = mStr ? parseInt(mStr, 10) : 1
    const d = dStr ? parseInt(dStr, 10) : 1
    if (!isNaN(y)) {
      result.releaseDate = new Date(y, Math.max(0, (m || 1) - 1), d || 1)
    }
  }

  const ageRating = extract('AgeRating')
  if (ageRating) result.ageRating = ageRating as ComicInfoMetadata['ageRating']

  const manga = extract('Manga')
  if (manga && (manga === 'Yes' || manga === 'YesAndRightToLeft' || manga === 'No')) {
    result.manga = manga
  }

  const seriesGroup = extract('SeriesGroup')
  if (seriesGroup) result.seriesGroup = seriesGroup

  return result
}
