/**
 * ComicInfo.xml — the parse side.
 *
 * Writing is no longer done here. The bytes come from
 * `resources/metadata-templates/comicinfo.template`, mapped from a
 * `FileMetadata` by `services/metadata/mappers.ts`, so that what this app
 * writes can be changed by editing a text file. Reading stays in code: it has
 * to cope with every shape this library has accumulated over the years,
 * including files written by other tools.
 *
 * Pure and synchronous — no file or ZIP access, so it is trivially testable.
 */

import { decodeXmlEntities } from './xml-utils'

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * What `parseComicInfoXml` can recover from a ComicInfo.xml.
 *
 * A read-side shape only. The write side starts from `FileMetadata`, which
 * carries considerably more — see `services/metadata/file-metadata.ts`.
 */
export interface ComicInfoMetadata {
  title: string
  series: string
  /** Position within the series, read from Number or from a legacy Volume. */
  volume?: number | null
  summary?: string | null
  writers: string[]
  publisher?: string | null
  /** nhentai category tags. */
  genres: string[]
  /** nhentai tag-type tags. */
  tags: string[]
  characters: string[]
  webUrl?: string | null
  notes?: string | null
  pageCount: number
  languageIso?: string | null
  releaseDate?: Date | null
  ageRating: string
  manga: 'Yes' | 'YesAndRightToLeft' | 'No'
  /** Optional parody, which Kavita treats as a collection. */
  seriesGroup?: string | null
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
