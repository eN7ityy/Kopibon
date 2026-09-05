# 07 — Metadata specification (the contract)

Every byte the app writes into `ComicInfo.xml`, a PDF XMP packet, a PDF Info
dictionary, and the CBZ ZIP container is a contract with existing user
libraries and with Kavita. This document is that contract for the Rust port.
Sources: `plans/kopibon_rust_port/discovery-01-metadata.md` (verified against
source), the golden fixtures in `/mnt/bragi/Kavita/DoujinsTest/`, and the
Wave-2 spikes (S1/S3/S4, recorded in §10 here). Parity levels follow D2/D6.

---

## 1. Artefacts and parity levels

| Artefact | Parity level | Settled by |
|---|---|---|
| `ComicInfo.xml` (bytes, as written into CBZ) | **byte-identical** | template renderer + mappers (this doc §2–4) |
| `/Keywords` + Info dict values | **semantic** (values identical; encoding of strings may differ) | D6 — port drops `pikepdf 10.8.0` Producer and emits `/Trapped /False` as a proper name |
| PDF XMP packet bytes | **byte-identical** | S1 PASS: render template in Rust, apply the two lxml normalisations (§10.1), write via lopdf uncompressed — 1782/1782 bytes round-tripped |
| ZIP container | **byte-identical on every structural field** | S3 PASS: hand-rolled STORE-only writer (§10.2) |
| Whole-PDF bytes | NOT a target — pikepdf rewrites the file; the port only commits to artefact-level parity | — |
| Page image extraction (PDF→CBZ) | **byte-identical** for DCTDecode sources | S4 PASS: 16/16 images byte-identical vs `pdfimages -all` |

## 2. Template engine — formal spec

Port `src/main/services/metadata/template-engine.ts` (162 lines) exactly.
Grammar (regexes verbatim, template-engine.ts:36-46):

```
PLACEHOLDER     /\{\{\s*([A-Za-z_][A-Za-z0-9_]*|\.)\s*(\?)?\s*\}\}/g
BLOCK_OPEN      /^\{\{#(each\s+)?([A-Za-z_][A-Za-z0-9_]*)\}\}$/   (anchored: alone on its trimmed line)
BLOCK_CLOSE     /^\{\{\/(each|[A-Za-z_][A-Za-z0-9_]*)\}\}$/
INLINE_SECTION  /\{\{#([A-Za-z_][A-Za-z0-9_]*)\}\}([\s\S]*?)\{\{\/\1\}\}/   (backreference, non-greedy, NO each)
```

Semantics (all cites to template-engine.ts):

1. **Emptiness** (`isEmpty` :54-59): `null`/`undefined`/`false` empty; `true`
   present; array empty iff `length === 0`; otherwise empty iff
   `String(value) === ''`. So `0` and `'0'` are **present**.
2. **Scalarisation** (`scalar` :67-72): `null`/`undefined`/`false` → `''`;
   `true` → `'true'`; array → `join(', ')`; number → JS `String(Number)`;
   else the string.
3. **Line drop** (:135-145): if **any** `{{name?}}` on a line resolves empty,
   the whole line is omitted — no blank line remains. Non-optional
   placeholders never drop a line.
4. **Block sections** (:115-133): a trimmed line matching BLOCK_OPEN opens a
   section. `findClose` (:79-96) tracks depth; at depth 0 the closer text must
   match, else throw `Template: expected {{/x}} on line N, found {{/y}}`;
   missing closer → `Template: {{/x}} is missing (section opened on line N)`.
   Line numbers are 1-based in both messages. A non-`each` section renders its
   body iff `!isEmpty`, markers and body both vanish otherwise.
5. **`each`** (:122-126): `const items = Array.isArray(value) ? value : []` —
   non-array/missing → **zero iterations**. Body renders recursively with
   `item` bound; `{{.}}` → item (:139); surrounding context stays visible.
6. **Inline sections** (:99-107): expanded on every non-block line **before**
   placeholder substitution (:136), looping until no match remains.
   Consequence: a `{{x?}}` inside a removed inline section can never set
   `dropLine`.
7. **Newline handling** (:158-161): global `\r\n` → `\n`, then exactly **one**
   trailing `\n` stripped (`/\n$/`), split, render, `join('\n')`.
   `'a\nb\n'` → `'a\nb'`; `'a\nb\n\n'` → `'a\nb\n'`.
8. **Escaping: none in the engine.** The mapper owns XML escaping.
9. Unknown placeholder → `undefined` → `''` (and drops the line if `?`).

