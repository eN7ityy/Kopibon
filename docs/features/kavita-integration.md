# Kavita integration

Kavita is an optional self-hosted comic/manga server. This app does not need it
— everything works without it — but when you run both, the app can keep Kavita
in step with the library: it shows Kavita's view of each item, triggers a scan
after metadata changes so a renamed or re-tagged series appears immediately,
and mirrors deletions. The client is [`kavita-client.ts`](../../src/main/services/kavita-client.ts);
the raw server API is documented in [`kavita_api.json`](../../kavita_api.json).

## Requirements

- **Kavita running** and reachable (default URL `http://localhost:5000`).
- An **API key** from Kavita's **User Settings → Manage Auth Keys**.

## Setup

1. Open **Settings → Kavita** and enable the integration.
2. Enter your Kavita **Server URL** and **API Key**.
3. Press **Test Connection** — on success the pane shows a green "Connected"
   card with the server version and your username.
4. Press **Find Libraries** and pick the library that holds this folder. If the
   server has a single library it is picked automatically. Choosing a library
   also pre-fills the **Kavita Library Root** from its first scanned folder —
   this matters when Kavita sees the files under a different mount point than
   the app writes into.

The connection is persisted; on the next start the pane re-validates it and
restores the "Connected" card.

## Status indicators

- **Status bar** — an **"in Kavita"** count appears once configured. It is the
  server's `chapterCount` (one chapter per file), cached for a minute and
  refreshed after a scan or delete.
- **Library detail** — the panel looks up the item's matching Kavita series and
  shows its page count, format, last-updated date and your read progress, with
  a link into the reader when the file is found.
- **Series detail** — the same Kavita block for a whole series, searched by the
  series name.

## When scans fire

Kavita's own file watcher handles **discovery** of brand-new downloads, so the
app does not scan for those. It does trigger a targeted **series scan** after
the app changes something Kavita would otherwise miss until its next periodic
scan:

- After an **`updateMetadata`** call (a metadata edit or sync) — but only when
  the item belongs to a series Kavita knows about.
- After **`assignSeries`** (files moved into a series folder) — so the new
  volume appears with the correct grouping.

## How scans work

A scan resolves the item to a Kavita series **by name** — the stored series
name first, the item title as a fallback, preferring an exact case-insensitive
match — then calls `POST /api/Series/scan` to force a re-read of every file in
that series. The same name-matching is reused for delete mirroring, so the two
never drift apart.

## Delete mirroring

When you **delete a file** from the library, or **remove** items with the
"also drop from Kavita" option, the app looks up the matching Kavita series by
name and deletes it from Kavita's database. This is optional per action and
always fire-and-forget; the files on disk are untouched by the Kavita side.

## What does NOT happen

- **New downloads are not scanned** — Kavita's built-in watch folder handles
  discovery, because a folder scan on an artist/series folder does not pick up
  brand-new files reliably in this setup.
- **No read-progress or list syncing** — your Kavita reading progress is shown,
  but never pushed back to this app.

## Graceful degradation

Every Kavita call is **fire-and-forget**: the file operations they follow are
already done and correct. If Kavita is unreachable or misconfigured, the app
works exactly as before and Kavita catches up on its next periodic scan. The
only visible effect of a dead server is that the status bar count and the
detail-panel blocks stop updating.

## See also

- [Library](library.md) — the data the integration reflects
- [Sync](sync.md) — metadata changes that trigger a Kavita scan
- [Conversion](conversion.md) — why CBZ reads better in Kavita than PDF
- [Metadata pipeline](metadata-pipeline.md) — the ComicInfo/XMP the scanner reads
