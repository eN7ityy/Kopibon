# Phase 9 — CBZ Support: Implementation Plan

**Status:** Ready for implementation
**Supersedes:** `phase9-epub-support.md` (EPUB was reconsidered in favour of CBZ — see §1.2)
**Audience:** the agent implementing this. Read §0–§2 before writing any code.

---

## 0. What you are building, and the one thing that will bite you

Add **CBZ** as a second output format alongside PDF: downloadable directly, and
convertible from existing PDF library items, with Kavita-compliant
`ComicInfo.xml` metadata.

### 0.1 Read this first: the scanner will delete every CBZ you create

The library scanner discovers **only `.pdf`** files
([`library-scanner.worker.ts`](../src/main/services/library-scanner.worker.ts),
the `walkPdfs()` extension check), and its phase 5 removal pass deletes every
`library_item` whose `file_path` was not discovered.

A CBZ's path can never be discovered, so **every CBZ row is deleted on the next
rescan.** The removal guards added in the previous phase will *not* save you:
they trip on unreadable directories or a >20% collapse in discovered file count.
Neither fires here — discovery looks perfectly healthy, the CBZs are simply
invisible.

**Therefore: §2 (format awareness) must be complete and tested before a single
CBZ file is written to the library.** Do not reorder this. If you build the
generator first and test it by downloading into the real library, a later scan
will silently erase the results.

### 0.2 This is not "another output format"

CBZ is a second *file type*, and roughly a dozen existing code paths assume
every library item is a PDF. Most of the work in this plan is teaching the app
that assumption is no longer true (§2), not generating the archives (§4).

---

## 1. Design decisions, with reasoning

Do not silently revise these. If you disagree, raise it — several encode
non-obvious constraints discovered the hard way.

### 1.1 Container: ZIP of images + `ComicInfo.xml` at the archive root

That is the entire format. No manifest, no per-page XHTML, no table of
contents, no `mimetype` ordering rules.

### 1.2 Why CBZ rather than EPUB

The previous plan proposed EPUB. CBZ was chosen instead:

| | EPUB | CBZ |
|---|---|---|
| Structure | ZIP + OPF + NCX/nav + one XHTML per page + strict `mimetype` rules | ZIP of images + one XML file |
| Metadata | OPF, where EPUB 2 and EPUB 3 idioms are mutually invalid | `ComicInfo.xml`, a flat documented schema |
| Kavita support | Supported | Best-supported comic format |
| Cover art | Requires explicit manifest wiring | First image by filename order |
| Reading direction | `page-progression-direction` | `<Manga>YesAndRightToLeft</Manga>` |
| Validity risk | High | Low |
| External binaries | none | none |

EPUB's real advantage is *reflowable text*. This content is images, so that
advantage does not apply while all of EPUB's structural complexity does.

Both formats equally achieve the genuine strategic win: **CBZ generation needs
no Python and no pikepdf**, so anything produced this way sidesteps the app's
most fragile dependency entirely (see §9.3).

### 1.3 Identity: one `library_item` row per file. Conversion replaces.

`library_item.gallery_id` is **`UNIQUE`**
([`connection.ts`](../src/main/db/connection.ts), the `library_item` DDL). You
therefore *cannot* insert a second row for the same gallery — the previous plan's
"keep original ⇒ insert a new row" step throws a constraint violation.

So:

- Conversion **updates** the existing row: `file_path` → the new `.cbz`,
  `format` → `'cbz'`. One row, one file, no ambiguity.
- **"Keep original"** moves the PDF to `{libraryRoot}/_originals/{artist}/…`
  and adds `_originals` to the scanner's directory exclusion list, alongside the
  existing `_Unsorted` and `_migration_staging` entries. The file survives, the
  scanner ignores it, no second row exists, and the operation is reversible by
  moving it back.
- Do **not** support the same gallery existing as both PDF and CBZ in the
  library. It buys little and breaks `findByGalleryId()` for every caller.

### 1.4 Images: stored, not deflated; zero-padded names

- Filenames `0001.jpg`, `0002.jpg`, … Readers order pages **lexicographically
  by filename**, so padding is mandatory. The download scratch directory already
  names files this way (`String(pageNumber).padStart(4, '0')`).
- Add entries with **compression level 0 (store)**. JPEGs do not deflate
  meaningfully; deflating a 300-page archive burns CPU for ~0% gain. This also
  makes later metadata rewrites (§7) cheap.
- Write `ComicInfo.xml` as the **first** entry. Not required by the format, but
  it lets a streaming reader find metadata without scanning the whole archive.

### 1.5 Scratch space goes in `userData`, never `os.tmpdir()`

On the target machine `/tmp` is a **16 GB RAM-backed tmpfs**. Extracting
hundreds of page images per item, times the runner count, would consume RAM.
Use `app.getPath('userData')`, matching what the download pipeline already does
(`imageDownloadRoot()` in
[`download-manager.ts`](../src/main/services/download-manager.ts)).

### 1.6 Do not trust "file exists and size > 0" as verification

This codebase has repeatedly shipped metadata that was written, was the right
size, and was completely unreadable by Kavita:

- `escXml()` replaced every character with itself, so any `&` in a title
  produced invalid XML for months. pikepdf wrote the bytes without validating.
- `dc:language` was written as element text when Kavita only reads an
  `rdf:Bag`. Structurally invisible, and undetectable without reading it back
  with a real reader.

**Every verification step in this plan means: open the artefact, parse it with a
real parser, and assert the fields.** See §10.

### 1.7 What a dry run has already proven

The container and metadata mapping in this plan are **not theoretical** — they
were prototyped and run against four real library files. Full detail in
**Appendix C**; the headline results:

- All four produced structurally valid CBZs; **52/52 assertions passed**.
- Extraction is **lossless** (byte-identical JPEG, pixel-identical PNG).
- Every file got **smaller**: 36→29, 60→45, 193→155, and 291→78 MB — with no
  re-encoding at all. The "CBZ is smaller" claim needs no quality tradeoff.
- Escaping works: a title containing `&` and `'` round-tripped correctly.
- Two adjacent volumes of one series produced matching `Series` with distinct
  `Volume` values.