**S1 normalisation for the XMP artefact:** the 1.x pipeline's final XMP bytes
are the template output passed through pikepdf's lxml serialiser, which (a)
self-closes empty elements (`<x></x>` → `<x/>`) and (b) appends a newline tail
after the root element so the packet ends `</x:xmpmeta>\n\n<?xpacket
end="w"?>\n`. The Rust writer reproduces exactly these two normalisations
after rendering — no XML library, no other rewrites. Verified: byte-identical
to the golden packet (S1).

**Required tests:** differential fuzz against the JS engine seeded from the 26
cases in `template-engine.test.ts` (substitution 12, optional lines 6,
sections 9, each 4, file shape 3 — see discovery-01 §8 for the enumeration)
plus generated templates over random contexts.

## 3. XML helpers (xml-utils.ts)

- `escapeXml` (:19-36): strip `[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]` **first**,
  then `& < > " '` → `&amp; &lt; &gt; &quot; &#39;`, ampersand first.
- `decodeXmlEntities` (:47-56): hex, decimal, then the named five; ampersand
  **last** (parse side).
- `toIsoLanguage` (:116-122): lowercase+trim; bare `^[a-z]{2}$` passes
  through; else `LANGUAGE_TO_ISO` lookup or `null`; map covers nhentai names
  plus ISO-639-2 T and B forms (:79-108).
- `resolveLanguageName` (:141-184): normalise each candidate to its primary
  subtag via `split(/[-_]/)[0]`, return the first of `['English',
  'Japanese', 'Chinese']` **by priority order, not input order** whose aliases
  are present, else `null`.

## 4. Decision rules — preserved verbatim (mappers.ts)

| Rule | Expression | Cite |
|---|---|---|
| `isPartOfSeries` | `Boolean(seriesName && seriesName.trim())` — name alone decides; NOT `series !== title` | mappers.ts:39-41 |
| `seriesTitle` | `seriesName ?? title` | :44-46 |
| `seriesNumber` | `null` unless `isPartOfSeries`; `null` unless `seriesIndex != null && seriesIndex > 0`; else the index | :56-60 |
| `resolveWriters` | `artists` non-empty → else `groups` non-empty → else `['Unknown']` | :69-73 |
| `resolvePublisher` | `groups[0] ?? publisher ?? null` | :76-78 |
| language value | `meta.language ?? resolveLanguageName(languageTags)` | :87-89 |
| `resolveSeriesGroup` | `parodies[0] ?? null` — first parody, unconditional | :102-104 |
| `resolveLocalizedSeries` | `null` when part of a series; else `titleJapanese ?? null` | :116-119 |
| `authorSort` | `writers[0]?.split(' ').reverse().join(' ') ?? 'unknown'` | :228-230 |
| `galleryId` in context | `meta.galleryId ?? ''` — **0 becomes empty** | :136-138 |
| `galleryId` in `/Keywords` | `meta.galleryId != null` — **0 emits `nhentai:0`**; the two guards deliberately disagree — preserve both halves | :272 vs :138 |
| `date` (XMP) | `(releaseDate ?? now()).toISOString()` — undated gets the write moment | :235-236, :244 |
| `metadataDate` | `new Date().toISOString().replace(/\.\d{3}Z$/, '.000000+00:00')` | :245-246 |
| `seriesIndex` (XMP) | `!= null ? toFixed(2) : ''` | :247 |
| `seriesIndex` (keyword) | `!= null` → raw value — ungated by `isPartOfSeries`, no `toFixed` | :274 |
| ComicInfo date | year/month/day all-or-nothing; month/day 2-digit padded | :208-210 |
| `PageCount` | always derived from the archive/image list, never the caller | cbz-generator.ts:63, apply-metadata.ts:123-127 |

`FileMetadata` adapters (file-metadata.ts) — port all fields even where no
shipped template uses them, so a template edit never needs a code change:
`DEFAULT_FILE_METADATA` (title `'Untitled'`, pageCount 0,
`mangaDirection 'YesAndRightToLeft'`, `ageRating 'Adults Only 18+'`,
:185-215); `toDate` falsy incl. timestamp 0 → null, `'seconds'` ×1000,
invalid → null (:234-238); `isRealGalleryRow` (:256-266);
`fileMetadataFromGallery` (title = `title.pretty`, tags bucketed by type,
`allTags` = every name, gallery `language` field deliberately not consulted,
:270-308); `fileMetadataFromLibraryItem` (title = `customTitle || 'Gallery
#N'`, `artists = [primaryArtist]` — row column, not artist tags; stub row →
tags from `splitList(customTags)`; real row → `languageTags` += customLanguage,
:317-357); `fileMetadataFromPayload` (no typed tags; language taken as decided;
:365-383).

