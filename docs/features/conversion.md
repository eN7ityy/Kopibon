# Conversion (PDF → CBZ)

Conversion takes PDFs in your library and rebuilds them as CBZ archives — page
images copied out of the PDF and packed with a fresh `ComicInfo.xml`. It is
designed to be lossless when possible, safe (the source is never touched until
the result is verified), and resumable if you quit halfway through a long
batch. The extraction logic is [`pdf-extract.ts`](../../src/main/services/pdf-extract.ts)
and the archive builder is [`cbz-generator.ts`](../../src/main/services/cbz-generator.ts).

## Lossless extraction

Pages are copied out of the PDF with **`pdfimages -all`**, which copies JPEG
streams byte-for-byte and converts everything else to PNG — no re-compression,
so the CBZ keeps the original image quality and is usually smaller than the
PDF. When `pdfimages` cannot produce a verified page-for-page match, the app
falls back to **`pdftoppm -jpeg -r 150`**, which re-rasterises every page at
150 DPI. That fallback is lossy, and files converted with it are flagged so
their source PDF is kept (see below).

## Verification

Every archive is opened and validated **before the source PDF is touched**. The
expected page count comes from `pdfinfo` (never from the database, which is
unreliable for scanned rows), and a conversion only proceeds when the archive
opens and every page is accounted for. Only then is the original removed or
archived.

## Originals handling

When you keep the originals, the source PDFs are moved into an **`_originals/`**
folder rather than deleted:

- The path is **configurable** (Settings → Downloads → Originals archive) and
  can point at different storage — originals are usually far larger than the
  CBZs that replace them.
- Files converted via the **lossy fallback** go into `_originals/_lossy/` and
  are **never** removed by the ordinary sweep, because for those the PDF is the
  higher-quality copy.
- **Settings → Downloads → Originals cleanup** reports the on-disk total, can
  **purge** the archive, and can **restore** originals back into the library —
  which moves the PDFs back and removes the CBZs that replaced them.

## Keep-original toggle

Whether the source PDF is kept or deleted is a **per-run decision** made in the
conversion dialog, with the **default** from Settings → Downloads (on by
default). Deleting requires ticking an acknowledgement, and is only offered
once the CBZ is verified readable.

## Resumable, crash-safe queue

Conversions are tracked in a queue. If the app quits or crashes part-way, a
banner offers to **resume** the unfinished work on the next start rather than
losing it. Each file is written to a temporary sibling and renamed over the
target only on a clean finish, so a crash never leaves a half-written archive
for the scanner to ingest.

## Dry-run preview

The conversion dialog can preview what would be converted before touching any
files, so you can check the scope of a large batch first.

## Batch conversion

Convert one file (from Library detail) or a whole selection (from the library
toolbar). The progress bar shows per-file progress with an ETA, and the queue
can be paused and cancelled between files.

## Why CBZ is better for Kavita

Kavita reads `ComicInfo.xml` with **Genre** and **Tags** as separate fields —
and this app writes `Genre` (categories + parodies) and `Tags` (nhentai
`tag`-type tags) as distinct values. A PDF has no such separation: everything
lands in `dc:subject`, and Kavita flattens it into genres. Converting a PDF
download to CBZ therefore gives Kavita both dimensions to filter on. See
[`metadata-pipeline.md`](metadata-pipeline.md).

## See also

- [Metadata pipeline](metadata-pipeline.md) — the ComicInfo.xml written into each CBZ
- [Kavita integration](kavita-integration.md) — why the format matters there
- [Library](library.md) — starting conversions from the library
- [External tools](../reference/external-tools.md) — poppler's role in conversion