It also found five things this plan originally got wrong, all now corrected
inline: `-j` vs `-all` (§7.2), metadata precedence (§7.3), release dates (§4.2),
stray volumes (§4.2), and non-language language values (§4.2).

**A working prototype exists.** If anything here is ambiguous, port its logic
rather than re-deriving it — see §C.6.

---

## 2. Part 0 — Make the app format-aware (do this first)

Nothing here writes a CBZ. All of it is prerequisite. Every item is a place that
currently assumes PDF.

### 2.1 Scanner discovery and metadata extraction

**File:** [`library-scanner.worker.ts`](../src/main/services/library-scanner.worker.ts)

1. `walkPdfs()` → rename to `walkLibraryFiles()`; match `.pdf` **and** `.cbz`.
   Keep the `WalkResult { files, failedDirs }` shape — the removal guards depend
   on `failedDirs`.
2. Add `_originals` to the excluded directory names (§1.3).
3. Add `extractCbzMetadata(filePath)` returning the **same** `PdfMetadata`
   shape that `extractPdfMetadata()` returns, so `processFile()` can dispatch on
   extension and everything downstream is unchanged.
4. Set `format` on insert: `'pdf'` or `'cbz'` from the extension. The column
   already exists and defaults to `'pdf'`; the scanner currently hardcodes
   `format: 'pdf'`.
5. Thumbnails: `generateThumbnail()` shells `pdftoppm`. For CBZ, extract the
   **first image entry** and resize with sharp instead. This removes the poppler
   dependency for CBZ items entirely.
6. Gallery-ID recovery for CBZ, in precedence order: `ComicInfo.xml` `<Web>`
   (`nhentai\.net/g/(\d+)`) → `<Notes>` → the `[nhentai-{id}]` filename pattern
   (`FILENAME_ID_REGEX`, already present and unchanged).

> **Do not** add `.cbr` to discovery. We never produce it, and reading RAR needs
> another external binary. Undiscovered files with no DB rows are harmless.

### 2.2 Metadata writing must route by format

Three IPC handlers in
[`library.ipc.ts`](../src/main/ipc/library.ipc.ts) call `spawnMetadataWorker()`
(pikepdf) unconditionally. On a CBZ, pikepdf fails — it is not a PDF.

| Caller | Fix |
|---|---|
| `library:updateMetadata` | Dispatch on `item.format`: pikepdf for `pdf`, ComicInfo rewrite (§7) for `cbz` |
| `library:assignSeries` | Same dispatch |
| `library:addCustom` | Same dispatch, driven by the chosen output format |
| `library:syncItem` → [`sync.worker.ts`](../src/main/services/sync.worker.ts) | Worker calls `applyXmpWithPikepdf` directly; needs a format branch |
| `library:convertAllMetadata` | Iterates **every** library item and applies pikepdf. Must skip or route CBZ rows, or it reports mass failures |

Cleanest structure: a single `applyMetadata(filePath, format, metadata)`
dispatcher that both the IPC layer and the workers call, so no future caller can
forget the branch.

### 2.3 Reader

[`PdfViewer.tsx`](../src/renderer/src/components/library/PdfViewer.tsx) is the
only viewer, and [`LibraryDetail.tsx`](../src/renderer/src/components/library/LibraryDetail.tsx)
opens it unconditionally.

Add `CbzViewer.tsx` and pick by `item.format`. This is *easier* than the PDF
viewer: entries are already images, so no rasterisation.

**Build it lazily from the start** — decode the visible page ±2, not all pages.
The PDF viewer's eager full-resolution rendering of every page is a known
memory problem (multiple GB for a 200-page gallery) and is on the audit's
remaining-work list. Do not reproduce it here.

### 2.4 Acceptance for Part 0

Before moving on, prove with a **temp library and temp database** (never the
real one):

- A hand-made `.cbz` placed in the library is discovered, inserted with
  `format = 'cbz'`, and its ComicInfo fields land in the DB.
- **A rescan does not delete it.** This is the one that matters.
- A file in `_originals/` is ignored by the scanner.
- `updateMetadata` on a CBZ row rewrites ComicInfo and does not invoke pikepdf.
- `convertAllMetadata` over a mixed library reports no failures.

The previous phase's harness pattern is the model: bundle the worker with
esbuild, redirect its `db/connection` import to a stub opening a throwaway
database, then drive the real worker in a real `worker_thread`.

---

## 3. Dependencies

```
npm install archiver yauzl
npm install -D @types/archiver @types/yauzl
```

- **`archiver`** — streaming ZIP writer. Supports per-entry `store: true`.
- **`yauzl`** — streaming ZIP reader that can open a *single* entry via the
  central directory without inflating the archive. Important: the scanner reads
  `ComicInfo.xml` from thousands of files, so do not use a reader that loads the
  whole archive into memory (`adm-zip`, `fflate`).

`yazl` is a lighter alternative to `archiver` if you prefer symmetry with
`yauzl`; either is fine.

**No XML parser dependency.** `ComicInfo.xml` is flat (no nesting except the
optional `<Pages>`, which we do not read), so per-field extraction is safe
*provided* entities are decoded. This is deliberately different from the XMP
situation, where nested `rdf:Alt`/`rdf:Bag` structures broke regex parsing
twice. The tradeoff is accepted **on the condition that §10.1's escaping
round-trip tests exist.**

---

## 4. `ComicInfo.xml` — the metadata contract

Kavita requires the file to be named exactly `ComicInfo.xml` and to sit at the
**root** of the archive. Kavita supports **v2.1 (draft)** of the Anansi Project
schema.

### 4.1 Schema validation — read this before validating anything

There is a `ComicInfo.xsd` in [`oldScripts/`](../oldScripts/) from the previous
Python tooling. **It is the v1.0 schema and must not be used as the validation
target.** Verified missing: `Tags`, `GTIN`, `LocalizedSeries`. Validating
against it would pass while omitting fields Kavita reads.

Fetch the **v2.1 draft** schema from the Anansi Project and commit it as
`resources/ComicInfo-v2.1.xsd`. `xmllint` is available on the target machine:

