/**
 * The two mappers: FileMetadata in, template context out.
 *
 * Everything that could be decided differently lives here and nowhere else.
 * If a rule about series numbering, artist fallbacks, publishers or languages
 * needs to change, this is the only file to change it in — the templates say
 * *where* a value goes, the mappers say *what* it is.
 *
 * Both mappers put every fact they have into the context, whether the shipped
 * template uses it or not. Adding `{{titleJapanese}}` to a template is then an
 * edit to a text file rather than a code change.
 *
 * Values are XML-escaped here, because the engine cannot tell markup from text.
 * The docinfo helpers below deliberately return raw values: those are written
 * into a PDF's Info dictionary by pikepdf, not into XML.
 */

import { escapeXml, toIsoLanguage, resolveLanguageName } from '../xml-utils'
import { renderTemplate, type TemplateContext } from './template-engine'
import { loadTemplate, COMICINFO_TEMPLATE, PDF_XMP_TEMPLATE } from './templates'
import type { FileMetadata } from './file-metadata'

/** Reported in both the XMP packet and the PDF Info dictionary. */
export const PDF_PRODUCER = 'pikepdf 10.8.0'

/** The byte-order mark the XMP packet header requires. */
const XMP_BOM = '﻿'

// ─── Policy ──────────────────────────────────────────────────────────────────

/**
 * Whether this file genuinely belongs to a series.
 *
 * Having been given a series name is the whole test. It used to be inferred as
 * `series !== title`, which is wrong whenever a series is named after its first
 * instalment — the common case. Volume 1 then went unnumbered while volume 2
 * was numbered, and Kavita filed volume 1 as a Special.
 */
export function isPartOfSeries(meta: FileMetadata): boolean {
  return Boolean(meta.seriesName && meta.seriesName.trim())
}

/** The series to write. ComicInfo always needs one, so the title stands in. */
export function seriesTitle(meta: FileMetadata): string {
  return meta.seriesName || meta.title
}

/**
 * Position within the series, or null when there is nothing to number.
 *
 * Kavita groups on Series and orders on Number; a file with neither Number nor
 * Volume becomes a Special. But numbering a one-shot is just as wrong from the
 * other direction — it makes a one-chapter series per file — so the index is
 * only written for a real series member.
 */
export function seriesNumber(meta: FileMetadata): number | null {
  if (!isPartOfSeries(meta)) return null
  if (meta.seriesIndex == null || !(meta.seriesIndex > 0)) return null
  return meta.seriesIndex
}

/**
 * Who to credit.
 *
 * Doujin circles are frequently the only attribution there is, so a group
 * stands in when no artist is named. 'Unknown' beats an empty Writer element,
 * which Kavita renders as a blank author.
 */
export function resolveWriters(meta: FileMetadata): string[] {
  if (meta.artists.length > 0) return meta.artists
  if (meta.groups.length > 0) return meta.groups
  return ['Unknown']
}

/** The circle if there is one, otherwise whatever publisher was supplied. */
export function resolvePublisher(meta: FileMetadata): string | null {
  return meta.groups[0] ?? meta.publisher ?? null
}

/**
 * The human-readable language, e.g. 'English'.
 *
 * A language the caller already settled on wins; otherwise the gallery's
 * `language`-type tags are resolved by priority rather than by order, because
 * the first of them is usually `translated` — which is not a language.
 */
export function resolveLanguageValue(meta: FileMetadata): string | null {
  return meta.language ?? resolveLanguageName(meta.languageTags)
}

/** A parody becomes a collection only when the setting asks for it. */
export function resolveSeriesGroup(meta: FileMetadata): string | null {
  if (!meta.parodyAsCollection) return null
  return meta.parodies[0] ?? null
}

// ─── Shared context ──────────────────────────────────────────────────────────

const esc = (value: string | null | undefined): string => (value ? escapeXml(value) : '')
const escAll = (values: string[]): string[] => values.map((v) => escapeXml(v))

/**
 * Everything both formats can offer, escaped and ready to substitute.
 *
 * Fields the shipped templates never mention are here on purpose — they are
 * what makes a template edit possible without touching code.
 */
