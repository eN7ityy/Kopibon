# Remaining Work Plan

Follow-up to the soft audit. Tier 1 (the ten actively-wrong behaviours) is **done and
verified**; everything below is what's left, ordered by value per unit of effort.

Effort key: **S** = under an hour · **M** = a few hours · **L** = a day or more.

---

## 0. Status — what's already fixed

Landed and verified (82 assertions across four throwaway suites, typecheck + build clean):

| # | Fix | Files |
|---|-----|-------|
| 1 | Rate limiting was fully disabled when logged in (`NaN` poisoned the bucket). Now per-endpoint buckets using documented limits, anon/auth switching, FIFO drain, `Retry-After` honoured | `rate-limiter.ts`, `api-client.ts`, `auth.ipc.ts` |
| 2 | Settings silently reverted to defaults (`.data` envelope bug + `loadFromDb` never called) | `settings.store.ts`, `App.tsx` |
| 3 | Library path setting ignored for scanning (3 hardcoded paths) | `LibraryPage.tsx` |
| 4 | `escXml` was a no-op → any `&` in a title produced invalid XMP | `xmp-inject.ts` |
| 5 | `dc:language` never written; volume-less series written nowhere. `dc:language` now an `rdf:Bag` matching calibre byte-for-byte | `xmp-inject.ts` |
| 6 | Sync always anonymous (`decryptKey` never exported) | `auth.ipc.ts`, `library.ipc.ts` |
| 7 | Search/favourites badges never refreshed (direct zustand mutation) | `search.store.ts`, `SearchPage.tsx` |
| 8 | Failed/cancelled downloads left a permanent phantom "Downloading" entry | `download-manager.ts` |
| 9 | Page images never deleted; `$HOME`-based path broke on Windows | `download-manager.ts` |
| 10 | Downloads interrupted by a crash stayed "active" forever | `download-manager.ts`, `index.ts` |

Also fixed along the way: `dc:description` read back as raw `rdf:Alt` markup and re-embedded
nested on every edit; XML entities not decoded on read; scanner couldn't parse the nested
`calibre:series` form it writes; speed permanently 0 KB/s; `download_page` rows never cleaned;
thumbnails moved out of `os.tmpdir()` and keyed by SHA-1; Python resolution on Windows plus a
startup toolchain probe; favourites search sent `query` instead of `q`; `autoUpdater` unhandled
rejection.

---

## 1. Correctness bugs

### 1.1 Bulk conversion always reports phantom failures — **S**
`library.ipc.ts` drains the queue then calls `worker.terminate()`, which emits `exit` with code
1; the handler counts that as a failure. Every clean run of N runners reports N failures.

Fix: set a `finished` flag before `terminate()` and ignore the exit code when set.