```bash
xmllint --noout --schema resources/ComicInfo-v2.1.xsd ComicInfo.xml
```

### 4.2 Field mapping: nhentai/library → ComicInfo → Kavita

| ComicInfo element | Value to write | Notes |
|---|---|---|
| `Title` | `gallery.title.pretty` / `library_item.customTitle` | → Kavita Chapter Title |
| `Series` | `seriesName` **if set, else the title** | Always write it — see §4.3 |
| `Volume` | `seriesIndex`, **only when a real `seriesName` exists** | → Kavita Volume. Do *not* write it when `Series` fell back to the title — 98% of rows carry a `series_index` but only 71% a `series_name`, so ~1,200 items would get a meaningless "Volume 1" (verified, §C.4) |
| `Number` | **omit** | Setting both Volume and Number double-classifies the file |
| `Count` | **omit** | See §4.4 — writing it lies to Kavita about publication status |
| `Summary` | `description` | Omit when empty |
| `Writer` | artist names, comma-separated | → Kavita Writer |
| `Penciller` | same as `Writer` | Doujin artists both write and draw; populates Kavita's Penciller facet |
| `Publisher` | group tag, else omit | Reuse the existing precedence logic — see §4.5 |
| `Genre` | nhentai `category` tag(s) | e.g. doujinshi, manga. Usually empty in practice (§C.3) — that is fine, see the Genre/Tags note below |
| `Tags` | nhentai `tag` type names | → Kavita Tags. v2.0+ field |
| `Characters` | nhentai `character` tags | Schema-correct; Kavita's table does not list it, so treat as harmless enrichment |
| `Web` | `https://nhentai.net/g/{id}` | → Kavita Web Links, and our own ID recovery path |
| `Notes` | `Tagged by Doujin Downloader — nhentai gallery {id}` | Provenance + second ID recovery path |
| `PageCount` | image count | → Kavita Length |
| `LanguageISO` | ISO 639-1 (`en`, `ja`, `zh`) | Reuse `toIsoLanguage()` from [`xmp-inject.ts`](../src/main/services/xmp-inject.ts) — **extract it to a shared module** rather than duplicating. **Emit nothing if the value is not a recognisable language.** The app's language field is free text and really does contain non-languages such as `translated` (§C.5) — a bogus ISO code is worse than an absent one |
| `Year` / `Month` / `Day` | from `gallery.upload_date` — **only when the gallery row is real API data** | → Kavita Release Date. For scanner-discovered items `upload_date` is the PDF's creation date, which our own tooling overwrote: 4,321 rows read `2026-07`. Kavita derives a series' Release Year from the *minimum* year across its files, so one wrong date corrupts the whole series. **Omit rather than guess** (§C.2) |
| `AgeRating` | `Adults Only 18+` | Exact enum string. Accurate for this content and lets users filter |
| `Manga` | `YesAndRightToLeft` (default, configurable) | Correct right-to-left reading order |
| `Format` | **never set** | See §4.6 — the listed values force Special treatment |
| `GTIN` | **do not use** | Kavita maps it to ISBN. An nhentai ID is not a GTIN; `Web` + `Notes` already carry it |
| `SeriesGroup` | *optional* — nhentai `parody` tags | Creates Kavita **collections** (e.g. all Fate/Grand Order doujin). Requires "Manage Collections" enabled in Kavita (default off). Put behind a setting, default off |

### 4.2.1 Why `Genre` and `Tags` are separate here (and were not for PDF)

Kavita's **PDF** mapping offers a single keyword destination: `dc:subject` →
**Genres**. There is no PDF → Tags mapping. Our XMP writer puts every nhentai
tag into `dc:subject`, so on PDF items Kavita files all of them under *Genres*.
That is Kavita's behaviour, not a defect in our writer, and there is no way to
improve it for PDFs — writing fewer entries would simply lose the tags.

**ComicInfo has two destinations** (`Genre` → Genres, `Tags` → Tags), so CBZ can
put the broad classification in `Genre` and the descriptive tags in `Tags`, which
is what Kavita's filters expect. Confirmed working on real files.

**Consequence for migration:** converting a PDF to CBZ **relocates its tags from
Genres to Tags in Kavita.** Any Genre-based filter or smart collection the user
built against PDF items will change. Mention this in the conversion UI.

In practice `Genre` is usually empty, because nhentai `category` tags only
survive on the 41 real-API rows (§C.3). Everything landing in `Tags` is the
desired outcome.

### 4.3 Always write `Series`

If `Series` is absent, Kavita falls back to parsing the filename. Our filenames
are `{title} [nhentai-{id}].cbz`; Kavita's parser strips `(…)` but not `[…]`,
so the ID would leak into series names. Writing `Series` explicitly — the series
name when assigned, otherwise the title — guarantees clean grouping and removes
all dependence on filename parsing.

### 4.4 Why `Count` is omitted

Per the Kavita wiki: any non-zero `Count` in a series makes Kavita assume the
series has **Ended**, and if `Count` matches the volume/chapter count it assumes
**Completed**. We do not know how many entries a doujin series will eventually
have, and writing the number we happen to own would falsely mark it complete.
Omitting leaves it *Ongoing*, which is truthful.

### 4.5 Artist / group / publisher precedence — reuse, do not reinvent

Existing rule, implemented identically in
[`download-pdf.worker.ts`](../src/main/services/download-pdf.worker.ts) and
[`sync.worker.ts`](../src/main/services/sync.worker.ts):

- artist present → artists are the creators; group (if any) is the publisher
- no artist, group present → **group is both creator and publisher**
- neither → creator `Unknown`, no publisher

Extract this into a shared helper while you are here; it is currently duplicated.

### 4.6 Why `Format` is never set

Kavita forces an issue into being a **Special** if `Format` holds any of a fixed
list (`Anthology`, `One Shot`, `TPB`, `Omnibus`, …). nhentai categories include
values that would collide. Leave it empty unless a user explicitly marks an item
as a special later.

### 4.7 Escaping

