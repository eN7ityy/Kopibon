# Sync

Sync re-fetches a gallery's metadata from nhentai and updates the matching
library item — title, tags, artists, language, publisher, favourites count,
cover — then **re-writes that metadata into the file** so the change survives a
move or a rescan. It is how you keep an older download current, or backfill
correct metadata into a library that was scanned in before nhentai data was
attached. The per-item work runs in [`sync.worker.ts`](../../src/main/services/sync.worker.ts);
the queue, pacing and resume logic live in the sync handlers of
[`library.ipc.ts`](../../src/main/ipc/library.ipc.ts).

## What sync does

For each item:

1. Reads the **nhentai gallery ID** from the library row.
2. **Fetches** the gallery from the nhentai API.
3. **Updates the database row** — title, tags (now kept typed, so genres,
   parodies and characters survive), language, publisher, and the cached
   gallery row.
4. **Re-embeds metadata** in the file — XMP for a PDF, ComicInfo for a CBZ —
   using the API data plus your stored series and volume.
5. **Triggers a Kavita scan** if the item belongs to a series Kavita knows
   about, so the refreshed metadata is picked up (see
   [`kavita-integration.md`](kavita-integration.md)).

## Starting a sync

- **Single sync** — Library detail → **Sync** updates one item. (Attaching an
  nhentai ID to an item also syncs it immediately.)
- **Batch sync** — select several items and choose **Sync selected**.
- **Series sync** — Series detail → **Sync series** syncs every member that has
  an nhentai ID.

## Rate-limit pacing

Batch sync paces itself from the same per-endpoint rate table the API client
uses — `GET /galleries/{id}`'s limit, reduced slightly to stay under the
ceiling — so a run proceeds as fast as nhentai allows without tripping `429`s,
and an API key genuinely speeds it up (see
[`../getting-started/nhentai-api-key.md`](../getting-started/nhentai-api-key.md)).
The pacing counts each item's work against the interval rather than sleeping on
top of it.

## Cancellable

A batch sync can be **cancelled** from the progress bar. Cancellation takes
effect between items — never mid-write — because a sync rewrites the archive in
place, and tearing it down mid-write is how a file ends up truncated.

## Resume after a crash

Unfinished sync work is tracked in a queue. If the app quits or crashes
part-way through a batch, a banner offers to **resume** the remaining items on
the next start instead of losing your place. Items are claimed one at a time,
so a crash leaves exactly one in-flight row to put back.

## What sync does NOT do

- **Does not re-download pages** — only metadata is fetched; the images are
  never re-downloaded.
- **Does not change the file format** — a PDF stays a PDF, a CBZ stays a CBZ.
- **Does not move the file** — the file stays exactly where it is.

## See also

- [nhentai integration](nhentai-integration.md) — where the data comes from
- [Metadata pipeline](metadata-pipeline.md) — what gets re-written into the file
- [Library](library.md) — where the sync actions live
- [Kavita integration](kavita-integration.md) — the scan a sync can trigger