### 1.2 `downloadConcurrency` setting does nothing — **S**
`DownloadManager.setMaxConcurrent()` exists but is never called; the manager is pinned at 3.
Now that settings actually load (fix #2), wire `settings:set`/`setAll` to call it, and apply the
stored value at startup. Without this the slider in Settings is decorative.

### 1.3 No dedupe on `download:addToQueue` — **S**
Two fast clicks create two queue rows for the same gallery, racing on the same scratch dir and
output path. Reject (or return the existing id) when a non-terminal row already exists for that
`galleryId`.

### 1.4 `assignSeries` embeds a stale volume, then pays for it twice — **S**
`library.ipc.ts` passes `seriesIndex: item.seriesIndex` (the *old* value), ignoring its own
`seriesIndex` argument. `SeriesAssignment.tsx` then runs `updateMetadata` per item to correct it
— so every assignment does two full pikepdf passes per file. Use the argument, drop the second
pass. Meaningful speedup on large batches.

### 1.5 Sync worker leaks on the error path — **S**
`spawnSyncWorker`'s `worker.on('error')` resolves but never calls `terminate()`, leaking a
thread per failure. Batch-syncing a few hundred items with flaky network accumulates them.

### 1.6 Dead pdf.js CDN fallback — **S**
`PdfViewer.tsx` falls back to a hardcoded `4.x` CDN worker path while the project ships
`pdfjs-dist` 6.x — and the CSP (`script-src 'self'`) blocks it anyway. Remove it, or replace
with a visible error.

### 1.7 Cosmetics — **S**
`StatusBar.tsx` hardcodes `v1.0.0` (there's already an `app:getVersion` IPC). The `theme` row in
`app_settings` is written but never read — either read it at startup or drop it and let the ui
store own theme outright.

---

## 2. Data integrity

### 2.1 Foreign keys are declared ON but no constraints exist — **M**
`connection.ts` sets `PRAGMA foreign_keys = ON`, but not one `CREATE TABLE` declares an FK, so
it does nothing. Confirmed live: **14 orphaned `library_item_artist` rows** right now. They
pollute the artist filter dropdown with artists that own nothing.

Two parts:
1. Delete artists alongside items in `libraryRepo.delete()` and the scanner's removal pass
   (or add a real `ON DELETE CASCADE` and rebuild the table).
2. One-time cleanup of the 14 existing rows (see §5).

### 2.2 Scanner can mass-delete on a transient FS error — **M**
`walkPdfs` swallows per-directory errors and returns whatever it collected; phase 5 then deletes
every `library_item` whose path isn't in that list. A network share stuttering mid-scan silently
drops rows. Files survive, so a rescan re-adds them — but `addedAt`, `readProgress` and anything
not embedded in the PDF are lost.

Fix: abort the removal pass if the discovered count dropped more than ~20% versus the last
`library_scan_log`, and surface it instead of deleting. Cheap insurance on a 4,600-item library.

### 2.3 `scan_queue` never drains properly — **S**
Rows marked `failed` are skipped by every future scan (`populateQueue` uses `INSERT OR IGNORE`,
and the pending query only selects `pending`/`scanning`), so a file that errors once is never
retried. `library:reset` doesn't clear the table either. Currently **4,642 rows sitting in
`pending`** from an interrupted scan — harmless but stale relative to the filesystem.

Fix: clear `scan_queue` in `library:reset`, and re-queue `failed` rows at the start of a scan
(optionally after N attempts).

### 2.4 SQL built by string interpolation — **M**
`library.repo.ts` `findPaginated` interpolates search/filter values with only quote-doubling.
Not a security concern for a local app, but `%` and `_` in a search term act as wildcards and
the whole thing is fragile. Drizzle's parameter binding is already available.

---

## 3. Performance & memory

### 3.1 PDF viewer renders every page up front — **L**
`PdfViewer.tsx` rasterises all pages to full-resolution canvases before showing anything. A
200-page gallery is multiple GB of pixel buffers — the white-page crashes the recent commits
were fighting. Render on demand into a windowed list (`react-virtuoso` is already a dependency)
and keep ~5 canvases alive. **Highest-impact item in this section.**

### 3.2 Whole files base64'd across IPC — **M**
`file:read` reads an entire PDF and base64s it (≈33% inflation, plus a byte-by-byte decode loop
in the renderer). `library:getThumbnail` does the same per card — 100 IPC round trips per
library page.

Fix both with a custom protocol: `protocol.handle('doujin://')` serving `doujin://thumb/{id}`
and `doujin://file/{id}`, then use them directly in `<img src>` and as the pdf.js URL. Removes
the inflation, the copies, and most of the IPC chatter.

### 3.3 Scanner does far too much work per file — **M**
For metadata only, each file is (a) fully read into memory, (b) `toString('utf-8')`'d in full to
regex for XMP, and (c) fully parsed by pdf-lib. Reading the first and last ~256 KB would cut
scan time on a 4,600-item library by roughly an order of magnitude.

### 3.4 Six independent 2-second polls — **M**
StatusBar, Sidebar, DownloadsPage, SearchPage, GalleryDetail and FavoritesPage each poll every
2s; Search issues one IPC *per visible result* per tick. `DownloadsPage`'s `fetchDownloads` also
has `galleryInfoMap` in its deps, so its interval is torn down and rebuilt on every update.
The main process already knows when state changes — push events instead.

### 3.5 Unbounded gallery cache — **S**
`api.ipc.ts`'s `galleryCache` never evicts or invalidates, so favourite counts go stale and it
grows for the session. Cap it (LRU, few hundred entries) with a TTL.

---

## 4. Architecture

### 4.1 Python + pikepdf is a hard runtime dependency — **L**
Every metadata write shells out to `python3` with an inline script; scan thumbnails need
`pdftoppm`. Startup now probes and logs, but the dependency remains, and a Windows or macOS
build has no reason to have either.

Options, best first:
1. **Write the XMP from Node.** We already hand-build the XML string; pikepdf only supplies
   "put these bytes in `/Metadata`, save with `object_stream_mode=0`". `pdf-lib` can attach a raw
   stream to the catalog. Removes a runtime, a process spawn per file, and the whole portability
   problem. Validate byte-for-byte against the current pikepdf output before switching — the
   Kavita format is fussy and hard-won.
2. Surface the probe result in the UI (banner in Settings) rather than only the console.
3. Replace `pdftoppm` with `pdfjs-dist` in a worker for thumbnails (already a dependency).

### 4.2 Move to CBZ output — **L, but reconsiders a lot of the above**
Kavita handles CBZ better than PDF; metadata becomes `ComicInfo.xml` (the `.xsd` is already in
`oldScripts/`), which sidesteps §4.1 entirely, needs no image re-encode, and avoids pdf-lib's
memory profile. Worth prototyping alongside PDF rather than replacing it.

### 4.3 Use the official download endpoint — **M**
`POST /galleries/{id}/download?format=zip|cbz|torrent` returns a short-lived URL for the whole
gallery: one request instead of N page fetches, no CDN scraping, no per-page retry logic, at
10 per 5 min. Requires the `allow_downloads` feature flag on the account. Offer as the primary
path with the current CDN walker as fallback.

### 4.4 One gallery request instead of three — **S, do this early**
`GET /galleries/{id}` accepts `include=comments,related,favorite,suggestions`. The detail panel
currently makes three separate calls (gallery, related, `checkFavorite`) against a 20/min anon
limit. Collapsing them cuts detail-panel traffic ~3×. Cheapest real win on the list.

---

## 5. One-time data cleanup

Small maintenance IPC (or a `scripts/` one-shot) for the current DB:

- **14** orphaned `library_item_artist` rows → delete.
- **3,655** stale `download_page` rows (only cleaned going forward) → delete where the parent
  queue row is `completed`/absent.
- **4,642** stale `scan_queue` rows → clear.
- **68** `completed` `download_queue` rows → prune on a retention policy.
- `/tmp/doujin-downloader-thumbs` (92 MB) is superseded by `userData/thumbnails` → safe to `rm -rf`.
- The **3** items with a series but no volume predate fix #5 — re-apply metadata so their
  `calibre:series` lands in the file (Settings → Convert Library Metadata covers it).

---

## 6. Hygiene

### 6.1 Rotate the committed API key — **S, do first**
`config.json` contains a live `nhk_…` key and is tracked, with `origin` pointing at a GitHub
repo. Rotate it, `git rm --cached config.json`, add it to `.gitignore`, and scrub history if
that repo is or becomes public. The old Python scripts are tracked too and read the same file.

### 6.2 Tests — **M**
No tests, no CI. The four suites I wrote for this work were throwaway (they live in the session
scratchpad and bundle via esbuild). Worth promoting into the repo — they already caught two real
bugs (the `rdf:Alt` description and the entity decoding), and the language fix was only
confidently verified because calibre could read our output back. Highest value:

- `buildXmpXml` / `buildKeywordTokens` — pure, format-critical, historically fragile.
- `extractPdfMetadata` round-trip (write → read → compare), ideally asserting against
  `ebook-meta` where available.
- `RateLimiter` / `ApiRateLimiter` — limits, auth switching, no bursts over cap.
- The filename sanitizer.

Vitest fits the existing Vite setup with near-zero config.

### 6.3 Lint — **S**
1,308 problems (103 errors, 1,205 warnings); ~1,197 are auto-fixable formatting. Run
`prettier --write .`, then fix the ~100 real errors so lint output becomes signal. Currently it's
noise, which is why the genuine `react-hooks/immutability` warning on the badge mutation (fix #7)
went unnoticed.

### 6.4 Dead code — **S**
- `metadata-writer.ts` — everything except the `GalleryMetadata` type is superseded by pikepdf.
- `favorite` table — never read or written.
- `api-client.ts` `getImageUrl` / `getThumbnailUrl` / `getCoverUrl` — the renderer builds URLs
  itself with a hardcoded `t.nhentai.net`. Either use them or drop them; the hardcoded host
  should come from `/cdn` regardless.
- `readProgress` column — stored, never read (see §7).

### 6.5 README — **S**
Still the unmodified electron-vite scaffold. Should state the actual purpose, the library layout
convention (`{root}/{artist}/{series?}/{title} [nhentai-{id}].pdf`), the Kavita metadata
contract, and the Python/pikepdf + poppler prerequisites.

---

## 7. Features worth adding

Roughly descending value for this app's purpose:

- **Library health page** — missing files, unmatched items, duplicate gallery IDs, artists with
  no items, failed scan rows, orphaned rows. All queries you can already write; makes §2 and §5
  self-service instead of manual SQL.
- **Reading progress** — the column exists; wire `PdfViewer`'s `visiblePage` to it and add a
  "continue reading" row.
- **Favourites sync into the local DB** — the `favorite` table is already there. Gives offline
  favourites and a "favourited but not archived" backlog view, which is a natural queue for an
  archival tool.
- **`POST /tags/search`** for real tag autocomplete in the search bar (30/min, public).
  Autocomplete currently only knows tags already in your library.
- **Blacklist support** (`GET /blacklist/ids`) — the `blacklisted` flag already comes back on
  every search result and is ignored.
- **Auto-scan / watch mode** — `fs.watch` on the library root plus scan-on-startup would remove
  most manual rescans. `background-worker-scanner-plan.md` already sketches this.
- **Log viewer in Settings** — the scanner and converter write detailed logs to
  `userData/logs/` and nothing in the UI can open them.
- **Discovery**: `/galleries/random`, `/favorites/random`, `/galleries/tagged`.

---

## 8. Suggested order

**Batch 1 — cheap, high value (about half a day)**
§6.1 rotate the key · §4.4 `include=` · §1.1 phantom failures · §1.2 concurrency ·
§1.3 dedupe · §1.4 stale volume · §1.5 worker leak · §2.3 scan queue · §6.3 lint autofix

**Batch 2 — data safety**
§2.1 orphaned rows · §2.2 mass-delete guard · §5 one-time cleanup (ideally behind §7's health
page) · §6.2 promote the test suites first, so batches 3–4 have a safety net

**Batch 3 — the performance work users feel**
§3.1 lazy PDF rendering · §3.2 custom protocol · §3.3 scanner speed · §3.4 push events

**Batch 4 — structural, decide before building**
§4.2 CBZ vs PDF is the pivotal call: choosing CBZ makes §4.1 mostly moot and changes what §4.3
is worth. Settle that before investing further in the PDF metadata path.

Batches 1 and 2 are independent and safe to land incrementally. Batch 3 is where the remaining
user-visible pain is. Batch 4 deserves a decision first, not code.