Use one shared `escapeXml()` / `unescapeXml()` pair — ideally the same module the
XMP writer uses. `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`,
`'` → `&apos;`, and strip characters illegal in XML 1.0 even when escaped
(`\x00-\x08`, `\x0B`, `\x0C`, `\x0E-\x1F`, `\x7F`).

Reading back must **decode** entities, including numeric (`&#38;`, `&#x26;`).
A title containing `&` round-tripping to `&amp;` in the database is the exact bug
that shipped in the XMP path.

---

## 5. `comicinfo.ts` — build and parse

**New file:** `src/main/services/comicinfo.ts`

```typescript
export interface ComicInfoMetadata {
  title: string
  series: string                 // never empty — see §4.3
  volume?: number | null
  summary?: string | null
  writers: string[]              // → Writer + Penciller
  publisher?: string | null
  genres: string[]               // nhentai category tags
  tags: string[]                 // nhentai tag-type tags
  characters: string[]
  webUrl?: string | null
  notes?: string | null
  pageCount: number
  languageIso?: string | null    // en / ja / zh
  releaseDate?: Date | null      // → Year / Month / Day
  ageRating: string              // 'Adults Only 18+'
  manga: 'Yes' | 'YesAndRightToLeft' | 'No'
  seriesGroup?: string | null    // optional parody → collections
}

export function buildComicInfoXml(meta: ComicInfoMetadata): string
export function parseComicInfoXml(xml: string): Partial<ComicInfoMetadata>
```

Keep both **pure and synchronous** — no file or ZIP access. That makes them
trivially unit-testable, which §10.1 requires.

---

## 6. `cbz-generator.ts` — build the archive

**New file:** `src/main/services/cbz-generator.ts`

```typescript
export interface CbzOptions {
  /** JPEG quality 1-95, or null to embed source images untouched. */
  quality: number | null
  /** Longest-edge cap in px, or null for no resizing. */
  maxDimension: number | null
}

export async function generateCbz(
  imagePaths: string[],           // already in page order
  outputPath: string,
  metadata: ComicInfoMetadata,
  options: CbzOptions,
  onProgress?: (current: number, total: number) => void
): Promise<string>
```

Steps:

1. Write to `outputPath + '.part'`, rename on success. An interrupted run must
   never leave a half-written `.cbz` that looks complete — the scanner would
   ingest it.
2. Append `ComicInfo.xml` first (`store: true`).
3. For each image, in order: optionally transform with sharp
   (`quality: null` ⇒ embed the source bytes unchanged), append as
   `NNNN.jpg` with `store: true`, report progress.
4. Finalise, `fsync`, rename `.part` → `.cbz`.
5. `PageCount` must equal the number of image entries actually written. Build
   the XML *after* counting, or assert afterwards.

**`quality: null` is the important mode for conversion** — see §7.2.

---

## 7. Download and conversion pipelines

### 7.1 Download (`outputFormat: 'cbz'`)

**New file:** `src/main/services/download-cbz.worker.ts` — mirror
[`download-pdf.worker.ts`](../src/main/services/download-pdf.worker.ts).

- [`download-manager.ts`](../src/main/services/download-manager.ts) already
  reads `outputFormat` from the queue row; branch on it after images are
  downloaded.
- Output path: `{safeTitle} [nhentai-{id}].cbz`, same sanitiser as PDF.
- Thumbnail: reuse the first downloaded image, exactly as the PDF worker does.
- **No pikepdf step.** ComicInfo is inside the archive.
- The scratch directory purge in the `finally` block still applies.
- Dedupe: `findActiveByGalleryId()` blocks a second active queue row for the
  same gallery regardless of format. Decide deliberately whether requesting a
  different format should bypass it — the default (blocked, returns
  `duplicate: true`) is defensible.

### 7.2 Conversion (PDF → CBZ)

**Extraction — use `pdfimages -all`.** (An earlier draft said `-j`; that is wrong,
see below.)

`pdfimages -all` writes each image in its native encoding: JPEG/JP2/JBIG2/CCITT
streams are copied **byte-for-byte**, and anything else becomes **PNG**. Both
paths are lossless, and it is far faster than re-rendering.

**`-j` is not sufficient.** It only handles JPEG streams and emits huge PPM files
for everything else. This is not a rare edge case: of four real library files
tested, **two contained non-JPEG image streams and one was 100% non-JPEG**
(Flate-encoded raw RGB). See §C.1.

Because entries may be `.jpg` or `.png`, name them `NNNN` plus the source
extension — readers sort by filename and do not care about the extension. `pdftoppm` *re-rasterises*, which on our default
`Dynamic` page size (1800 pt wide) renders roughly 3750 px at 150 DPI and then
needs downscaling — an upscale followed by a downscale, and a third generation
of loss after the source and the existing quality-80 recompression.

Combined with `quality: null` (§6), conversion becomes **lossless**: the exact
JPEGs that went into the PDF come out into the CBZ.

**Guard: `pdfimages` emits one file per embedded image, not per page.** A page
built from two stacked images yields two files. So:

1. Get the expected page count from **`pdfinfo`**. Do *not* use the DB's
   `gallery.page_count`: it is `0` for scanner-discovered rows (verified).
2. Extract with `pdfimages -all` (see above — not `-j`).
3. If the extracted count ≠ expected count, **discard and fall back** to
   `pdftoppm -jpeg -r 150` (one file per page, guaranteed), accepting the
   quality loss for that item and logging it so the user knows that item is no
   longer a lossless copy.
4. `-all` yields `.jpg` for JPEG streams and `.png` for everything else. Both are
   valid CBZ entries — keep the native extension, do **not** re-encode PNG to
   JPEG, or you throw away the losslessness for no benefit.

In the four files sampled during the dry run, every one had exactly one embedded
image per page, so the fallback never triggered — but it must exist, because
nothing in the PDF format guarantees it.

**Flow per item:**