## 5. Field × artefact rules (no blank cells)

The 12 write paths (discovery-01 §7) all funnel through three shared context
builders — `comicInfoContext` (:190-213), `xmpContext` (:233-250),
`buildKeywordTokens` (:267-281) — plus `buildDocInfo` (:284-296). The rule per
artefact field is therefore fixed; the paths differ only in the metadata
source (§6). Complete rule list:

**ComicInfo.xml** (template `resources/metadata-templates/comicinfo.template`):
`Title`=`title`; `Series`=`seriesTitle` (never empty — :195);
`LocalizedSeries` optional (:5, :200); `Number`=`seriesNumber ?? ''` (:196);
`Summary`=`description` (:198); `Writer`/`Penciller`=`resolveWriters` joined
by template join (:8-9); `Publisher` optional (:10); `Genre` = categories
**then** parodies (:153-160); `Tags` = tag-type tags only (:161) — unlike XMP
`dc:subject` = `allTags` (:242-243); `Characters` optional; `Web` =
`https://nhentai.net/g/{galleryId}` only when galleryId present (template :14
+ context :136-138); `Notes` = current product string + gallery id
(comicinfo.template:15); `PageCount` always, including 0 (:171, template :16);
`LanguageISO` optional (:17); `Year`/`Month`/`Day` all-or-nothing (:208-210);
`AgeRating`, `Manga` always (:21-22); `SeriesGroup` = first parody (:23);
`StoryArc`/`StoryArcNumber` only when part of a series (:201-206). Never
written: `Volume`, `Count`, `Format`, `AlternateSeries`, `AgeRating` beyond
the default (mappers.test.ts:114-124).

**XMP packet** (template `resources/metadata-templates/pdf-xmp.template`):
`dc:title` Alt/x-default; `dc:description` Alt (self-closes when empty — see
§10.1); `dc:creator` Seq of `resolveWriters`; `dc:subject` Bag of **allTags**
(:242-243); `dc:publisher` Bag gated by inline section (:30); `dc:language`
Bag of ISO code, gated (:32-38); `dc:date` Seq of ISO (:235-236 — now-fallback
for undated); `pdfx:isbn` + `prism2:isbn` = galleryId **inline single line**
(:44); `pdf:Producer` (:44); `xmp:MetadataDate` (:45-47); the whole calibre
`rdf:Description` block sits inside `{{#seriesName}}…{{/seriesName}}` and
vanishes wholesale for one-shots (:48-58) — including `calibre:timestamp`
(= `date`), `calibre:title_sort` (= title), `calibre:author_sort`.

**Info dict**: `Title` = raw title (unescaped — Info dict, not XML,
:284-296); `Author` = writers joined `', '`; `Keywords` = §6 tokens; the port
emits `Producer = "Kopibon 2.x"` (D6 deviation) and `/Trapped /False` as a
name; `CreationDate`/`ModDate` are volatile (§9); the original `/Creator`
(pdf-lib string) is preserved by the writer.

**`/Keywords` token order** (:267-281): (1) every `meta.allTags` in order;
(2) `nhentai:{galleryId}` if `!= null` (0 included); (3)
`calibre_series:{seriesName}` if truthy; (4) `series_index:{n}` if `!= null`;
(5) `language:{Human name}` (resolved human-readable, unlike `dc:language`);
(6) `publisher:{resolvePublisher}`. Joined `", "`. **Parser pair required**:
values containing a comma or colon have unspecified round-trip behaviour —
write tests asserting current behaviour, do not "fix" it silently.

## 6. The 12 write paths and their deltas