function commonContext(meta: FileMetadata): TemplateContext {
  const language = resolveLanguageValue(meta)

  return {
    // Zero is absent, not a gallery. It is what an id-less row carries, and it
    // must not produce `nhentai.net/g/0` or an empty pdfx:isbn of "0".
    galleryId: meta.galleryId || '',
    title: esc(meta.title),
    titleEnglish: esc(meta.titleEnglish),
    titleJapanese: esc(meta.titleJapanese),
    titlePretty: esc(meta.titlePretty),

    seriesName: esc(meta.seriesName),
    partOfSeries: isPartOfSeries(meta),

    artists: escAll(meta.artists),
    groups: escAll(meta.groups),
    writers: escAll(resolveWriters(meta)),
    characters: escAll(meta.characters),
    parodies: escAll(meta.parodies),
    genres: escAll(meta.genres),
    tags: escAll(meta.tags),
    allTags: escAll(meta.allTags),

    publisher: esc(resolvePublisher(meta)),
    description: esc(meta.description),

    /** The resolved name, e.g. 'English'. `languageIso` is the code Kavita reads. */
    language: esc(language),
    languageIso: esc(toIsoLanguage(language)),

    pageCount: meta.pageCount,
    galleryPageCount: meta.galleryPageCount ?? '',
    format: esc(meta.format),
    ageRating: esc(meta.ageRating),
    manga: esc(meta.mangaDirection),
    producer: PDF_PRODUCER
  }
}

// ─── ComicInfo (CBZ) ─────────────────────────────────────────────────────────

/** The context the ComicInfo template is rendered against. */
export function comicInfoContext(meta: FileMetadata): TemplateContext {
  const date = meta.releaseDate

  return {
    ...commonContext(meta),
    series: esc(seriesTitle(meta)),
    number: seriesNumber(meta) ?? '',
    seriesIndex: meta.seriesIndex ?? '',
    summary: esc(meta.description),
    seriesGroup: esc(resolveSeriesGroup(meta)),
    // Written as three elements, so all three are absent together.
    year: date ? date.getFullYear() : '',
    month: date ? String(date.getMonth() + 1).padStart(2, '0') : '',
    day: date ? String(date.getDate()).padStart(2, '0') : '',
    dateIso: date ? date.toISOString() : ''
  }
}

/** Render ComicInfo.xml for a file. */
export function buildComicInfoXml(meta: FileMetadata): string {
  return renderTemplate(loadTemplate(COMICINFO_TEMPLATE), comicInfoContext(meta))
}

// ─── XMP (PDF) ───────────────────────────────────────────────────────────────

/**
 * Calibre's author_sort: the first creator with its words reversed.
 *
 * Not a good surname heuristic, but it is the shape calibre writes and the one
 * this library's existing files already carry.
 */
function authorSort(writers: string[]): string {
  return writers[0]?.split(' ').reverse().join(' ') || 'unknown'
}

/** The context the PDF XMP template is rendered against. */
export function xmpContext(meta: FileMetadata): TemplateContext {
  const writers = resolveWriters(meta)
  // An undated file still needs a dc:date, so it gets the moment it was written.
  const date = (meta.releaseDate ?? new Date()).toISOString()

  return {
    ...commonContext(meta),
    bom: XMP_BOM,
    creators: escAll(writers),
    // dc:subject carries every tag, not just the `tag`-type ones.
    tags: escAll(meta.allTags),
    date: esc(date),
    // xmp:MetadataDate is when the file was written, not when the work came out.
    metadataDate: new Date().toISOString().replace(/\.\d{3}Z$/, '.000000+00:00'),
    seriesIndex: meta.seriesIndex != null ? meta.seriesIndex.toFixed(2) : '',
    authorSort: esc(authorSort(writers))
  }
}

/** Render the XMP packet for a PDF. */
export function buildXmpXml(meta: FileMetadata): string {
  return renderTemplate(loadTemplate(PDF_XMP_TEMPLATE), xmpContext(meta))
}

// ─── PDF Info dictionary ─────────────────────────────────────────────────────

/**
 * The `/Keywords` token list.
 *
 * Kavita reads XMP, but this app's own library scanner parses these tokens as a
 * fallback and prefers them for language and series — so everything needed for
 * a rescan-from-disk round trip is written here too. Not templated: these are
 * plain-text tokens in a PDF Info dictionary, not markup.
 */
export function buildKeywordTokens(meta: FileMetadata): string[] {
  const tokens = [...meta.allTags]
  const language = resolveLanguageValue(meta)
  const publisher = resolvePublisher(meta)

  if (meta.galleryId != null) tokens.push(`nhentai:${meta.galleryId}`)
  if (meta.seriesName) tokens.push(`calibre_series:${meta.seriesName}`)
  if (meta.seriesIndex != null) tokens.push(`series_index:${meta.seriesIndex}`)
  // Human-readable on purpose: the scanner reads this back into the UI, while
  // dc:language carries the ISO code Kavita expects.
  if (language) tokens.push(`language:${language}`)
  if (publisher) tokens.push(`publisher:${publisher}`)

  return tokens
}

/** The Info-dictionary fields written alongside the XMP packet. Unescaped. */
export function buildDocInfo(meta: FileMetadata): {
  title: string
  author: string
  keywords: string
  producer: string
} {
  return {
    title: meta.title,
    author: resolveWriters(meta).join(', '),
    keywords: buildKeywordTokens(meta).join(', '),
    producer: PDF_PRODUCER
  }
}