```
1. Verify source PDF exists and format = 'pdf'
2. Extract images to userData scratch  (§1.5)
3. Verify image count == expected page count, else fall back  (step 3 above)
4. Build ComicInfo from the best available metadata  (§7.3)
5. generateCbz(..., { quality: null, maxDimension: null })
6. VERIFY the output  (§10.3) — parse ComicInfo, count entries
7. Only if verified:
     keepOriginal ? move PDF → {libraryRoot}/_originals/{artist}/
                  : delete PDF
     update library_item: file_path, format='cbz', file_size, file_mtime
8. Purge scratch (always, including on failure)
9. On any failure: leave the PDF and the DB row untouched, record the error
```

**Resumability.** Converting a 4,600-item library is a multi-hour, disk-heavy
operation. Add a `conversion_queue` table modelled on `scan_queue`
(`file_path` UNIQUE, `status`, `error_message`, timestamps) so it survives a
restart, and drive it with the runner-pool pattern already in
`library:convertAllMetadata` (N workers, main process hands out items). Reuse
the existing "Runners" setting rather than inventing another.

Add a **dry-run mode** that reports what would change without writing. Given the
size of the library, this will be used.

### 7.3 Metadata source for conversion, in precedence order

**Verified reality of this database (§C.2): only 41 of 4,398 `gallery` rows hold
real API data. The other 4,357 are scanner stubs.** `upsertGalleryStub()` writes
every tag as `type: 'tag'`, so the tag *types* are gone. An earlier draft of this
plan put `gallery.rawTagsJson` first; that is correct for 1% of the library and
useless for the rest.

First, detect whether a gallery row is real:

```ts
// A scanner stub has media_id === id and no tag type other than 'tag'
function isRealGalleryRow(row): boolean {
  if (row.mediaId !== row.id) return true
  const types = new Set(JSON.parse(row.rawTagsJson ?? '[]').map(t => t.type))
  return types.size > 0 && !(types.size === 1 && types.has('tag'))
}
```

Then, per field:

| Field | Source |
|---|---|
| Title, Series, Volume | `library_item` (`customTitle`, `seriesName`, `seriesIndex`) |
| Writers | `library_item_artist` — populated for 4,620 of 4,627 rows |
| Tags | typed `tag` entries when the row is real, otherwise the flat `customTags` string (73% populated) |
| Genre / Characters / Parody | **real rows only.** Not recoverable for stubs |
| Publisher | typed `group` tag when real, else `library_item.publisher` (only 1% populated) |
| Language | typed `language` tag when real, else `customLanguage` (75% populated), and only if it maps to an ISO code (§4.2) |
| Summary | `library_item.description` — currently 0% populated |
| Year/Month/Day | **real rows only** — omit entirely otherwise (§4.2) |

Do **not** consult the PDF's own XMP as a fallback for language/publisher/date:
checked on a real stub item, `dc:language` is absent, `dc:publisher` is an empty
`rdf:Bag`, and `dc:date` is the timestamp of our own metadata pass. It adds
nothing the DB columns do not already have.

**Offer an optional "sync from nhentai first" step in the conversion UI.** Sync is
now authenticated, so it can fetch genuine typed tags *and* the true publication
date — the only route to Genre, Characters, Parody, Publisher and a correct
Release Date for the bulk of the library. Respect the documented per-endpoint
limits (gallery detail is 45/min authenticated), which makes it a long background
job over thousands of items, so keep it opt-in per batch rather than automatic.

### 7.4 Editing metadata on an existing CBZ

You cannot replace one entry inside a ZIP in place. Rewrite:

1. Stream every entry except `ComicInfo.xml` from the original into
   `path + '.part'` (append with `store: true`; since images were stored, this
   is a copy with no re-compression).
2. Append the new `ComicInfo.xml`.
3. Atomic rename over the original.

Same temp-then-rename discipline the pikepdf path uses. Cost is O(file size),
comparable to pikepdf rewriting a PDF.

---

## 8. UI and settings

- **Reuse the existing `outputFormat` setting.** It is already in the schema,
  already seeded to `'pdf'`, and the Settings dropdown already offers
  `EPUB (coming soon)` — change that option to `CBZ`. Do **not** add a second
  `defaultOutputFormat` key.
- New settings: `cbzMangaDirection` (`YesAndRightToLeft` default),
  `cbzParodyAsCollection` (default off, §4.2), `cbzKeepOriginal` (default on).
- `FormatSelector.tsx` (shared) — PDF/CBZ toggle for GalleryDetail and Settings.
- `GalleryDetail.tsx` — format picker beside Download; pass through to
  `addToQueue(galleryId, format)`.
- `LibraryPage.tsx` — "Convert to CBZ" in the batch actions bar;
  `LibraryDetail.tsx` — per-item action.
- `ConversionProgress.tsx` — progress, per-item ✓/✗/⟳, keep-original checkbox,
  cancel-after-current. Model it on the existing metadata-conversion modal in
  `SettingsPage.tsx`, which already has runners, a log pane and cancel.
- Show `format` in the library UI. `LibraryCard`/list view already render a
  format badge from `item.format`, so this mostly works once the column is
  populated correctly.
- **Warn plainly** when "keep original" is unchecked. With `quality: null`
  conversion is lossless, but if the `pdftoppm` fallback was used for an item it
  is *not*, and deleting the PDF makes that irreversible.

---

## 9. Consolidated traps

1. **Scanner deletes undiscovered CBZs.** §0.1. The single most dangerous item.
2. **`gallery_id` is UNIQUE** — no second row per gallery. §1.3.
3. **Five PDF-assuming code paths** — updateMetadata, assignSeries, syncItem,
   convertAllMetadata, thumbnails; plus the reader. §2.2, §2.3.
4. **The bundled `ComicInfo.xsd` is v1.0** and lacks `Tags`/`GTIN`/
   `LocalizedSeries`. Fetch v2.1 draft. §4.1.
5. **`Format` forces Specials.** Never set it. §4.6.
6. **`Count` falsely marks a series Ended/Completed.** Omit it. §4.4.
7. **Missing `Series` leaks `[nhentai-…]`** into Kavita series names via
   filename parsing. §4.3.
