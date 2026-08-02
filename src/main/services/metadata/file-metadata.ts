/**
 * The one shape every metadata write starts from.
 *
 * Before this existed there were seven places that each built their own
 * metadata object — one per download worker, one per conversion worker, one in
 * the rewrite path, two in the IPC layer — and each made its own decisions
 * about series numbering, artist fallbacks and language resolution. They drifted,
 * predictably: the rule deciding whether a file gets a `<Number>` had to be
 * fixed in three of them separately, and the third was missed for a week.
 *
 * So the pipeline is now:
 *
 *   input shape  ──adapter──▶  FileMetadata  ──mapper──▶  context  ──template──▶  bytes
 *
 * Adapters do no thinking. They pull facts out of whatever shape the caller
 * happens to have — an nhentai API gallery, a library row, an edit payload —
 * and stop. Every decision that could be made differently lives in the mapper
 * (`mappers.ts`), which there is exactly one of per format.
 *
 * FileMetadata deliberately carries more than the shipped templates use. A
 * field that nothing references costs one property; a field that is missing
 * when someone wants to add `{{titleJapanese}}` to a template costs a code
 * change in every adapter.
 */

/** Reading direction, as ComicInfo spells it. */
export type MangaDirection = 'Yes' | 'YesAndRightToLeft' | 'No'

/** A tag as nhentai returns it. */
export interface TagLike {
  id?: number
  type: string
  name: string
}

/**
 * A gallery as the nhentai API describes it, as passed to the download workers.
 */
export interface GalleryMetadata {
  id: number
  title: {
    english: string
    japanese: string | null
    pretty: string
  }
  tags: TagLike[]
  uploadDate: number
  numPages: number
  seriesName?: string
  seriesIndex?: number
  language?: string
  publisher?: string
  description?: string
  /** nhentai's media id, which its image URLs are built from. */
  mediaId?: number | null
  favorites?: number | null
  coverUrl?: string | null
  thumbnailUrl?: string | null
  /** Always empty in practice — nhentai does not populate it. */
  scanlator?: string | null
}

/**
 * A library row's metadata, as the conversion worker and the IPC layer hold it.
 *
 * `rawTagsJson` is present only when the row came from the API. Rows the
 * library scanner created carry a stub whose only tags are untyped, which is
 * why `isRealGalleryRow` exists.
 */
export interface LibraryItemMetadata {
  galleryId?: number | null
  customTitle?: string | null
  primaryArtist?: string | null
  seriesName?: string | null
  seriesIndex?: number | null
  customTags?: string | null
  customLanguage?: string | null
  language?: string | null
  publisher?: string | null
  description?: string | null
  uploadDate?: number | null
  rawTagsJson?: string | null
  format?: string | null
  pageCount?: number | null
  id?: number
  /** Folded in from the cached gallery row, where one exists. */
  titleEnglish?: string | null
  titleJapanese?: string | null
  mediaId?: number | null
  favoritesCount?: number | null
  coverUrl?: string | null
  thumbnailUrl?: string | null
  galleryPageCount?: number | null
}

/**
 * A hand-assembled edit, as the IPC handlers and the sync worker build one.
 *
 * This is the flat shape `applyMetadata` takes, kept because a caller editing
 * one field should not have to reconstruct a whole gallery.
 */
export interface MetadataPayload {
  title: string
  creators: string[]
  tags: string[]
  nhentaiId?: number | null
  seriesName?: string | null
  seriesIndex?: number | null
  description?: string | null
  publisher?: string | null
  language?: string | null
  date?: string | null
}

// ─── The canonical shape ─────────────────────────────────────────────────────

export interface FileMetadata {
  /** nhentai gallery number, or null for anything added by hand. */
  galleryId: number | null

  /** The name to write. Never empty — adapters substitute a fallback. */
  title: string
  titleEnglish: string | null
  titleJapanese: string | null
  titlePretty: string | null

  seriesName: string | null
  /** Position within the series. Only meaningful when `seriesName` is set. */
  seriesIndex: number | null

  artists: string[]
  /** Circles. Doubles as the publisher when there is one. */
  groups: string[]
  characters: string[]
  parodies: string[]
  /** nhentai `category`-type tags — `doujinshi`, `manga`. */
  categories: string[]
  /** nhentai `tag`-type tags only. */
  tags: string[]
  /** Every tag name whatever its type — what PDF XMP writes as dc:subject. */
  allTags: string[]
  /** Raw `language`-type tag names, still to be resolved to one language. */
  languageTags: string[]

