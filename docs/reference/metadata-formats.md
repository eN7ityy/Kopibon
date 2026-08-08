# Metadata formats

The exact fields the app writes, where they come from, and how the two formats
differ. This is the reference for [`../features/metadata-pipeline.md`](../features/metadata-pipeline.md);
the values are produced by [`mappers.ts`](../../src/main/services/metadata/mappers.ts),
rendered from the two templates in
[`resources/metadata-templates/`](../../resources/metadata-templates/README.md),
and read back by [`comicinfo.ts`](../../src/main/services/comicinfo.ts) and the
library scanner.

## ComicInfo v2.1 (CBZ)

The `ComicInfo.xml` written as the first entry of every CBZ. Field → source →
notes:

| Field | Source | Notes |
| --- | --- | --- |
| `Title` | File title | Always present |
| `Series` | Series name | Falls back to the title so it is never empty |
| `LocalizedSeries` | Japanese title | **One-shots only**. See pipeline docs |
| `Number` | Position in series | Only for real series members with `seriesIndex > 0` |
| `Summary` | Description | |
| `Writer` | Writers | Artists, else circles, else `Unknown` |
| `Penciller` | Writers | Mirrors `Writer` |
| `Publisher` | First group | Else the supplied publisher |
| `Genre` | Categories + parodies | Comma-joined; Kavita splits into genres and links by parody |
| `Tags` | nhentai `tag`-type tags | Separate from Genre |
| `Characters` | Characters | |
| `Web` | nhentai gallery URL | `https://nhentai.net/g/{id}` |
| `Notes` | "Tagged by Kopibon" | Carries the gallery ID |
| `PageCount` | Pages in the file | Derived from the archive, never trusted from the caller |
| `LanguageISO` | Resolved language | ISO 639-1 code |
| `Year` / `Month` / `Day` | Release date | All three written together, or none |
| `AgeRating` | Fixed | `Adults Only 18+` |
| `Manga` | Reading direction | `YesAndRightToLeft` by default |
| `SeriesGroup` | First parody | Kavita Collection |
| `StoryArc` | Series name | Kavita Reading List |
| `StoryArcNumber` | Position in series | |

## PDF XMP

The XMP packet injected into every PDF via pikepdf. Field → source → notes:

| Field | Source | Notes |
| --- | --- | --- |
| `dc:title` | File title | In an `rdf:Alt` with `x-default` |
| `dc:description` | Description | |
| `dc:creator` | Writers | One `rdf:li` per creator |
| `dc:subject` | **Every tag**, whatever its type | Not just `tag`-type tags |
| `dc:publisher` | First group | |
| `dc:language` | Resolved language | ISO 639-1 code, the shape calibre/Kavita expect |
| `dc:date` | Release date | Or the moment of writing when unknown |
| `pdfx:isbn` | nhentai gallery ID | |
| `prism2:isbn` | nhentai gallery ID | |
| `pdf:Producer` | `pikepdf 10.8.0` | |
| `xmp:MetadataDate` | When the file was written | Not the release date |
| `calibre:series` | Series name | Only written when a series name is set |
| `calibreSI:series_index` | Position in series | Two decimals, as calibre writes it |
| `calibre:timestamp` | Release date | |
| `calibre:title_sort` | Title | |
| `calibre:author_sort` | First creator, words reversed | calibre's shape |

Calibre compatibility is deliberate: the `calibre:` namespace fields are what
calibre's own XMP writer emits, so the files import cleanly into a calibre
library.

## PDF docinfo

Written alongside the XMP packet into the PDF's Info dictionary (Kavita reads
both):

| Field | Source |
| --- | --- |
| `/Title` | File title |
| `/Author` | Writers, comma-joined |
| `/Keywords` | Keyword token list (below) |
| `/Producer` | `pikepdf 10.8.0` |

## Keywords token format

The `/Keywords` value is a comma-separated list of tokens. They are plain text
(not templated) because the app's own scanner parses them back on a
rescan-from-disk round trip:

```
<tag names…>, nhentai:{id}, calibre_series:{series}, series_index:{index}, language:{Language}, publisher:{publisher}
```

| Token | Carries |
| --- | --- |
| `nhentai:{id}` | The nhentai gallery ID |
| `calibre_series:{name}` | The series name |
| `series_index:{n}` | The position within the series |
| `language:{Language}` | The human-readable language |
| `publisher:{publisher}` | The publisher |
| *(everything else)* | Tag names |

## Key differences between the formats

| | ComicInfo (CBZ) | XMP (PDF) |
| --- | --- | --- |
| Genre vs tags | **`Genre` and `Tags` are separate** | Everything lands in `dc:subject` |
| Series identity | `Series` + `Number` (distinct from `Volume`) | `calibre:series` + `calibreSI:series_index` |
| Language | `LanguageISO` | `dc:language` |
| Age rating / reading direction | `AgeRating`, `Manga` | Not represented |
| Reading lists / collections | `SeriesGroup`, `StoryArc` | Not represented |

The Genre/Tags separation is the main reason a CBZ reads better in Kavita: it
can filter on both dimensions, whereas a PDF flattens them into a single genre
list. See [`../features/conversion.md`](../features/conversion.md).

## See also

- [Metadata pipeline](../features/metadata-pipeline.md): how the values are decided
- [Library layout](library-layout.md): how the scanner reads these fields back
- [External tools](external-tools.md): pikepdf's role in writing the PDF side