8. **Unpadded filenames misorder pages.** §1.4.
9. **`pdfimages` yields images, not pages** — count-verify and fall back. §7.2.
10. **`/tmp` is RAM.** §1.5.
11. **Half-written archives** — always write `.part` then rename. §6.
12. **Entity round-trip** — decode on read or `&` becomes `&amp;` in the DB. §4.7.
13. **`pdfimages -j` is not enough** — 2 of 4 sampled files had non-JPEG streams.
    Use `-all`. §7.2, §C.1.
14. **99% of `gallery` rows are stubs with no tag types**, so `rawTagsJson` is
    not a usable primary source. §7.3, §C.2.
15. **`upload_date` is our own tooling's timestamp** on stub rows — writing it
    corrupts Kavita's series Release Year. Omit. §4.2, §C.2.
16. **`series_index` without `series_name`** affects ~1,200 rows; do not emit a
    meaningless `Volume`. §4.2, §C.4.
17. **The language field is free text** and contains values like `translated`
    that are not languages. §4.2, §C.5.
18. **`gallery.page_count` is 0 for scanner rows** — get page counts from
    `pdfinfo`. §7.2.
19. **Converting relocates tags from Genres to Tags in Kavita.** Expected, but
    tell the user. §4.2.1.

---

## 10. Testing requirements

Non-negotiable. Two metadata formats have already shipped broken in this project
because a file existed and had a plausible size.

### 10.1 Unit — `comicinfo.ts`

- Build → parse round-trip preserves every field.
- A title containing `& < > " '` survives the round-trip **decoded**, and the
  output is well-formed XML.
- Control characters are stripped.
- Optional fields are omitted, not written empty.
- `Count` and `Format` never appear.
- `PageCount` matches the image count.

### 10.2 Schema

Validate generated XML with
`xmllint --noout --schema resources/ComicInfo-v2.1.xsd`. Available on the target
machine.

### 10.3 Integration — generate and read back

- `generateCbz` output: `ComicInfo.xml` is the first entry and at the root;
  images are `NNNN.jpg`, zero-padded, lexicographically ordered, stored
  uncompressed; entry count == `PageCount` + 1.
- Reopen with `yauzl`, parse ComicInfo, assert the fields.
- **Round-trip through the real scanner**: place the CBZ in a temp library, run
  the real scanner worker against a temp DB, assert the row's title, series,
  volume, language, tags and `format`.
- **Rescan does not delete it.**
- Lossless conversion, both encodings:
  - JPEG pages — CBZ entry bytes **byte-identical** to the embedded stream.
  - Non-JPEG pages — decode the PDF's image with pikepdf/sharp and the CBZ's PNG,
    and compare **pixel hashes**. They must match. (Byte comparison is wrong
    here: the PNG is a re-encode of identical pixels.)
- `pdftoppm` fallback triggers when image count ≠ page count.
- Failed conversion leaves the PDF and the DB row untouched.
- "Keep original" lands the PDF in `_originals/` and the scanner ignores it.

### 10.4 Manual, before any bulk run

Convert **one** item, then confirm in Kavita: series grouping, volume number,
writer, publisher, tags/genres, language, release date, age rating, reading
direction, cover art. Then convert ten. Only then consider the library.

---

## 11. Implementation order

**Phase A — format awareness (no CBZ written yet)**
1. `comicinfo.ts` + unit tests (§10.1) + schema validation (§10.2)
2. Scanner: discovery, `extractCbzMetadata`, `format` column, `_originals`
   exclusion, CBZ thumbnails
3. `applyMetadata()` dispatcher; route updateMetadata, assignSeries, addCustom,
   syncItem, convertAllMetadata
4. `CbzViewer.tsx` (lazy) + format-based selection in LibraryDetail
5. **Acceptance gate §2.4 — do not proceed until a rescan preserves a CBZ**

**Phase B — produce CBZs**
6. `cbz-generator.ts` + integration tests (§10.3)
7. `download-cbz.worker.ts`; route in `download-manager.ts`
8. `FormatSelector.tsx`; `GalleryDetail` picker; wire the `outputFormat` setting
9. End-to-end: download one gallery as CBZ, verify in Kavita (§10.4)

**Phase C — convert existing PDFs**
10. Extraction with count-verification and fallback (§7.2)
11. `conversion_queue` table + runner pool + dry-run
12. `library:convertToCbz` (single, batch) with verify-before-swap
13. `ConversionProgress.tsx`; Library/LibraryDetail entry points
14. Convert 1 → verify → 10 → verify → offer the library

**Phase D — metadata editing**
15. ComicInfo rewrite path (§7.4) wired into `updateMetadata`/`syncItem`

---

## 12. File manifest

| File | Type | Purpose |
|---|---|---|
| `package.json` | MODIFY | `archiver`, `yauzl` + types |
| `resources/ComicInfo-v2.1.xsd` | NEW | Validation target (fetch v2.1 draft) |
| `src/main/services/comicinfo.ts` | NEW | Build/parse ComicInfo XML (pure) |
| `src/main/services/cbz-generator.ts` | NEW | Create the archive |
| `src/main/services/cbz-metadata.ts` | NEW | Rewrite ComicInfo in an existing CBZ |
| `src/main/services/download-cbz.worker.ts` | NEW | CBZ download worker |
| `src/main/services/pdf-extract.ts` | NEW | `pdfimages`/`pdftoppm` extraction + count guard |
| `src/main/services/convert-cbz.worker.ts` | NEW | Conversion worker |
| `src/main/services/apply-metadata.ts` | NEW | Format dispatcher (pikepdf vs ComicInfo) |
| `src/main/services/library-scanner.worker.ts` | MODIFY | Discover `.cbz`, extract ComicInfo, `_originals`, CBZ thumbnails, `format` |
| `src/main/services/download-manager.ts` | MODIFY | Route by `outputFormat` |
| `src/main/services/sync.worker.ts` | MODIFY | Route by format |
| `src/main/services/xmp-inject.ts` | MODIFY | Export `toIsoLanguage`/escaping for reuse |
| `src/main/db/connection.ts` | MODIFY | `conversion_queue` table |
| `src/main/ipc/library.ipc.ts` | MODIFY | `library:convertToCbz`, format routing |
| `src/preload/index.ts` | MODIFY | Expose conversion + progress events |
| `src/renderer/src/components/shared/FormatSelector.tsx` | NEW | PDF/CBZ toggle |
| `src/renderer/src/components/library/CbzViewer.tsx` | NEW | Lazy CBZ reader |
| `src/renderer/src/components/library/ConversionProgress.tsx` | NEW | Batch progress modal |
| `src/renderer/src/components/gallery/GalleryDetail.tsx` | MODIFY | Format picker |
| `src/renderer/src/components/library/LibraryPage.tsx` | MODIFY | Batch convert |
| `src/renderer/src/components/library/LibraryDetail.tsx` | MODIFY | Per-item convert, viewer choice |
| `src/renderer/src/components/settings/SettingsPage.tsx` | MODIFY | `CBZ` option, new settings |
| `src/renderer/src/stores/settings.store.ts` | MODIFY | CBZ settings |

