# Library

The Library is where everything you download — and everything you already own —
lives. Point it at a folder of PDFs or CBZs and the scanner reads the metadata
back out, builds thumbnails, and matches items to galleries. From there you can
browse three view modes, filter and search, group volumes into series, edit any
field, sync against nhentai, convert formats, and add doujinshi that nhentai
does not host.

The UI is built from [`LibraryPage.tsx`](../../src/renderer/src/components/library/LibraryPage.tsx),
with detail and series panels in the same folder. The scanner that feeds it is
[`library-scanner.worker.ts`](../../src/main/services/library-scanner.worker.ts).

## Scanning

A **Rescan** walks the whole library folder. The scan runs in a worker thread,
can be **paused, resumed and cancelled** from the toolbar, and shows a progress
bar with a live item count.

It is built to be safe with large libraries:

- **Incremental** — files whose modification time and size are unchanged are
  skipped, so a rescan of a big library is fast.
- **Recently written** files (modified in the last five seconds) are skipped, so
  a concurrent download is never read half-written.
- **Retry** — a file that failed once is re-queued on the next scan rather than
  forgotten.
- **Mass-delete guard** — the removal pass is skipped entirely if a directory
  could not be read, or if this scan discovered far fewer files than the last
  one (a likely sign a network mount disappeared). Otherwise a vanished share
  would delete the metadata for every file on it.

Items the scanner cannot match to an artist are filed under the `_Unsorted`
convention folder, which the scan ignores. The on-disk layout and what the
scanner expects from a file are covered in
[`../reference/library-layout.md`](../reference/library-layout.md).

## View modes

Three view modes, persisted across sessions:

- **Grid** — cover cards.
- **Compact** — smaller cards with more per row.
- **List** — rows that support **inline editing** (see below).

## Searching and filtering

- **Search** — full-text across title, artist, series, tags, filename, nhentai
  ID and publisher.
- **Filters** — **Artist**, **Series** and **Tag** are searchable
  multi-select dropdowns; pick several at once.
- **Unmatched only** — toggle to show only items with no nhentai ID.
- **Sort** — by **added date**, **title**, or **artist**.

## Inline editing (list mode)

In List view, click any cell to edit it in place: **title, artist, series and
volume**. Press **Enter** to save or **Escape** to cancel. Artist and series
fields use autocomplete; the volume field is a number.

## Series grouping

With **series grouping** enabled in Settings → Library, multi-volume series
collapse into a single card showing the volume count (e.g. "3 of 15") rather
than one card per file. Clicking a series card opens the series detail.

## Series detail

The series panel shows every volume, the languages and artists across the
series, and any missing volumes in the numbering. From here you can:

- **Rename the series** — moves the files into a renamed folder.
- **Dissolve** the series back into individual items.
- **Set the cover** from any volume.
- **Sync all members** with nhentai (only those with an nhentai ID).
- Open the series in **Kavita** when configured.

## Library detail

Clicking an item opens its detail panel, where you can:

- **Edit metadata** — title, series, volume, tags, language, publisher,
  description, with tag autocomplete.
- **Sync from nhentai** — pull fresh metadata for the item (see [`sync.md`](sync.md)).
- **Attach / detach an nhentai ID** — correct a wrong ID the scanner read from
  a filename, or add one to a file it could not match. Attaching syncs
  immediately.
- **Delete / remove** — remove the row, or also delete the file on disk
  (optionally mirroring the deletion in Kavita).
- **Convert to CBZ** — see [`conversion.md`](conversion.md).
- **Open in Kavita** — link straight into the matching series, or the reader.
- **Read** the file with the built-in PDF or CBZ viewer (see [`readers.md`](readers.md)).

## Series assignment

Select several items and assign them to a new or existing series. The dialog
**pre-fills a volume per item** from the title (patterns like `vol. 2`,
`ch. 4`, `episode 3`, `part 2`, `#5`) or sequentially. Series and volume are
written into the file's metadata in a single pass. The same dialog can remove
the items from their current series.

## Batch operations

In selection mode you can act on many items at once:

- **Delete files** (with optional Kavita mirroring)
- **Remove from library** (keep the files)
- **Convert to CBZ**
- **Select All** — selects across the whole library, not just the loaded page

Batch **Sync** is also available from the selection.

## Custom entries

The **Add Custom Entry** form adds a doujinshi that is not on nhentai. You
provide a title, artist(s), optional series, tags, language and date, and point
it at a **PDF file or a folder of images**. The app builds the file in the
chosen format (with optional compression), generates a cover thumbnail, and
files it in the library with no nhentai ID.

## Page counts

The page count is stored per file and shown in the list and series views. It is
populated at download and conversion time, and corrected when a download or
conversion drops a page — the count always reflects what is actually in the
file.

## See also

- [Library layout](../reference/library-layout.md) — the folder structure and filename rules
- [Downloading](downloading.md) — how new files arrive in the library
- [Sync](sync.md) — keeping library metadata current
- [Conversion](conversion.md) — turning PDFs in the library into CBZ
- [Kavita integration](kavita-integration.md) — how the library relates to a Kavita server