  /**
   * A language the caller has already settled on, which wins over
   * `languageTags`. Set when the value came from a column rather than tags.
   */
  language: string | null

  publisher: string | null
  description: string | null

  /** Validated; never an Invalid Date. */
  releaseDate: Date | null

  /** Pages in the file itself. Writers that know better override it. */
  pageCount: number
  /** Pages the gallery claims, which can differ from the file. */
  galleryPageCount: number | null

  format: string | null
  mangaDirection: MangaDirection
  ageRating: string

  /*
   * Carried but unused by the shipped templates. Kept so a template can be
   * changed without a code change — which is the whole reason the templates
   * are text files.
   */
  mediaId: number | null
  favorites: number | null
  coverUrl: string | null
  thumbnailUrl: string | null
  scanlator: string | null
}

/**
 * The values every adapter starts from.
 *
 * `manga: 'YesAndRightToLeft'` matches what the ComicInfo builders defaulted to
 * before this refactor; callers that read the `cbzMangaDirection` setting pass
 * their own.
 */
export const DEFAULT_FILE_METADATA: FileMetadata = {
  galleryId: null,
  title: 'Untitled',
  titleEnglish: null,
  titleJapanese: null,
  titlePretty: null,
  seriesName: null,
  seriesIndex: null,
  artists: [],
  groups: [],
  characters: [],
  parodies: [],
  categories: [],
  tags: [],
  allTags: [],
  languageTags: [],
  language: null,
  publisher: null,
  description: null,
  releaseDate: null,
  pageCount: 0,
  galleryPageCount: null,
  format: null,
  mangaDirection: 'YesAndRightToLeft',
  ageRating: 'Adults Only 18+',
  mediaId: null,
  favorites: null,
  coverUrl: null,
  thumbnailUrl: null,
  scanlator: null
}

