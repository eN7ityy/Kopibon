# Phase 4 — Metadata Completeness & Move-on-Edit: Handoff Brief

## Status: Ready for Implementation

---

## Gap Analysis Summary

The current metadata system covers 5 of 11 Kavita-required PDF metadata fields. The remaining 6 fields are missing from the writer, the database schema, and/or the library scanner. Additionally, changing an item's series or artist in the UI does not move the file to the correct `{Artist}/{Series?}/` directory.

| Kavita Field | PDF Key | Writer | DB Schema | Scanner |
|-------------|---------|:---:|:---:|:---:|
| **Series Name** | `calibre:series` (XMP namespace) | ❌ Uses `/Subject` instead | ✅ `series_name` | ❌ Reads `/Subject` not XMP |
| **Volume** | `calibreSI:series_index` (XMP) | ❌ | ❌ | ❌ |
| **Language** | `dc:language` (XMP) | ❌ | ❌ `custom_language` only | ❌ |
| **Publisher** | `dc:publisher` (XMP) | ❌ `/Producer` used for app name | ❌ | ❌ |
| **Rating** | `calibre:rating` (XMP) | ❌ | ❌ | ❌ |
| **Summary** | `dc:description` | ❌ | ❌ | ❌ |
| ISBN | `pdfx:isbn` (XMP) | ❌ `/Keywords nhentai:` token only | ❌ | ⚠️ From /Keywords |
| Title, Author | `/Title`, `/Author` | ✅ | ✅ | ✅ |
| Date | `/CreationDate` | ✅ | ✅ `upload_date` | ✅ |
| Genres/Tags | `/Keywords` (`dc:subject`) | ✅ | ⚠️ in raw_tags_json | ✅ |

---

## Fixes

### F1 — Move File When Metadata Changes

**Current state:** `SeriesAssignment.tsx` has the UI for assigning a series, and `metadata-writer.ts` can embed metadata. But changing an item's series or primary artist in the edit dialog does **not** move the PDF file to the correct directory.

**New IPC handler:** `library:updateMetadata(id, data)`

1. Receive updated metadata: `{ title?, primaryArtist?, seriesName?, seriesIndex?, tags?, language?, publisher?, description? }`
2. Update `library_item` row in DB with changed fields
3. Read the PDF's existing embedded metadata (all fields, preserve unchanged values)
4. Merge in changed fields
5. Re-embed all metadata into the PDF via `metadata-writer.ts` (run the full `embedMetadata` function)
6. **Determine new file path:**
   - Artist changed → recompute `{root}/{newPrimaryArtist}/`
   - Series changed → recompute whether file goes in `{Series}/` subdirectory
   - Neither changed → keep current path
7. **If path changed:** create destination directory, move file, delete empty source directory
8. Update `library_item.file_path` in DB
9. Return `{ success: true, newPath: string }` to renderer

**Renderer:** After edit, the Library page must refresh to show the item at its new location.

### F2 — Series Index (Volume Number)

**Database:** Add column to `library_item` table:
```sql
series_index REAL
```
`REAL` supports both integer volumes (1, 2, 3) and fractional (1.5 for omakes/specials).

**Metadata writer:** When `seriesIndex` is provided, embed as XMP in the calibre namespace:
```xml
<ns0:series_index xmlns:ns0="http://calibre-ebook.com/xmp-namespace">{value}</ns0:series_index>
```
The element is `series_index` in `{http://calibre-ebook.com/xmp-namespace}` (NOT the `calibreSI:` namespace). Using pdf-lib's XMP API. If pdf-lib cannot write XMP (known limitation from Part 13), fall back to `/Keywords` token `series_index:{value}`.

**Library scanner:** Extract `series_index` from:
1. XMP `{http://calibre-ebook.com/xmp-namespace}series_index` (primary — this is what Calibre writes. Verified in "HYPNO BLINK 8" by "sakamata nerimono": the XMP contains `<ns0:series_index xmlns:ns0="http://calibre-ebook.com/xmp-namespace">8.0</ns0:series_index>`)
2. XMP `{http://calibre-ebook.com/xmp-namespace-series-index}series_index` (alternate namespace: `calibreSI:` — declared in some PDFs but may not contain the value)
3. `/Keywords` token `series_index:(\d+(?:\.\d+)?)` (fallback if XMP write fails)
4. Store in `library_item.series_index`

**Real-world XMP structure confirmed from existing Calibre PDFs:**

```xml
<rdf:Description xmlns:calibre="http://calibre-ebook.com/xmp-namespace"
                 xmlns:calibreSI="http://calibre-ebook.com/xmp-namespace-series-index"
                 rdf:about="">
  <calibre:series rdf:parseType="Resource">HYPNO BLINK</calibre:series>
  <!-- series_index is in the CALIBRE namespace, not calibreSI -->
  <ns0:series_index xmlns:ns0="http://calibre-ebook.com/xmp-namespace">8.0</ns0:series_index>
</rdf:Description>
<dc:language>eng</dc:language>
```

**Important:** During library scans, existing `series_index` values from Calibre-managed PDFs must be read and populated into the database. Currently the scanner's `extractPdfMetadata()` function (line 86-106 of `library-scanner.worker.ts`) does NOT read XMP metadata at all — it only reads docinfo fields (Title, Author, Keywords, CreationDate). F2+F3 must extend it to open and parse the XMP metadata stream for `calibre:series`, `series_index` (calibre namespace), `dc:language`, `dc:publisher`, and `dc:description`.

