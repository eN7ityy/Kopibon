# Library layout

This page documents how the app arranges files on disk and the naming rules it
applies. It is the contract the downloader writes to, the series assignment
moves within, and the scanner reads back from. So a file that does not follow
it may not round-trip correctly.

## Folder structure

```
{libraryRoot}/
├── {Artist}/                              e.g. "Aoi Hiori"
│   ├── [nhentai-381397] The Title.cbz     standalone gallery
│   └── {Series}/                          e.g. "Blue Archive"
│       └── [nhentai-382011] Vol. 2.cbz    volume inside a series
```

- A downloaded file is written to `{Artist}/` with the title and an
  `[nhentai-{id}]` marker: `{Artist}/[nhentai-{id}] {title}.{ext}`.
- Assigning the file to a series **moves it into a `{Series}/` subfolder**,
  so series volumes group together.
- The scanner derives the artist from the **first path segment** and the series
  from the **second** when the file is two folders deep.

## Why this structure works with Kavita

- Kavita's comic scanner parses `Artist/Series/`-style folders natively: the
  top level becomes the library, the next level groups the series, and files
  inside are chapters/volumes.
- The `[nhentai-{id}]` marker makes the nhentai ID **discoverable from the
  filename alone**. The scanner reads it back, the metadata rewrite tool
  matches files by it, and a person can tell at a glance which gallery a file
  came from.

## Reserved folders

The scanner deliberately ignores these directories during discovery:

| Folder | Purpose |
| --- | --- |
| `_Unsorted/` | A catch-all for files you do not want treated as library entries |
| `_originals/` | Source PDFs archived during PDF → CBZ conversion (path configurable) |
| `_migration_staging/` | Internal migration scratch space |

## `_originals/`

When a conversion keeps the original PDF, it is moved to `_originals/` instead
of deleted. The path can be pointed at different storage via Settings; files
converted through the lossy fallback live in `_originals/_lossy/` and are kept
back from the ordinary purge. See [`../features/conversion.md`](../features/conversion.md).

## Multi-artist items

A gallery with several artists is **stored under the first artist** on disk,
but **every artist is recorded in the metadata**; ComicInfo `Writer` and XMP
`dc:creator` carry the full list, and the library stores them all. Re-sorting
by a different artist later is a library-level change, not a file move.

## File naming rules

- **Safe characters**: characters in `/\?%*:|"<>` are replaced with `_`
  before a file is written.
- **Title length**: the title is trimmed to **180 characters** before the
  `[nhentai-{id}]` suffix is appended.
- **255-byte limit**: a single filename must stay under 255 bytes (Linux).
  Japanese titles are three bytes a character, so when a name plus the marker
  would exceed it, the *title* is trimmed and the marker is always kept. It is
  the part the scanner and rewrite tool read.
- **ID suffix at the end**: the `[nhentai-{id}]` marker sits at the end, just
  before the extension, which is the placement Kavita's parser and this app's
  scanner expect.
- Attaching or detaching an nhentai ID renames the file to match, so the
  database and the disk never disagree about what a file is.

## What the scanner expects

The scanner ingests **PDF and CBZ** files and recovers as much as it can from
each:

- **Metadata embedded in the file**: XMP (PDF) or ComicInfo.xml (CBZ). The
  app's own files carry everything. Files from other tools are parsed as best
  as possible, including legacy shapes.
- **`[nhentai-{id}]` in the filename**: used to match the file to a gallery
  when no embedded ID is found.
- **PDF keywords tokens**: `nhentai:123`, `calibre_series:…`, `series_index:…`,
  `language:…`, `publisher:…` are read back so a rescan-from-disk round-trips
  the full picture (see [`metadata-formats.md`](metadata-formats.md)).

## See also

- [Library](../features/library.md): what the layout supports in the UI
- [Metadata formats](metadata-formats.md): the XMP and ComicInfo the scanner reads
- [Downloading](../features/downloading.md): where the layout is first written