| # | Path | Metadata source | Deltas from the shared rules |
|---|---|---|---|
| 1 | Download → PDF | `fileMetadataFromGallery(payload, {pageCount, format:'pdf'})` | XMP+Info via the PDF writer; failure is warn-only, non-fatal (download-pdf.worker.ts:48-81) |
| 2 | Download → CBZ | same with `{pageCount, mangaDirection, format:'cbz'}`, or `makeFileMetadata` with no gallery | ComicInfo from template; no XMP (download-cbz.worker.ts:43-86) |
| 3 | Custom entry → CBZ | `makeFileMetadata({...})` | marker filename prefix `[nhentai-00000]` (library.ipc.ts:1304-1318) |
| 4 | Custom entry → PDF | same | via metadata.worker → PDF writer (library.ipc.ts:1479-1500) |
| 5 | `updateMetadata` | `metaForItem(item, {…edited})` | comicinfo.ts parse side feeds edited fields (library.ipc.ts:1815-1882) |
| 6 | `renameSeries` | `metaForItem(item, {seriesName: trimmed})` | per member (library.ipc.ts:726-733) |
| 7 | `assignSeries` | `metaForItem(item, {seriesName, seriesIndex: volume})` | moves file into series dir (:1178-1200) |
| 8 | Sync | `fileMetadataFromGallery(gallery, {title, seriesName, seriesIndex, format})` | whole API response posted back to refresh cache (sync.worker.ts:128-146, :185-195) |
| 9 | `convertAllMetadata` | `metaForItem(item)` per row | in-memory array, non-resumable; moves `[nhentai-N]` marker to end (library.ipc.ts:2069-2110) |
| 10 | PDF → CBZ convert | `fileMetadataFromLibraryItem({...item.metadata, id}, {pageCount, mangaDirection, format:'cbz'})` | archives original under `_originals/` or `_lossy/` (convert-cbz.worker.ts:216-283) |
| 11 | Attach/detach id | filename only — **no in-file write** | `applyGalleryIdToFilename` (gallery-filename.ts:42-54) |
| 12 | CLI `rewrite-comicinfo` | `fileMetadataFromLibraryItem(row, {seriesName, seriesIndex, format:'cbz'})` | `--templates=` defaults to the userData copy (tools/rewrite-comicinfo.mjs) |

Shared dispatcher: `applyMetadata` — `cbz` → ComicInfo rewrite in place,
everything else → the PDF writer (apply-metadata.ts:204-220). CBZ rewrite
preserves every original entry except `ComicInfo.xml`, serialised
deliberately, stored not deflated (apply-metadata.ts:114-192).

## 7. Filename and path rules

Three distinct sanitisers — not one; port all three verbatim:

| Sanitiser | Rule | Cite |
|---|---|---|
| Download | `title.replace(/[/\\?%*:|"<>]/g,'_').substring(0,180)`; `<libraryRoot>/<primaryArtist>/<safeTitle> [nhentai-{id}].{ext}` | download-manager.ts:547-553 |
| Custom entry | same class but **deletes** the chars, caps at **120**, marker as **prefix** `[nhentai-00000]` | library.ipc.ts:1304-1318 |
| Directory segments | `_` substitution + leading-dot strip + cap 180 + `'Unknown'` fallback | convert-cbz.worker.ts:61-79 |

Marker: `/\s*\[nhentai-\d+\]\s*/g` matched anywhere
(gallery-filename.ts:14). Attach/detach (:42-54): strip markers → collapse
whitespace → trim; marker ` [nhentai-{id}]` appended; empty stem →
`Untitled`; `room = 255 - byteLen(marker + ext)`; **the stem** is
`truncateToBytes`-ed and `trimEnd()`-ed, never the marker. Limits are **255
UTF-8 bytes of the basename only** (temp-path.ts:22-37); code-point-safe
truncation (:54-66); temp siblings live in the target dir, hashed+truncated
past the limit (:79-90). Folder layout `<artist>/…`, series members in
`<artist>/<seriesName>/`; reserved names `_Unsorted`, `_migration_staging`,
`_originals` (library-scanner.worker.ts:606-607). DB `file_path` is relative
to the library root (library-paths.ts:19-36).

**Rust hazard:** JS strings are UTF-16; Rust `String` is UTF-8 and Windows
paths are UTF-16 (`OsStr`). The 255-byte rule is byte-based on the basename —
required boundary tests at 251–255 bytes with real Japanese titles, and tests
that `truncateToBytes` never splits a code point.

## 8. Legacy tolerance (D7)

- Scanner/`comicinfo.ts` parse side tolerates both `Tagged by Doujin Downloader
  — nhentai gallery N` (seen live in all three golden fixtures) and the current
  `Tagged by Kopibon — …` Notes strings.
- Both marker placements (prefix `[nhentai-00000]` and suffix
  ` [nhentai-528499]`) are first-class inputs; `applyGalleryIdToFilename`
  handles either.
- The writer **always emits the current** product string; nothing ever
  rewrites legacy Notes unprompted.

## 9. Volatile-field injection policy

Every non-deterministic byte must be injectable or the golden corpus cannot be
frozen:

| Field | Source | Injection |
|---|---|---|
| `xmp:MetadataDate` | write moment | clock parameter on the PDF writer |
| `dc:date` now-fallback | write moment when undated | clock parameter on the mapper context |
| `calibre:timestamp` | = `date` | inherits |
| Info `/CreationDate`, `/ModDate` | write moment | clock parameter |
| ZIP DOS date/time + `UT` mtime | per-entry mtime | mtime parameters on the ZIP writer |
| Page ordering | array order | explicit in fixtures |

## 10. Spike evidence (Wave 2, code in /tmp per the plan)

### 10.1 S1 — XMP byte parity: PASS
A faithful Rust port of the template engine rendered `pdf-xmp.template` for
the golden PDF's metadata; output equals the golden packet (1782 bytes)
exactly after the two lxml normalisations of §2. `lopdf` replaces the
`/Metadata` stream and Info dict and the packet round-trips byte-identical,
uncompressed (`/Length 1782`), page count preserved, Info fields set.
Caveats: lopdf inlines the metadata dict into the catalog object (pikepdf
writes an indirect object — both parse fine; if exact structure matters, split
it out); whole-file bytes differ (accepted, §1).

### 10.2 S3 — ZIP container parity: PASS
A hand-rolled STORE-only writer (~180 lines: local headers, data descriptors,
central directory, UT extra, EOCD, CRC-32) matches the golden CBZ on every
structural field: version-made-by 831 (6.3 / create_system 3 Unix),
version-needed 20, method 0 STORE, `ComicInfo.xml` first with local sizes and
flag 0x0800, pages streamed with flag 0x0808 + 16-byte data descriptor (sig
`PK\x07\x08`), UT extra (`55 54 05 00 03 + mtime`) **in the central directory
only**, internal attrs 0, external attrs `0x81B40000` (0664) for ComicInfo and
`0x81A40000` (0644) for pages, no archive comment, 4-digit page names.
Python `zipfile` validates CRCs. The `zip` crate is not used for writes.

### 10.3 S4 — native lossless extraction: PASS
lopdf page → `/Resources/XObject` → `DCTDecode` streams dumped raw are
byte-identical to `pdfimages -all` output on the golden PDF (16/16). Scope
note: this covers the lossless path (the app's own PDFs embed sharp-JPEG
DCTDecode streams). The `pdftoppm -jpeg -r 150` **fallback path** (count
mismatch / non-JPEG sources) has no native equivalent yet — a Rust rasteriser
(pdfium-render or mupdf) is an open work item (Q-S4 fallback in
16-open-questions).

## 11. Golden fixtures

Located in `/mnt/bragi/Kavita/DoujinsTest/`, produced by 1.x on 2026-09-05,
known good in Kavita (library Doujin-Test, id 6):

1. `DEMONBANE FANZIN Vol. 1_ DEMONBANE CAUSAL SEQUENCE [nhentai-528499].cbz`
   — 51 entries (ComicInfo + 50 pages), series-untitled one-shot, parody
   `demonbane` as SeriesGroup, `LanguageISO ja`, Notes = **legacy** string.
2. `Red Crais - Part 1 - [nhentai-527515].cbz` — 36 entries, publisher
   present (circle as publisher), characters, 2-tag+parody Genre.
3. `Kaijou Gentei Omakebon [nhentai-527302].pdf` — 16 pages; Info dict:
   `/Author (shaa)`, pdf-lib `/Creator`, `/Keywords` = 7 allTags +
   `nhentai:527302, language:Japanese, publisher:neko-bus tei`,
   `/Producer (pikepdf 10.8.0)`, `/Trapped (/False)`; XMP packet 1782 B with
   in-attribute BOM, self-closed empty `dc:description` li, MetadataDate
   `.000000+00:00`, no calibre block (one-shot).

ComicInfo byte-parity tests against these fixtures must exclude the `Notes`
line (fixtures predate the rebrand; D7 keeps the current name in writer
output) — resolved in 16-open-questions Q11.

## 12. Sanctioned bug fixes (the only behaviour changes)

1. sharp's silent thumbnail failure and pikepdf's silent empty-metadata
   failure become **loud** failures (planning plan §4).
2. The pikepdf `.tmp` path bypassing the 255-byte guard (xmp-inject.ts:49)
   disappears with Python (D3) — noted, not ported.
3. `galleryId` 0 asymmetry (§4) is a **preserved** inconsistency, not a bug
   to fix.