**UI:** Add a number input labeled "Volume" to the SeriesAssignment dialog and the LibraryDetail edit form. Default empty (no volume). Accepts integers and decimals.

### F3 — Write Series to calibre:series XMP

**Metadata writer change:** Currently `seriesName` is written to `/Subject` (line 91-93 of metadata-writer.ts). Change to:
1. Write series name to XMP namespace `{http://calibre-ebook.com/xmp-namespace}series` (this is what Kavita reads)
2. Also keep `/Subject` for backward compatibility with tools that read the docinfo field
3. If pdf-lib cannot write XMP (known pikepdf limitation from migration), embed in `/Keywords` as `calibre_series:{name}` token as a fallback, AND try XMP write

**Library scanner change:** `extractPdfMetadata()` must read series from:
1. XMP `calibre:series` namespace (primary)
2. `/Subject` (fallback for legacy PDFs)
3. `/Keywords` token `calibre_series:(.*?)(?:,|$)` (last resort)

### F4 — Language Metadata

**Database:** Add column to `library_item`:
```sql
language TEXT
```

**Metadata writer:** When language is available, embed as XMP `dc:language`. The nhentai API provides language as a tag with `type: 'language'` and name like `'english'`, `'japanese'`, `'chinese'`. Write the ISO 639-1 code if mappable, otherwise the full name.

Mapping: `english`→`en`, `japanese`→`ja`, `chinese`→`zh`

**Library scanner:** Extract from XMP `dc:language` or `/Keywords` token `language:(\w+)`.

**UI:** Add a language dropdown to the LibraryDetail edit form. Default populated from nhentai API language tag. Values: Any, English, Japanese, Chinese, Korean, French, Spanish, German, Other.

### F5 — Publisher Metadata

**Database:** Add column to `library_item`:
```sql
publisher TEXT
```

**Metadata writer:** Embed as XMP `dc:publisher`. Source from nhentai API: tags with `type: 'group'` → the group name is the publisher. If multiple groups, use the first one. `/Producer` stays as `"Doujin-Downloader"` (tool identifier, not publisher).

**Library scanner:** Extract from XMP `dc:publisher`. If not present, fall back to parsing `/Producer` only if it's not `"Doujin-Downloader"`.

**UI:** Display publisher in LibraryDetail (read-only, sourced from API). Add editable field for custom entries.

### F6 — Description / Summary

**Database:** Add column to `library_item`:
```sql
description TEXT
```

**Metadata writer:** Embed as XMP `dc:description`. nhentai does not provide descriptions in the API, so this field is primarily for custom entries. If the nhentai gallery has a description in the future, use it.

**Library scanner:** Extract from XMP `dc:description` or `/Subject` (if `/Subject` doesn't contain the series name — disambiguate).

**UI:** Add a textarea "Summary" to the CustomEntryForm and the LibraryDetail edit form. Optional.

---

## Files Affected

| File | Changes |
|------|---------|
| [`src/main/db/schema.ts`](src/main/db/schema.ts) | Add columns: `series_index REAL`, `language TEXT`, `publisher TEXT`, `description TEXT` to `library_item` |
| [`src/main/services/metadata-writer.ts`](src/main/services/metadata-writer.ts) | Rewrite: use XMP for calibre:series, calibreSI:series_index, dc:language, dc:publisher, dc:description. Keep /Subject for backward compat. Keep /Keywords for nhentai ID + tags. Fallback to /Keywords tokens if XMP write fails |
| [`src/main/services/library-scanner.worker.ts`](src/main/services/library-scanner.worker.ts) | Expand `extractPdfMetadata()` to read series from XMP, series_index, language, publisher, description |
| [`src/main/ipc/library.ipc.ts`](src/main/ipc/library.ipc.ts) | Add `library:updateMetadata` handler with file-move logic |
| [`src/preload/index.ts`](src/preload/index.ts) | Expose `updateMetadata` to renderer |
| [`src/preload/index.d.ts`](src/preload/index.d.ts) | Type declaration |
| [`src/renderer/src/components/library/SeriesAssignment.tsx`](src/renderer/src/components/library/SeriesAssignment.tsx) | Add Volume number input |
| [`src/renderer/src/components/library/LibraryDetail.tsx`](src/renderer/src/components/library/LibraryDetail.tsx) | Add editable fields: series index, language, description. After save, trigger file move + refresh |
| [`src/renderer/src/components/library/CustomEntryForm.tsx`](src/renderer/src/components/library/CustomEntryForm.tsx) | Add language dropdown, description textarea |
| [`src/renderer/src/components/library/LibraryPage.tsx`](src/renderer/src/components/library/LibraryPage.tsx) | Refresh grid after metadata edit |
| [`src/main/db/repositories/library.repo.ts`](src/main/db/repositories/library.repo.ts) | Update `update()` to handle new columns |
| Migration | New Drizzle migration for the 4 new columns |

---

## Implementation Order

F1 (move on edit) → F2 (series_index) → F3 (calibre:series XMP) → F4 (language) → F5 (publisher) → F6 (description)

F1 is the bug fix and must be done first. F2+F3 are the core Kavita compatibility features. F4–F6 are completeness.

## Verification

- `npm run build` passes with zero type errors
- Editing an item's series in LibraryDetail moves the file to `{Artist}/{Series}/` and updates the grid
- Editing an item's primary artist moves the file to `{NewArtist}/` and updates the grid
- New downloads have `calibre:series` and `calibreSI:series_index` in XMP metadata
- Library scanner correctly reads back all 11 Kavita fields
- Setting volume on a series item shows it correctly in the UI