---

## Appendix A — Kavita: Comics and Manga Metadata

*Reproduced from the Kavita wiki for reference. Kavita supports ComicInfo
**v2.1 (draft)**; the schema is published by the Anansi Project. The file must be
named `ComicInfo.xml` and sit at the root of the archive.*

### Conversion table

| In ComicInfo | Equivalent in Kavita |
|---|---|
| `Title` | Chapter Title |
| `LocalizedSeries` | Localized Name |
| `Series` or `SeriesSort` | Name |
| `Number` | Issue/Chapter number |
| `Count` | Publication Status |
| `Volume` | Volume |
| `Summary` | Summary (series summary comes from the first issue/chapter) |
| `Publisher`, `Imprint` | Publisher, Imprint |
| `Year`, `Month`, `Day` | Release Date (Release Year for the series) |
| `Writer`, `Penciller`, `Inker`, `Colorist`, `Letterer`, `Cover Artist`, `Editor`, `Translator` | the same roles |
| `Genre` | Genres |
| `Tags` | Tags |
| `Web` | Web Links (also used for matching in CBLs) |
| `PageCount` | Length (aggregated on the series) |
| `LanguageISO` | Language |
| `Format` | Special |
| `SeriesGroup` | Collections |
| `StoryArc` / `StoryArcNumber` | Reading Lists |
| `AlternativeSeries` / `AlternativeCount` | Reading Lists |
| `AgeRating` | Age Rating |
| `GTIN` | ISBN |

### Non-standard tags

- **`LocalizedSeries`** — optional localized series name shown in Kavita. Either
  name is searchable, and files using the localized name group with those using
  the series name.
- **`SeriesSort`** — sort title for the series; Kavita prefers it over `Series`.

### `Count`

Kavita sets Publication Status from this tag, but only when the field is not
locked. Any non-zero `Count` anywhere in the series ⇒ Kavita assumes the series
has **Ended**; otherwise **Ongoing**. If `Count` matches the volume or chapter
count, Kavita assumes **Completed** (you own everything). Ideally the value is
the total number of volumes (manga) or issues (comics). Hovering the tag badge in
Series Detail shows how many items are missing.

### Release year

Like Age Rating, Release Year is a summation of the minimum year defined within
a series that is at least 4 units long (> 1000).

### `Format`

If a `Format` is specified, that issue or volume may be forced to be treated as a
**Special**. These values trigger it: Special, Reference, Director's Cut,
Box Set, Box-Set, Annual, Anthology, Epilogue, One Shot, One-Shot, Prologue,
TPB, Trade Paper Back, Omnibus, Compendium, Absolute, Graphic Novel, GN, FCBD,
Giant Size.

### Trade paperbacks and the Comic library type

The main Comic library type assumes an organisation similar to Comic Vine, the
Grand Comics Database and Metron, which list trades as separate volumes — which
becomes a separate series when using ComicInfo's `Series` appended by volume. If
you autotag or use Mylar3, Kavita detects trade paperbacks as separate series.
Two user-found approaches keep them in the main series:

- **Method 1** — tag `Series` and `Volume` as you would for individual issues,
  and put the span of collected issues in `Number` (e.g. `Number: 1-5`). Trades
  then sort into the correct reading order on the series page.
- **Method 2** — for collections holding both trades and issues, tag `Series` and
  `Volume` consistently and use a `Number` like `TPB` or `TPB1`/`TPB2`. Trades
  stay out of the issue reading order but remain accessible from the series page,
  loading after the issues.

### `SeriesGroup`

May contain comma-delimited strings that create or update Kavita collections, if
the library has **Manage Collections** enabled (default off).

### Age rating

Age rating may vary between files in a series; the series takes the **highest
(most mature)** rating among its files. Example: issues rated PG, PG and M give a
series rating of M. The order is fixed by the ComicInfo standard, least to most
mature:

Unknown, Rating Pending, Early Childhood, Everyone, G, Everyone 10+, PG,
Kids to Adults, Teen, MA15+, Mature 17+, M, R18+, Adults Only 18+, X18+

---

## Appendix B — Kavita: how the comic scanner parses filenames

*Reproduced from the Kavita wiki. Relevant here because it explains what Kavita
infers when ComicInfo is absent or incomplete — which is precisely why §4.3
insists on always writing `Series`.*

"Comics (Flexible)" is the legacy parsing option used before the comic overhaul
and the Comic Vine library type. If your files carry metadata and series are
combining when they should not, consider the Comic Vine library type instead.

Kavita parses comics like manga but with extra keyword identifiers. The same
naming conventions work:

```
┖── Series Name
    ┠── Series Name v01.cbz
    ┠── Series Name v02.cbz
    ┖── Series Name v03 c01.cbz
```

Files below parse as "Chapters", which may group into a Volume entity if a
volume is present on the file itself:

| Filename | Parsed series | Volume | Chapter |
|---|---|---|---|
| `Invincible 070.5 - Invincible Returns 1 (2010) (digital) (Minutemen-InnerDemons).cbr` | | | 70.5 |
| `Batman & Wildcat (1 of 3)` | | | 1 |
| `Amazing Man Comics chapter 25` | | | 25 |
| `Superman v1 024 (09-10 1943)` | | 1 | 24 |
| `Y - The Last Man` | | | 1 |
| `Batgirl Vol.2000 #57 (December, 2004)` | | | 57 |
| `Babe 01` | | | 1 |
| `Babe T1 01` | | 1 | 1 |