/** Build a FileMetadata from a partial one, filling the rest with defaults. */
export function makeFileMetadata(partial: Partial<FileMetadata>): FileMetadata {
  return { ...DEFAULT_FILE_METADATA, ...partial }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const namesOfType = (tags: TagLike[], type: string): string[] =>
  tags.filter((t) => t.type === type).map((t) => t.name)

/**
 * A Date, or null for anything that is not one — including `new Date('x')`.
 *
 * A unix timestamp of 0 counts as absent, not as 1 January 1970. It is what an
 * unknown upload date looks like, and writing 1970 into Year/Month/Day would
 * hand Kavita a release date for every gallery we have no date for.
 */
function toDate(value: number | string | null | undefined, unit: 'seconds' | 'iso'): Date | null {
  if (!value) return null
  const date = unit === 'seconds' ? new Date(Number(value) * 1000) : new Date(String(value))
  return Number.isFinite(date.getTime()) ? date : null
}

const splitList = (csv: string | null | undefined): string[] =>
  csv
    ? csv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : []

/**
 * Whether a cached gallery row holds real API data.
 *
 * Rows the library scanner invents carry a stub: a flat list whose tags are all
 * untyped. Their `upload_date` is our own tooling's timestamp, which is why
 * their release date must never be written — 4,321 rows would tell Kavita the
 * work came out this month.
 */
export function isRealGalleryRow(rawTagsJson: string | null | undefined): boolean {
  if (!rawTagsJson) return false
  try {
    const tags: TagLike[] = JSON.parse(rawTagsJson)
    if (!Array.isArray(tags) || tags.length === 0) return false
    const types = new Set(tags.map((t) => t.type))
    return !(types.size === 1 && types.has('tag'))
  } catch {
    return false
  }
}

// ─── Adapters ────────────────────────────────────────────────────────────────

/**
 * From an nhentai gallery, as the download workers receive it.
 *
 * The gallery's own `language` field is not consulted: the download path has
 * always resolved language from the `language`-type tags, because the first of
 * them is usually `translated`, which is not a language.
 */
export function fileMetadataFromGallery(
  meta: GalleryMetadata,
  over: Partial<FileMetadata> = {}
): FileMetadata {
  return makeFileMetadata({
    galleryId: meta.id,
    title: meta.title.pretty,
    titleEnglish: meta.title.english || null,
    titleJapanese: meta.title.japanese || null,
    titlePretty: meta.title.pretty || null,
    seriesName: meta.seriesName || null,
    seriesIndex: meta.seriesIndex ?? null,
    artists: namesOfType(meta.tags, 'artist'),
    groups: namesOfType(meta.tags, 'group'),
    characters: namesOfType(meta.tags, 'character'),
    parodies: namesOfType(meta.tags, 'parody'),
    categories: namesOfType(meta.tags, 'category'),
    tags: namesOfType(meta.tags, 'tag'),
    allTags: meta.tags.map((t) => t.name),
    languageTags: namesOfType(meta.tags, 'language'),
    publisher: meta.publisher || null,
    description: meta.description || null,
    releaseDate: toDate(meta.uploadDate, 'seconds'),
    galleryPageCount: meta.numPages ?? null,
    mediaId: meta.mediaId ?? null,
    favorites: meta.favorites ?? null,
    coverUrl: meta.coverUrl ?? null,
    thumbnailUrl: meta.thumbnailUrl ?? null,
    scanlator: meta.scanlator || null,
    ...over
  })
}

/**
 * From a library row.
 *
 * Splits on whether the cached gallery data is real. A stub has no typed tags,
 * so its flat `customTags` are all that can be offered, its language comes from
 * its own column rather than from tags, and it gets no release date at all.
 */
export function fileMetadataFromLibraryItem(
  row: LibraryItemMetadata,
  over: Partial<FileMetadata> = {}
): FileMetadata {
  const title = row.customTitle || `Gallery #${row.galleryId || row.id || 0}`
  const real = isRealGalleryRow(row.rawTagsJson)
  const parsed: TagLike[] = real ? JSON.parse(row.rawTagsJson as string) : []

  return makeFileMetadata({
    galleryId: row.galleryId ?? null,
    title,
    seriesName: row.seriesName || null,
    seriesIndex: row.seriesIndex ?? null,
    // The row's own artist column, not the artist tags: it is what the user
    // sees in the library and what they may have corrected by hand.
    artists: row.primaryArtist ? [row.primaryArtist] : [],
    groups: namesOfType(parsed, 'group'),
    characters: namesOfType(parsed, 'character'),
    parodies: namesOfType(parsed, 'parody'),
    categories: namesOfType(parsed, 'category'),
    tags: real ? namesOfType(parsed, 'tag') : splitList(row.customTags),
    allTags: real ? parsed.map((t) => t.name) : splitList(row.customTags),
    languageTags: real ? [...namesOfType(parsed, 'language'), row.customLanguage || ''] : [],
    language: real ? null : row.customLanguage || null,
    publisher: row.publisher || null,
    description: row.description || null,
    releaseDate: real ? toDate(row.uploadDate, 'seconds') : null,
    format: row.format || null,
    pageCount: row.pageCount ?? 0,
    // From the cached gallery, when the caller folded one in. Without these the
    // Japanese title sat in the database and never reached a template.
    titleEnglish: row.titleEnglish || null,
    titleJapanese: row.titleJapanese || null,
    galleryPageCount: row.galleryPageCount ?? null,
    mediaId: row.mediaId ?? null,
    favorites: row.favoritesCount ?? null,
    coverUrl: row.coverUrl || null,
    thumbnailUrl: row.thumbnailUrl || null,
    ...over
  })
}

/**
 * From a flat edit payload.
 *
 * The thinnest input there is: no typed tags, so no genres or characters, and
 * the language is whatever the caller decided rather than something to resolve.
 */
export function fileMetadataFromPayload(
  payload: MetadataPayload,
  over: Partial<FileMetadata> = {}
): FileMetadata {
  return makeFileMetadata({
    galleryId: payload.nhentaiId ?? null,
    title: payload.title,
    seriesName: payload.seriesName || null,
    seriesIndex: payload.seriesIndex ?? null,
    artists: payload.creators,
    tags: payload.tags,
    allTags: payload.tags,
    language: payload.language || null,
    publisher: payload.publisher || null,
    description: payload.description || null,
    releaseDate: toDate(payload.date, 'iso'),
    ...over
  })
}
