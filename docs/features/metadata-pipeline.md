# Metadata pipeline

Every file the app produces and every file it edits carries real metadata:
title, artist, group, series and volume, language, tags, release date and age
rating. This is what makes the result a working collection in Kavita or
calibre rather than a folder of loose files. This page explains how that
metadata is decided and written. The exact byte layout lives in two plain-text
templates you can edit yourself. See
[`resources/metadata-templates/README.md`](../../resources/metadata-templates/README.md).

## Pipeline overview

Every metadata write flows through one shape:

```
input shape  ──adapter──▶  FileMetadata  ──mapper──▶  template context  ──template──▶  bytes
```

- **Adapters** ([`file-metadata.ts`](../../src/main/services/metadata/file-metadata.ts))
  pull facts out of whatever the caller has: an nhentai API gallery, a library
  row, or a hand-edited field, and make no decisions.
- **`FileMetadata`** is the one shape everything is written from.
- **Mappers** ([`mappers.ts`](../../src/main/services/metadata/mappers.ts)) make
  every decision: which series a file belongs to, who to credit, which language
  wins. There is exactly one mapper per format.
- **Templates** decide where those values go. They are text files, so changing
  *where* a value is written needs no code change.

## PDF path

A PDF gets two things written in parallel, both derived from the same
`FileMetadata` so they cannot disagree:

- An **XMP packet**, injected via Python + pikepdf ([`xmp-inject.ts`](../../src/main/services/xmp-inject.ts)).
  It uses calibre's namespaces (`calibre:series`, `calibreSI:series_index`) so
  the result is readable by calibre and Kavita, and stores the nhentai gallery
  ID in `pdfx:isbn`.
- A **PDF Info dictionary** (`/Title`, `/Author`, `/Keywords`, `/Producer`).
  Kavita reads both, and the keywords carry tokens the app's own scanner reads
  back (see [`metadata-formats.md`](../reference/metadata-formats.md)).

The dispatch between PDF and CBZ happens in
[`apply-metadata.ts`](../../src/main/services/apply-metadata.ts), the single
entry point for editing metadata on an existing file.

## CBZ path

A CBZ gets a **ComicInfo.xml v2.1** file as the **first entry** in the archive.
It is generated from the same mapper as the PDF path, so a CBZ and a PDF of the
same gallery describe it identically. No external tools are needed.

## Field mapping

The mappers turn nhentai tag types into ComicInfo and XMP fields:

| nhentai tag type | ComicInfo field | XMP field | Notes |
| --- | --- | --- | --- |
| `artist` | `Writer`, `Penciller` | `dc:creator` | Group used as fallback, then `Unknown` |
| `group` | `Publisher` | `dc:publisher` | The circle; doubles as publisher |
| `parody` | `Genre` + `SeriesGroup` | `dc:subject` | First parody → `SeriesGroup` (Kavita Collection) |
| `category` | `Genre` | `dc:subject` | `doujinshi`, `manga`, etc. |
| `character` | `Characters` | `dc:subject` | |
| `tag` | `Tags` | `dc:subject` | nhentai `tag`-type tags only |
| `language` | `LanguageISO` | `dc:language` | Resolved to one language, see below |
| *(n/a)* | `Series`, `Number`, `Volume` | `calibre:series`, `calibreSI:series_index` | The user's series grouping |

`Genre` is written as `categories + parodies`, comma-joined. Kavita splits it
into separate genres and uses the parody as a "Related" link, so a work shows
up under both `doujinshi` and its parody.

## Series numbering

Whether a file gets a `<Number>` is a deliberate rule:

- A file is part of a series **only if it has a series name**. The name is the
  whole test. It is not inferred from the title, because series are commonly
  named after their first instalment.
- The position (`seriesIndex`) is written **only for a real series member**,
  and only when it is a positive number. A one-shot gets no number.
- Kavita groups on `Series` and orders on `Number`; a file with neither becomes
  a Special, while a numbered one-shot would become a one-chapter series.

## SeriesGroup and collections

The **first parody** is written as `SeriesGroup`, which Kavita turns into a
Collection. This is a grouping above series, so every doujinshi parodying the same
work sits together regardless of which series each belongs to. Only the first
parody is used: a comma-joined value would be read as one nonsense collection.

## LocalizedSeries

The Japanese title is written as `LocalizedSeries` **only for a one-shot**,
where the series is the title and the Japanese title names the same work. For a
series member the Japanese title names that volume, not the series, so it is
left out. Writing it would give the whole series a name taken from whichever
volume Kavita scanned first.

## StoryArc

`StoryArc` and `StoryArcNumber` mirror the series and its number. Kavita turns
these into a Reading List. This is a second way to walk a series alongside the Series
grouping itself.

## Language resolution

Language is resolved from the gallery's `language`-type tags by priority rather
than by order, because the first of them is usually `translated`, which is not
a language. A language already stored on the library row wins. The resolved
value is written twice: human-readable (`English`) and as an ISO 639-1 code
(`en`), the latter being what Kavita reads from `LanguageISO` / `dc:language`.

## Template syntax quick reference

Templates support four constructs. Everything else is copied through verbatim.

| Syntax | Meaning |
| --- | --- |
| `{{name}}` | Substitute a value. The line is always kept, even when empty. Lists are joined with `, `. |
| `{{name?}}` | Substitute, or drop the whole line when empty. If a line has several, it drops when **any** is empty. |
| `{{#name}} … {{/name}}` | A section. Kept when non-empty, removed entirely otherwise. Can be nested. |
| `{{#each name}} … {{/each}}` | Repeat once per list item; `{{.}}` is the current item. |

Values are XML-escaped before reaching the template, so a title containing `&`
or `<` cannot break the file.

## Editing the templates

The templates are shipped to your user data directory on first start
(`~/.config/doujin-downloader/metadata-templates/` on Linux,
`%APPDATA%\doujin-downloader\metadata-templates\` on Windows). Edits take
effect on the next file written. No restart needed. To restore the default,
delete your copy of the file.

How to change a value (in the mappers) versus where it is written (in a
template) is documented in
[`resources/metadata-templates/README.md`](../../resources/metadata-templates/README.md).

## See also

- [Metadata formats](../reference/metadata-formats.md): the full ComicInfo and XMP field tables
- [Downloading](downloading.md): where the metadata is first written
- [Sync](sync.md): re-fetching metadata and re-writing it into a file
- [Conversion](conversion.md): why CBZ's ComicInfo is preferable in Kavita