For multiple comics from different years, name them like "Fables 2004" and
"Fables 1989", or better, use the Comic Vine library type. **Anything within
`()` is stripped during parsing**, as it usually contains junk — use embedded
metadata instead.

Comics also have filename keywords that mark them as specials, including:
Specials, Annual, Extra Chapter, Book, Compendium, OneShot, Extra, FCBD, TPB,
Side Stories, Art Collection, Absolute, Preview, Omnibus, Bonus, Hors Série,
HS, THS.

---

## Appendix C — Dry-run findings (hands-on, real library data)

A Python prototype converted four files from `/mnt/bragi/Kavita/Doujins/` into
`/mnt/bragi/Kavita/DoujinsTest/`. Chosen to stress the risky paths: two adjacent
volumes of a 14-item series, a title containing `&` and `'`, a 10-artist item, a
group-without-artist item, and files with both JPEG and non-JPEG page encodings.

| Source | Pages | Encodings | PDF → CBZ | Checks |
|---|---|---|---|---|
| `Smoking Hypnosis` vol 7 (`&`, `'` in title) | 143 | all JPEG | 193.3 → 155.2 MB | 13/13 |
| `Smoking Hypnosis` vol 3 | 19 | 17 JPEG + 2 other | 60.3 → 45.2 MB | 13/13 |
| FGO collab, 10 artists | 55 | all JPEG | 36.1 → 28.9 MB | 13/13 |
| group-only, Japanese title | 37 | **all non-JPEG** | 291.0 → 77.7 MB | 13/13 |

### C.1 `pdfimages -all`, never `-j`

Half the sample contained non-JPEG image streams; one file was entirely
Flate-encoded raw RGB (`pdfimages -list` shows `enc = image`, not `jpeg`). With
`-j` those pages extract as enormous PPMs. `-all` yields JPEG as-is and PNG
otherwise.

Losslessness was verified in both directions, and the two require *different*
tests:

- JPEG pages: the CBZ entry is byte-identical to the extracted stream.
- Non-JPEG pages: decoded the PDF's embedded image with pikepdf and the CBZ's PNG
  entry, then compared pixel hashes — identical (`bd7347a552f7e436`). A byte
  comparison would have failed here despite the pixels matching.

That last file shrank 291 → 78 MB (−73%) precisely *because* the PDF stored the
pages as raw RGB and PNG compresses them.

### C.2 Only 41 of 4,398 `gallery` rows are usable for typed metadata

`upsertGalleryStub()` flattens every tag to `type: 'tag'`, so 4,357 stub rows
carry no artist/group/language/category/parody distinction. Three of the four
test files were stubs and consequently produced no Language, Publisher, Genre,
Characters or Parody; the single real-API row produced all of them
(`Lang=ja`, `Pub=warabimochi`).

Stub rows also carry a useless `upload_date`: it is the PDF's creation date, which
our own metadata tooling overwrote. **4,321 rows read `2026-07`.** Because Kavita
takes a series' Release Year from the minimum year across its files, writing that
would corrupt series-level data — hence "omit unless real" (§4.2).

Field coverage across the 4,627 `library_item` rows, measured:

| Column | Populated |
|---|---|
| `series_index` | 98% |
| artists (via `library_item_artist`) | 4,620 / 4,627 |
| `custom_language` | 75% |
| `custom_tags` | 73% |
| `series_name` | 71% |
| `publisher` | 1% |
| `language`, `description` | 0% |

### C.3 `Genre` will usually be empty — that is correct

nhentai `category` tags only survive on real rows, so `Genre` is normally absent
and all descriptive terms land in `Tags`. That is the desired outcome and matches
Kavita's filters. See §4.2.1 for why PDFs behave differently (everything in
Genres) and what that means when converting.

### C.4 `series_index` without `series_name`

Observed on a real item: `series_index = 1.0`, `series_name = NULL`. The naive
mapping emits `<Volume>1</Volume>` while `Series` falls back to the title, giving
"volume 1 of a one-item series". With 98% vs 71% coverage this affects roughly
1,200 items. Gate `Volume` on a real `seriesName`.

### C.5 The language field is free text

One item's `custom_language` was `translated` — an nhentai *tag*, not a language.
`toIsoLanguage()` correctly returns nothing, so `LanguageISO` is omitted rather
than fabricated. Do not "fix" this by inventing a mapping; an absent language is
better than a wrong one. Surfacing it in the UI so the user can correct the field
would be a reasonable follow-up.

### C.6 The prototype, and how it was run safely

The prototype lives outside the repo (a scratch directory) and is **not** the
deliverable — the shipping implementation is TypeScript per §12. It is worth
reading before implementing, because its logic is already validated.

Practical notes that transfer:

- Python's `zipfile` with `ZIP_STORED` produces the same layout `archiver` will
  with `store: true`. Entry order is explicit in both.
- Write `dest + '.part'` then `os.replace()` — an interrupted run must never leave
  something the scanner would ingest as complete.
- Scratch went on `/mnt/unity` (2.2 TB free), **not** `/tmp`, which is a 16 GB
  tmpfs. Extracting a 291 MB PDF's pages would otherwise have consumed RAM.
- The live library was opened read-only and its file mtimes were confirmed
  unchanged afterwards. Do the same: **never write to the live tree while
  testing.** `/mnt/bragi/Kavita/DoujinsTest/` exists for this.
- Read the DB with `sqlite3.connect('file:…?mode=ro', uri=True)`, and re-read it
  before each run — a cached snapshot silently misses metadata the user just
  edited in the app.

Verification assertions the prototype used, all of which belong in the real test
suite (§10.3): `ComicInfo.xml` is entry 0 and at the root; entry count ==
`PageCount` + 1; image names match `\d{4}\.\w+` and sort correctly; every entry
is `ZIP_STORED`; the XML parses; Title/Series round-trip **decoded**; no `<Count>`
or `<Format>`; no unescaped bare `&`.
