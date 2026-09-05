# 1.x Current Architecture

Inventory of the shipping Electron application (Kopibon 1.0.2, Electron 39 + React 19 +
TypeScript, 164 files under `src/`), written for an implementing agent who will rebuild it
in Rust and has not read the TypeScript source. Every non-obvious claim carries a
`path:line` citation against the working tree. Companion documents:
`02-ipc-surface.md` (all channels), `03-data-model.md` (schema and queues),
`07-metadata-spec.md` (metadata bytes).

---

## 1. Process model

### 1.1 The three Electron layers

- **Main process** — everything under `src/main/`: SQLite (better-sqlite3), all seven
  subsystem managers, IPC handlers, the logger. Single-threaded; any handler that blocks
  stalls every other IPC call, which is why the `handle()` wrapper warns above 250 ms
  (src/main/ipc/handle.ts:42-49, :67-70) and the window records freezes with the in-flight
  channel list as evidence (src/main/index.ts:44-75).
- **Preload** — `src/preload/index.ts`. The window is created with `sandbox: false`,
  `contextIsolation: true`, `nodeIntegration: false` (src/main/index.ts:32-37); the preload
  script bridges via `contextBridge.exposeInMainWorld`, exposing two objects —
  `window.electron` (the `@electron-toolkit/preload` default) and `window.api` (the typed
  144-channel surface, 16 namespaces: 131 `ipcRenderer.invoke` call sites over 130 unique
  request/response channels plus 14 event subscriptions) (src/preload/index.ts:532-533;
  channel-by-channel inventory in `02-ipc-surface.md`).
- **Renderer** — `src/renderer/`: React 19 + zustand + react-router (HashRouter). It never
  touches Node; every capability arrives through `window.api`. Main → renderer push is
  14 event channels (see the events table in `02-ipc-surface.md`).

All request/response IPC returns the envelope `{success, data?, error?, errorId?}` built by
`handle()` (src/main/ipc/handle.ts:51-81), which mints a fresh `errorId` per failure and
tracks in-flight channels for the freeze watchdog (src/main/ipc/handle.ts:31-38).

### 1.2 The seven worker-thread kinds

All are Node `worker_threads`, spawned from build output as
`<__dirname>/services/<name>.worker.js`; the build declares exactly these eight main-process
rollup inputs (index + seven workers) (electron.vite.config.ts:7-16). Every spawn site
immediately calls `attachWorkerLogForwarding(worker, log)`, which registers a second
`message` listener that forwards `{type:'log', record}` envelopes into the main logger —
the record is re-validated, level-filtered and secret-scrubbed main-side because workers
cannot do it themselves (src/main/services/worker-logger.ts:85-101; message shape
src/main/services/worker-logger.ts:23-26; rationale src/main/services/worker-logger.ts:1-11).
Workers cannot import the main logger (it depends on Electron's `app`), so this forwarding
is the only path into `app.log` (src/main/services/worker-logger.ts:1-11).

| Worker | Spawn site | Purpose | Protocol (in → out) | Concurrency | Own SQLite? |
|---|---|---|---|---|---|
| `library-scanner` | src/main/ipc/library.ipc.ts:1001-1005 | Directory walk, metadata extraction (PDF XMP by regex, ComicInfo via yauzl), thumbnails, row insert/removal | in `{type:'start', libraryRoot, thumbnailDir?} \| pause \| resume \| cancel` (src/main/services/library-scanner.worker.ts:27-30); out `progress \| newItem \| newItems \| complete \| error \| paused \| cancelled` (:33-50) | Singleton — a second scan is refused (src/main/ipc/library.ipc.ts:990-993) | Yes — opens its own connection on `start` (src/main/services/library-scanner.worker.ts:1069-1071) via `openWorkerConnection()` (src/main/db/connection.ts:500-507), WAL + `busy_timeout=5000` |
| `download-pdf` | src/main/services/download-manager.ts:576-578 | pdf-lib PDF generation → pikepdf XMP inject → sharp thumbnail | in `{type:'generate', imagePaths, outputPath, options, metadata?, firstImagePath?, thumbnailDir?, galleryId?}` (src/main/services/download-pdf.worker.ts:24-33); out `progress \| complete \| error` | One per active download, up to `maxConcurrent` (clamped 1–8, default 3; src/main/services/download-manager.ts:144-152) | No |
| `download-cbz` | src/main/services/download-manager.ts:576-578 | yazl CBZ with ComicInfo.xml at root + sharp thumbnail; explicitly no pikepdf step (src/main/services/download-cbz.worker.ts:87) | in `{type:'generate', …, mangaDirection?}` (src/main/services/download-cbz.worker.ts:27-41); out same as pdf | same | No |
| `metadata` | src/main/ipc/library.ipc.ts:110-121 | One PDF metadata rewrite via pikepdf | in `{type:'apply', pdfPath, metadata}` (src/main/services/metadata.worker.ts:19-24); out `complete \| error` | One-shot; it parks on a `parentPort` listener and never exits, so the spawner terminates it after the first terminal message (src/main/ipc/library.ipc.ts:119-134) | No |
| `convert` | src/main/ipc/library.ipc.ts:2077-2079 | "Convert Library Metadata": re-applies metadata via `applyMetadata()`, then moves a `[nhentai-N]` filename prefix to the end (src/main/services/convert.worker.ts:66-103; prefix regex :69) | in `{type:'convert', item:{id, filePath, format?, metadata}}` (src/main/services/convert.worker.ts:13, :24-33); out `{type:'done', itemId, success, newPath?, error?, log?}` | Pool clamped 1–20 (src/main/ipc/library.ipc.ts:2025) | No |
| `convert-cbz` | src/main/ipc/library.ipc.ts:3083-3085 | PDF → CBZ for one item: extract images, build CBZ, archive the source under `_originals/`. Eight ordered steps, explicitly marked do-not-reorder (src/main/services/convert-cbz.worker.ts:3-9) | in `{type:'convert', item:{id, filePath, metadata{…}, options{keepOriginal, libraryRoot, originalsRoot, userDataDir, mangaDirection}}}` (src/main/services/convert-cbz.worker.ts:26-59); out `{type:'done', …}` | Pool of `min(downloadConcurrency, 8)` (src/main/ipc/library.ipc.ts:2947-2952) | No (main claims queue rows for it, src/main/ipc/library.ipc.ts:3106) |
| `sync` | src/main/ipc/library.ipc.ts:2259-2261 | Re-fetch one gallery from nhentai and rewrite the file's metadata; posts the whole API response back so the cached `gallery` row refreshes (src/main/ipc/library.ipc.ts:2400-2440) | in `{type:'sync', itemId, nhentaiId, filePath, apiKey?, format?, seriesName?, seriesIndex?}` (src/main/services/sync.worker.ts:20-37); out `complete \| error` | Strictly serial — the batch loop awaits each worker before claiming the next (src/main/ipc/library.ipc.ts:2596-2617); its own 3-attempt retry honouring `Retry-After` (src/main/services/sync.worker.ts:39-79) | No |

Because download and metadata workers never exit on their own, every spawner implements a
"settle once, then terminate" guard: only `complete`/`error`/`done` messages settle the
promise — terminating on `progress` would kill a build mid-write, a bug this code has had
before (src/main/services/download-manager.ts:581-600; src/main/ipc/library.ipc.ts:119-134,
:2442-2465). Concurrent mutation of library rows is guarded by sets, not the DB:
`cbzConverting`/`cbzQueued` back `isConversionLocked()`, which the edit/delete/sync handlers
consult and refuse with a shared error (src/main/ipc/library.ipc.ts:183-192).

> **Port implications**
> - Workers exist to move CPU-bound work (image decode/encode, PDF build, ZIP build) off
>   the single-threaded main process. In Rust, decide explicitly between threads and a
>   shared async runtime; the message protocols above are the contract to preserve.
> - The worker-logger forwarding, the settle-once-then-terminate dance, and the env-var
>   inheritance of data-dir/template paths (§2, §7) all exist because workers are separate
>   isolates — all three collapse into ordinary function calls in one process. Preserve
>   "sync is serial" and "scan is a singleton" either way.
> - The read-then-write download claim (§3a) is safe only under a single in-process
>   scheduler; if the port parallelises claiming, it must adopt the atomic
>   `UPDATE … RETURNING` pattern the conversion/sync queues already use.

---

## 2. Startup sequence

`app.whenReady()` in src/main/index.ts:89-408, in order:

1. `electronApp.setAppUserModelId('com.en7ity.kopibon')` (src/main/index.ts:90).
2. **Data directory** — `process.env.KOPIBON_DATA_DIR = app.getPath('userData')`
   (src/main/index.ts:101), *before* `initDatabase()` and before any worker can be spawned:
   workers cannot import Electron's `app`, and without the env var each would fall back to
   a homedir path that diverges on Windows, giving every worker its own empty database
   (src/main/index.ts:92-99; fallback chain src/main/db/connection.ts:11-49; DB path
   `$KOPIBON_DATA_DIR/db.sqlite`, src/main/db/connection.ts:22-49).
3. **Logger** — file sink at `<userData>/logs/app.log` (src/main/index.ts:105-106).
4. **Metadata templates seeded** — `installUserTemplates(userData)` copies the shipped
   templates into `<userData>/metadata-templates/` (never overwriting an existing file) and
   sets `process.env.DOUJIN_TEMPLATE_DIR` to the copy
   (src/main/services/metadata/templates.ts:142-162), called at src/main/index.ts:123-128 —
   *before any worker spawn*, so workers inherit the env var and write with the same
   templates the user can edit.
5. **Crash handlers** — `uncaughtException`, `unhandledRejection`, `render-process-gone`,
   `child-process-gone` all logged (src/main/index.ts:132-164).
6. **`initDatabase()`** (src/main/index.ts:173-174): better-sqlite3 with
   `encoding=UTF-8`, `journal_mode=WAL`, `foreign_keys=ON`, then the hand-written
   idempotent `runMigrations()` (the real DDL — there is no Drizzle migration journal) and
   `seedDefaults()` (src/main/db/connection.ts:69-86, :146). Seeding writes nine settings
   once, when `app_settings` is empty: `libraryPath=''`, `downloadConcurrency=3`,
   `outputFormat=cbz`, `compressPdf=true`, `compressionQuality=80`, `pageSize=Dynamic`,
   `blackBackground=true`, `cbzMangaDirection=YesAndRightToLeft`, `cbzKeepOriginal=true`
   (src/main/db/connection.ts:119-144).
7. **IPC registration** — eight modules, then `restoreAuthFromDb()` loads the stored
   nhentai API key (src/main/index.ts:177-186).
8. **Startup-maintenance sweep** — `runStartupMaintenance()` (src/main/index.ts:189-203;
   src/main/services/startup-maintenance.ts:52-164), one transaction that:
   - wipes `download_page` entirely — per-attempt bookkeeping, nothing reads it across a
     restart (src/main/services/startup-maintenance.ts:9-13, :66);
   - wipes `scan_queue` entirely — intra-scan progress only; the incremental skip keys off
     `library_item` (mtime+size), and clearing also un-sticks `failed` rows the work query
     would otherwise skip forever (src/main/services/startup-maintenance.ts:14-18, :68);
   - resets `conversion_queue` rows `'converting' → 'pending'` — the table is deliberately
     *not* wiped because resumability is the point of having it; `completed`/`failed` stay
     as history (src/main/services/startup-maintenance.ts:70-76);
   - prunes `download_queue` rows with status `'completed'` (optional retention days; 0 =
     all) — queued/paused/failed are user intent and failure history and are kept
     (src/main/services/startup-maintenance.ts:20-24, :78-91);
   - deletes orphaned `library_item_artist` rows — no table declares a foreign key, so
     historical deletes leaked rows this sweep removes (src/main/services/startup-maintenance.ts:93-101).
   Outside the transaction, best-effort: `syncRepo.requeueInterrupted()` puts rows left
   `'syncing'` by a crash back to `'pending'` for the resume banner
   (src/main/services/startup-maintenance.ts:127-135), and if `seriesGrouping === 'true'`
   a whole-table series backfill heals stale grouping
   (src/main/services/startup-maintenance.ts:137-143).
9. **Download recovery + resume** — `dm.applyConcurrencyFromSettings()`,
   `reconcileInterrupted()` (every `downloading`/`converting` row → `queued`, page rows
   deleted, scratch purged), then `processQueue()` (src/main/index.ts:206-212;
   src/main/services/download-manager.ts:271-290).
10. **Toolchain probe** — `checkToolchain()` spawns the external binaries; failures log an
    error with an install hint but never block startup (src/main/index.ts:215-233;
    src/main/services/toolchain.ts:105-157).
11. `app:checkToolchain`, `log:*` handlers, updater registration
    (src/main/index.ts:237-261). `registerUpdaterIpc()` applies the release channel to
    `autoUpdater.allowPrerelease` and fires a startup check whose rejection is swallowed —
    in dev the feed comes from `dev-app-update.yml`, and without that file the updater
    throws on every launch (src/main/ipc/updater.ipc.ts:53-67; dev-app-update.yml:1-5).
12. **Window creation** — `createWindow()` last (src/main/index.ts:403): 1200×800,
    `show:false` until `ready-to-show`, webPreferences as in §1.1 (src/main/index.ts:22-42).
    On `window-all-closed`: `closeDatabase()`, then quit (non-macOS)
    (src/main/index.ts:410-415).

> **Port implications**
> - The order matters: data-dir → templates → DB → IPC → maintenance → download recovery →
>   window. In Rust there are no worker processes to inherit env vars, but the "resolve
>   data dir once, before anything touches the DB" rule must survive.
> - The maintenance sweep encodes which state is *transient* (wiped) versus *durable*
>   (preserved or requeued). Reproduce this classification exactly; it is the crash-recovery
>   story in miniature (§3, §7 of `03-data-model.md`).
> - The toolchain probe is startup-diagnostic only — absence degrades features (§5), it
>   never aborts the boot.

---

## 3. End-to-end data flows

### (a) A download, `addToQueue` → finished file in the library

```
renderer            main: DownloadManager (src/main/services/download-manager.ts)
   | download:addToQueue --> insert download_queue row, kick processQueue()
   |                        (src/main/ipc/download.ipc.ts:39-70)
   | processQueue() fills to maxConcurrent (:179-208): dequeueNext = read
   |   all 'queued', in-memory sort priority DESC, queuedAt ASC, then
   |   UPDATE -> 'downloading' (:210-224; read-then-write claim, no RETURNING)
   | downloadItem() per item (:332-765):
   |   1. gallery cache: parse rawJson, treat scanner stubs as a miss
   |      (:40-65); else GET /galleries/{id} + upsert the gallery row
   |   1.5 insert placeholder library_item: is_custom=2, file_path='' (:396-416)
   |   2. CDN config -> orderServers(): demoted hosts sink to the end (:257-262)
   |   3. insert N download_page rows 'pending'
   |   4. fresh scratch dir <userData>/download-tmp/<galleryId> (:99-102)
   |   5. pages in batches of 3 (:449-450) --> fetch each page image
   |        https://{host}/galleries/{mediaId}/{n}.{ext}, 30 s timeout;
   |        up to 3 attempts, rotate server per attempt; 404 -> next
   |        server (:800-804); non-404 failure -> failureCount++; >= 3
   |        consecutive -> demote host (:127-134, :846-853); a success
   |        clears demotion (:831-837); exponential backoff (:863)
   |   download:progress emitted after every batch (speed/eta)
   | any failure -> failDownload(): row 'failed', placeholder deleted
   |   (:299-309), scratch purged (:314-327)
   | pause/resume/cancel: in-memory flags on ActiveDownload; DB status
   |   mirrors them (:872-935)
   | status -> 'converting' (:538-541); output path
   |   {libraryRoot}/{artist}/'{title} [nhentai-{id}].{pdf|cbz}', title
   |   sanitised to 180 chars (:547-553)
   | spawn download-pdf or download-cbz worker (:575-650), options from
   |   settings (page size, quality, black bg / mangaDirection) (:633-648);
   |   worker does pdf-lib+pikepdf+sharp or yazl+ComicInfo.xml+sharp
   | 'complete' -> worker terminated; row 'completed' (:653-656)
   | library_item: is_custom 2 -> 0, real file_path (relativised), size,
   |   page count counted from the file (:659-735); a re-download deletes
   |   the superseded file only after the new one exists (:678-695);
   |   artist rows inserted; thumbnailPath from worker result stored as
   |   bare filename (:729-734); download_page rows deleted (:739)
   | OS notification, gated on showNotifications (:744-746)
   | Kavita scan hook is DISABLED — scan-folder misses brand-new files;
   |   Kavita's own watch folder handles discovery (:748-755)
   | finally: scratch dir purged (:763)
```

The CDN rotation/demotion lives in the *main* process and is the only smart one — the
renderer re-implements rotation twice with no demotion notion (see `discovery-03` §A8).
Scratch is wiped at the start of each attempt (:433-439), on failure, on
`reconcileInterrupted()` (:282) and in `finally` (:763).

> **Port implications**
> - Preserve the placeholder-row lifecycle (`is_custom=2` → 0, deleted on failure) — the
>   renderer's status resolution and the search page read it as "downloading".
> - Demotion is per-hostname, threshold 3 consecutive non-404 failures, demoted hosts are
>   reordered to the end (never dropped), one success re-promotes. This is a stateful
>   scheduler concern, not a per-request retry loop.
> - The download claim is read-then-write; if the port keeps a single scheduler this is
>   fine, but document it as an invariant.
> - The Kavita hook is deliberately absent — do not "restore" a per-download scan.

### (b) A library scan

```
renderer      main (src/main/ipc/library.ipc.ts)       library-scanner.worker
   | library:scan --> singleton guard (:990-993); spawn worker, attach
   |                 logger (:1001-1005); start msg {libraryRoot,
   |                 thumbnailDir} (:1080-1083)
   |                                                | own SQLite connection (:1069-1071)
   |                                                | walk library dir, skipping
   |                                                | _Unsorted, _migration_staging,
   |                                                | _originals (:606-607)
   |                                                | populateQueue: INSERT OR IGNORE
   |                                                | relative paths (:640-648)
   |                                                | requeueIncompleteItems:
   |                                                | 'scanning'+'failed'->'pending' (:651-665)
   |                                                | work query: pending OR scanning,
   |                                                | priority DESC, id ASC (:894-896)
   |                                                | per item: claim UPDATE->'scanning'
   |                                                | (:940); shouldSkipFile: stat
   |                                                | mtime+size vs library_item on the
   |                                                | relative path -> skip (:668-689)
   |                                                | thumbnails: only when the row has
   |                                                | none (:819-821); 600x800 JPEG q80,
   |                                                | sha1(path)[0:16].jpg (:479-480)
   |                                                | pause/cancel checked per item;
   |                                                | pause parks on a promise (:920-940)
   | library:newItems <----- 'newItems' msg forwarded (:1030);
   |                        batched: flush at 25 items or 500 ms (:907-917)
   | library:scanProgress <- (:1034); progress every N items
   | library:scanComplete <- 'complete' -> regroupAllSeries(), then emit
   |   (with removal-        (:1044-1054). REMOVAL PASS, triple-guarded:
   |    SkippedReason)         (1) any unreadable directory skips removal
   |                                entirely (:980-989)
   |                            (2) discovered count < 80% of last scan's
   |                                total (>=50 items) skips (:993-1001)
   |                            (3) rows whose stored path no longer
   |                                resolves, >20% of all rows -> skip (:1022-1028)
   |                          else delete gone rows + their artist rows in
   |                          one txn (:1030-1042); write library_scan_log
   |                          (:1047-1049)
   | library:scanPaused / scanCancelled / scanError <- (:1057, :1061)
```

The three removal guards exist because the pass compares DB rows against a filesystem walk:
a vanished network mount or an unreadable directory must never become a mass deletion. The
reason is reported back to the renderer in `removalSkippedReason`
(src/main/services/library-scanner.worker.ts:45, :1052-1057). Real incremental behaviour
comes from the mtime+size skip, not from `scan_queue` (which is wiped every boot — §2).

> **Port implications**
> - Port all three removal guards as written; the discovery corpus calls the mass-delete
>   test the highest-consequence non-metadata test (plan §5).
> - The scan_queue table is disposable scaffolding; the mtime+size check against
>   `library_item` is the real incrementality. A Rust port could keep exactly that shape.
> - newItems batching (25 items / 500 ms) exists to bound IPC churn during a 10k-file scan;
>   preserve the batching semantics even if the transport changes.

### (c) Sync-from-nhentai batch

```
renderer       main (src/main/ipc/library.ipc.ts:2528-2697)     sync.worker (serial)
   | library:syncBatch(ids) -> ids empty  = resume: whatever is queued
   |                          ids non-empty = clearFinished() + enqueue(ids)
   |                          (:2553-2554); total = pending + syncing
   |                          (:2556-2561)
   | pacing: limit = endpointLimitPerMinute('gallery', hasKey);
   |   target = 90% of it; intervalMs = ceil(60000/target) (:2565-2581)
   | library:syncProgress <- initial (:2583-2590)
   | loop: claim ONE row at a time (UPDATE..RETURNING; a crash strands
   |   exactly one) (:2596-2598) --> GET /api/v2/galleries/{id}:
   |     3 attempts; 429 honours Retry-After + jitter (:41-79)
   |     fileMetadataFromGallery -> applyMetadata (rewrites the archive
   |     IN PLACE) (:128-146); posts complete + the whole gallery JSON
   |   syncRepo.finish; main refreshes the gallery row from the
   |     response (:2400-2440)
   |   sleep only the REMAINDER of the interval — the fetch and rewrite
   |     already consumed part of it (:2657-2661)
   | library:syncProgress per-item + eta (:2640-2661)
   | library:syncComplete summary (:2663-2672) + OS notification
   |   (:2674-2688)
```

Cancellation sets `syncCancelled` (src/main/ipc/library.ipc.ts:2522-2527) and stops the
loop *after* the item in flight — the worker is never terminated mid-write because a sync
rewrites the archive in place and killing it corrupts the file
(src/main/ipc/library.ipc.ts:2236-2244). Pacing is derived from the rate limiter's
documented per-endpoint ceiling (src/main/services/rate-limiter.ts:181), not a constant:
the previous flat 3 s sleep matched the *anonymous* limit and made an API key worthless.

> **Port implications**
> - Serial, one claim at a time, cancel-between-items: these three properties are what
>   make in-place archive rewrites survivable. Preserve them even if the transport is
>   re-architected.
> - Keep pacing derived from `endpointLimitPerMinute` so a future key tier or endpoint
>   change re-paces automatically.

### (d) PDF → CBZ conversion

```
renderer     main (src/main/ipc/library.ipc.ts:2929-3388)    convert-cbz.worker(s)
   | library:convertToCbz(ids, dryRun, {keepOriginal, resume})
   |   concurrency = min(downloadConcurrency, 8) runners (:2947-2952)
   |   keepOriginal: option > cbzKeepOriginal setting (:2956-2961)
   |   dryRun: return the selected items only (:2974-2999)
   |   fresh batch: clearFinished() + enqueue one row per PDF with
   |     keep_original FROZEN per row (:3025-3034); resume:true skips
   |     enqueue entirely (:3011, :3017-3034)
   | cbzQueued set filled from pendingItemIds() (:3051)
   | library:convertToCbzProgress <- progress with activeIds+queuedIds
   |   (:3061-3075)
   | N runners, each:
   |   claimNext() = UPDATE..RETURNING — atomic, one row per runner
   |     (:3106; src/main/db/repositories/conversion.repo.ts:69-88)
   |   markFailed/release on refusal; spawn convert-cbz worker
   |     (:3083-3085) --> 8 ordered steps:
   |       pdfinfo page count -> pdfimages -all (lossless) else
   |       pdftoppm -jpeg -r 150 (lossy) fallback
   |       (src/main/services/pdf-extract.ts:5-12, :139-160)
   |       build CBZ (ComicInfo first, STOREd entries); verify archive
   |       (:102-176); archive source PDF under _originals/{artist}/,
   |       or _originals/_lossy/{artist}/ when the conversion was lossy
   |       — forced keep (:267-283; safePathSegment :74-79)
   |   markCompleted/markFailed; cbzConverting/cbzQueued sets updated
   |     (:3121-3131, :3259-3306)
```

Crash semantics: startup resets only `'converting' → 'pending'` (§2); the table is never
wiped. `keep_original` is stored **per row** so a resumed batch honours the choice made in
the dialog rather than the setting at resume time (src/main/db/connection.ts:375-380;
DDL src/main/db/connection.ts:260-269). Lossy conversions (pdftoppm fallback) are forced
keeps and archived under `_lossy/` so a later "delete originals" sweep can spare them
(src/main/services/convert-cbz.worker.ts:267-283).

> **Port implications**
> - The `UPDATE … RETURNING` claim is the reference pattern for any Rust work queue over
>   SQLite; the conversion and sync queues both use it, the download queue does not (§3a).
> - `keep_original` per row and the `_lossy/` forced-keep distinction are user-facing
>   contracts of the originals archive; preserve both.
> - The worker's 8 steps are order-sensitive by explicit comment
>   (src/main/services/convert-cbz.worker.ts:3-9) — e.g. the count guard must run before
>   deciding lossy vs lossless, which decides the archive path.

### (e) `convertAllMetadata` — the one long job with no crash resume

`library:convertAllMetadata` (src/main/ipc/library.ipc.ts:2010-2224) loads
`libraryRepo.findAll()` into an in-memory array and hands items to a 1–20 runner pool of
`convert` workers by `queueIndex++` (src/main/ipc/library.ipc.ts:2018, :2025, :2100).
Cancellation is a module-level boolean `conversionCancelled` checked by each runner
(src/main/ipc/library.ipc.ts:2008, :2226-2229). It writes its own timestamped log to
`<userData>/logs/convert-<ts>.log` (src/main/ipc/library.ipc.ts:2028-2050) and streams
progress via `library:convertProgress`. Because the work list is a local variable, a crash
or quit loses the entire run — unlike `convertToCbz` and `syncBatch`, which were both
retrofitted with DB queues for exactly this reason (see `discovery-02` §6).

> **Port implications**
> - Either give the port's equivalent a DB-backed queue like (d)/(c), or consciously keep
>   the fire-and-forget behaviour and document it; do not silently inherit the gap.
> - The 1–20 runner clamp and the per-run log file are the only two operational affordances
>   this job has; both are cheap to keep.

---

## 4. The metadata subsystem in miniature

Pipeline: **template engine → context (mappers) → artefact writer**, shared by all twelve
write paths. Full field-level spec lands in `07-metadata-spec.md`; this is the shape.

**Template engine** (src/main/services/metadata/template-engine.ts, 162 lines): four
regexes define the grammar — placeholders `{{ name }}` with optional `?`, line-anchored
block sections, and an inline section form expanded *before* substitution (src/main/services/metadata/template-engine.ts:36-46).
Emptiness rule: `null`/`undefined`/`false`/`''`/`[]` are empty; **`0` and `'0'` are
present**; `true` renders as `"true"` (src/main/services/metadata/template-engine.ts:50-59).
A line containing any empty `{{x?}}` is dropped whole, leaving no blank line
(src/main/services/metadata/template-engine.ts:135-145). `{{#each}}` over a non-array
yields zero iterations (src/main/services/metadata/template-engine.ts:122-126); arrays join
with `", "`. No escaping — the mapper owns XML escaping (header
src/main/services/metadata/template-engine.ts:24-27). CRLF→LF, then exactly one trailing
`\n` stripped (src/main/services/metadata/template-engine.ts:158-161). Unclosed/mismatched
sections throw with 1-based line numbers (src/main/services/metadata/template-engine.ts:79-96).

**Mappers** (src/main/services/metadata/mappers.ts) build three contexts from one
`FileMetadata` (adapted from a gallery API response, a library row, or a download payload —
src/main/services/metadata/file-metadata.ts:270-308, :317-357, :365-383):

- `commonContext` — titles, `writers` (artists → groups → `['Unknown']`,
  src/main/services/metadata/mappers.ts:69-73), `genres` = categories then parodies
  (src/main/services/metadata/mappers.ts:153-160), human-readable `language`
  (priority-ordered English/Japanese/Chinese resolution — src/main/services/xml-utils.ts:141-184),
  `galleryId = meta.galleryId || ''` — **id 0 becomes empty**
  (src/main/services/metadata/mappers.ts:136-138).
- `comicInfoContext` — adds `series` (always written), `number`/`storyArcNumber` (null
  unless in a series *and* index > 0, src/main/services/metadata/mappers.ts:56-60),
  `seriesGroup` = first parody (src/main/services/metadata/mappers.ts:102-104),
  `localizedSeries` = Japanese title for one-shots only
  (src/main/services/metadata/mappers.ts:116-119), all-or-nothing Year/Month/Day with
  2-digit padding (src/main/services/metadata/mappers.ts:208-210).
- `xmpContext` — overrides `tags` to **allTags** (`dc:subject` carries every tag while
  ComicInfo `Tags` is tag-type only, src/main/services/metadata/mappers.ts:161 vs :242-243);
  `dc:date` falls back to *now* when undated (src/main/services/metadata/mappers.ts:235-236);
  `metadataDate` = `toISOString()` with `.mmmZ` → `.000000+00:00`
  (src/main/services/metadata/mappers.ts:245-246); `seriesIndex.toFixed(2)`
  (src/main/services/metadata/mappers.ts:247).

**The four artefacts:**

1. **ComicInfo.xml** — `renderTemplate(comicinfo.template, comicInfoContext)`, written as
   the first STOREd entry of every CBZ (src/main/services/cbz-generator.ts:110).
2. **PDF XMP** — `pdf-xmp.template` through `xmpContext` (BOM U+FEFF preserved,
   src/main/services/metadata/mappers.ts:27, :240), injected by the embedded Python script:
   pikepdf deletes any existing `/Metadata`, attaches a new indirect `/Type /Metadata`
   `/Subtype /XML` stream, saves to `output_path + '.tmp'` (bypassing the 255-byte guard
   every JS writer uses) then `os.replace`s into place (src/main/services/xmp-inject.ts:20-54,
   :49). Interpreter resolution `$DOUJIN_PYTHON` → `python3`/`python`/`py`
   (src/main/services/xmp-inject.ts:60-64); a zero-exit with non-JSON stdout is *assumed*
   success (src/main/services/xmp-inject.ts:118).
3. **PDF Info dict + `/Keywords`** — the same Python call sets docinfo `/Title`, `/Author`,
   `/Keywords`, `/Producer` (hardcoded `'pikepdf 10.8.0'`) and `/Trapped` to the string
   `'/False'` (src/main/services/xmp-inject.ts:32-36). `/Keywords` tokens are built in code,
   not templated: all tags, `nhentai:{id}` (guarded `!= null`, so **id 0 emits `nhentai:0`**
   — inconsistent with the context's `|| ''` and preserved deliberately),
   `calibre_series:{name}`, `series_index:{n}` (ungated by series membership, raw not
   `toFixed(2)`), `language:{Human}`, `publisher:{name}`, joined `", "`
   (src/main/services/metadata/mappers.ts:267-281, :272, :274).
4. **ZIP container** — yazl, `ComicInfo.xml` first, every entry `{compress:false}` (STORE),
   pages named `%04d.{ext}`, built into a `.part` sibling then renamed
   (src/main/services/cbz-generator.ts:57-59, :110-120, :132-151). Rewrite-in-place reuses
   the same rules and serialises each entry copy on its stream's `end`
   (src/main/services/apply-metadata.ts:114-192).

**Dispatch**: `applyMetadata()` routes `cbz` → `rewriteComicInfoInCbz`, everything else →
`applyXmpWithPikepdf` (src/main/services/apply-metadata.ts:204-220).

**The 12 write paths** (from `discovery-01` §7, verified):

| # | Path | Entry point | Citation |
|---|---|---|---|
| 1 | Download → PDF | download-pdf worker; pikepdf failure is warn-only, non-fatal | src/main/services/download-pdf.worker.ts:48-81 |
| 2 | Download → CBZ | download-cbz worker → `generateCbz` → `buildComicInfoXml` | src/main/services/download-cbz.worker.ts:43-86 |
| 3 | Custom entry → CBZ | `library:addCustom` CBZ branch | src/main/ipc/library.ipc.ts:1332-1354 |
| 4 | Custom entry → PDF | `library:addCustom` PDF branch → `spawnMetadataWorker` | src/main/ipc/library.ipc.ts:1479-1500 |
| 5 | Edit metadata | `library:updateMetadata` → `applyMetadata` | src/main/ipc/library.ipc.ts:1815-1882 |
| 6 | Rename series | `library:renameSeries`, per member | src/main/ipc/library.ipc.ts:726-733 |
| 7 | Assign series/volume | `library:assignSeries` | src/main/ipc/library.ipc.ts:1178-1191 |
| 8 | Sync from nhentai | sync worker → `applyMetadata` | src/main/services/sync.worker.ts:128-146 |
| 9 | Convert All Metadata | `library:convertAllMetadata` → N `convert` workers | src/main/ipc/library.ipc.ts:2069-2110 |
| 10 | Convert PDF → CBZ | convert-cbz worker → `generateCbz` | src/main/services/convert-cbz.worker.ts:88-100 |
| 11 | Attach/detach nhentai id | `library:setGalleryId` — **filename only, no in-file write** | src/main/services/gallery-filename.ts:42-54 |
| 12 | CLI ComicInfo rewrite | `tools/rewrite-comicinfo.mjs` | tools/rewrite-comicinfo.mjs:109 |

Template resolution: `$DOUJIN_TEMPLATE_DIR` → `process.resourcesPath/metadata-templates` →
≤6-level upward walk from cwd; mtime-invalidated cache; throw-on-missing listing the
searched dirs (src/main/services/metadata/templates.ts:42-62, :105-120).

> **Port implications**
> - Byte-parity targets: ComicInfo.xml, `/Keywords`, ZIP container. XMP packet byte-parity
>   is gated on spike S1; Info dict is semantic-only by decision D6 (Producer string and
>   `/Trapped` are deliberately corrected).
> - D3 removes Python/pikepdf entirely — the whole of §4's pikepdf mechanics must be
>   reimplemented in Rust (spike S1), and the `.tmp` guard bug disappears for free.
> - Both `galleryId: 0` behaviours must be reproduced independently; "fixing" either half
>   breaks scanner round-trips on real libraries.
> - The template engine's quirks (inline sections without `each`, drop-any-empty-line,
>   section-vs-inline ordering) are observable in user libraries; port against the 26-case
>   test in src/main/services/metadata/template-engine.test.ts.

---

## 5. External-tool dependency map

The app shells out to two toolchains that are **not bundled**
(src/main/services/toolchain.ts:1-14). The probe (`checkToolchain`, cached until `force`)
spawns four checks and reports per-tool `affects` text plus a platform install hint
(src/main/services/toolchain.ts:50-69, :105-157):

| Tool | Used by | What breaks without it | Citation |
|---|---|---|---|
| Python 3 + pikepdf | All PDF XMP + Info-dict writes (paths 1, 4, 5, 6, 7, 8, 9 of §4) | Downloaded/edited PDFs carry no metadata — the write fails or silently no-ops; CBZ paths unaffected | src/main/services/xmp-inject.ts:60-135; src/main/services/toolchain.ts:116-121 |
| poppler `pdfinfo` | Page counts for conversion verification | PDF→CBZ cannot size its verification; expected-count guard fails closed | src/main/services/pdf-extract.ts:59-69; src/main/services/toolchain.ts:122-128 |
| poppler `pdfimages` | Lossless page extraction (`-all` copies JPEG streams byte-for-byte) | Conversion falls back to pdftoppm → **lossy** output, forced `_lossy/` keep | src/main/services/pdf-extract.ts:139-160; src/main/services/toolchain.ts:129-135 |
| poppler `pdftoppm` | PDF thumbnails in the library scanner; the lossy conversion fallback | No PDF covers on scan; conversions become lossy | src/main/services/library-scanner.worker.ts:817; src/main/services/toolchain.ts:136-143 |

The Linux rpm/deb packages declare `depends: [poppler-utils, python3-pikepdf]`; AppImage
relies on the in-app probe instead (electron-builder.yml:126-144). The probe runs at every
startup (§2 step 10) and on demand via `app:checkToolchain` (src/main/index.ts:237-239),
surfaced in Settings as `ToolchainStatus` with a copyable install command
(src/renderer/src/components/settings/ToolchainStatus.tsx:28-129).

> **Port implications**
> - D3 (zero external tools) deletes this entire section's failure modes: PDF metadata
>   moves in-process (spike S1), image extraction must match `pdfimages -all` losslessly
>   (spike S4, a blocking gate), page counts and thumbnails become library calls.
> - S4 failure is a conflict between D3 and lossless quality — an open question for the
>   user, not a silent downgrade (plan §3, §7).

---

## 6. Third-party runtime dependencies

From `package.json:32-50`:

| Dependency | Why it exists | One-line Rust mapping (no decision implied) |
|---|---|---|
| `better-sqlite3` ^13 | The only database; raw handle required for `UPDATE…RETURNING` queues (src/main/db/connection.ts:90-102) | `rusqlite` |
| `drizzle-orm` ^0.38 | Query builder over better-sqlite3 in repositories; its migration story is unused (no journal exists) | none needed / `rusqlite` direct |
| `sharp` ^0.35 (libvips) | Thumbnails (scanner 600×800, downloads 300×400), optional CBZ re-encode, PDF page raster via canvas | `image`/`libvips`-binding or `zune-image` per spike |
| `yazl`/`yauzl` ^3 | CBZ write (STORE, ComicInfo first) and read (entry names, ComicInfo parse, viewer paging) | `zip` crate — defaults diverge, see spike S3 |
| `pdf-lib` ^1.17 | Builds PDFs from downloaded page images (page size, background) | `pdf-writer`/`lopdf` family |
| `pdfjs-dist` ^6 | Renderer-side PDF rasterisation for `PdfViewer`; its unused Node canvas backend `@napi-rs/canvas` is stripped from packages | `pdfium-render` or wasm pdf.js |
| `ky` ^1.7 | nhentai v2 HTTP client in main (src/main/services/api-client.ts) | `reqwest` |
| `electron-updater` ^6.8.9 | GitHub-releases auto-update with stable/beta channels (src/main/ipc/updater.ipc.ts) | Rust updater or OS package manager (per `11-ci-release-plan.md`) |
| `react-virtuoso` ^4.18 | Virtualisation of LibraryPage only (§8) | GUI-toolkit virtualised list |
| `@tanstack/react-query` ^5.62 | **Mounted and entirely unused** — client configured at src/renderer/src/App.tsx:11-18, provider at :87, zero `useQuery`/`useMutation` calls repo-wide; freshness is nine hand-rolled 2 s `setInterval`s | nothing — a non-problem (plan §4b) |
| `zustand` ^5 | 12 renderer stores (§8) | GUI framework state |
| `react-router-dom` ^7.1 | HashRouter + 6 routes (§8) | GUI framework routing |
| `archiver` ^8 | Declared but the CBZ paths use yazl; verify before porting | — |
| `lucide-react` | Icons | icon set |
| `@electron-toolkit/*` | Electron plumbing (app id, optimizer, preload bridge) | disappears with Electron |

> **Port implications**
> - `sharp`'s thumbnail failures are **silent** today (bare `catch` in workers); the plan
>   makes this a loud failure in Rust — same for pikepdf's silent empty-metadata failure
>   (plan §4, "two deliberate bug fixes").
> - ZIP byte-parity depends on reproducing yazl's *defaults* (spike S3), not the `zip`
>   crate's; budget a golden-file test before trusting any Rust writer.
> - Do not budget effort for a react-query equivalent — measure and replace the intervals
>   instead (§8).

---

## 7. Non-process state

| Thing | Location | Detail |
|---|---|---|
| Data dir | `app.getPath('userData')`, published as `process.env.KOPIBON_DATA_DIR` at startup (src/main/index.ts:101); worker fallback `~/.config/kopibon` (src/main/db/connection.ts:41) | Set before `initDatabase()` and any worker spawn (§2) |
| Database | `<dataDir>/db.sqlite` + WAL | src/main/db/connection.ts:22-49, :79-81 |
| Thumbnails | `thumbnailPath` setting, else `<userData>/thumbnails` (src/main/ipc/library.ipc.ts:210-219) | **Two naming schemes share one dir**: scanner `sha1(filePath)[0:16].jpg` at 600×800 (src/main/services/library-scanner.worker.ts:479-480; hash key src/main/ipc/library.ipc.ts:290-310), download workers `<galleryId>.jpg` at 300×400 (src/main/services/download-pdf.worker.ts:93-98; src/main/services/download-cbz.worker.ts:100). DB stores bare filenames (src/main/db/connection.ts:396-404) |
| Download scratch | `<userData>/download-tmp/<galleryId>/`, page files `%04d.{ext}` (src/main/services/download-manager.ts:99-102, :825) | Purged at attempt start, on failure, on reconcile, in `finally` (§3a) |
| Temp files | `<final>.part` **sibling** of the target, never `/tmp`; hashed+truncated to stay under 255 UTF-8 **bytes** of basename (src/main/services/temp-path.ts:22-37, :79-90) | Sibling keeps the rename atomic; the pikepdf `.tmp` bypasses this guard (§4) |
| Archived originals | `originalsPath` setting, else `<libraryRoot>/_originals/{artist}/`; lossy under `_originals/_lossy/{artist}/` (src/main/services/convert-cbz.worker.ts:267-283; resolver src/main/ipc/library.ipc.ts:239-249) | Never auto-purged; restore/purge UI in Settings |
| Logs | `<userData>/logs/app.log`; rotate at 5 MB keeping 5 (src/main/services/logger.ts:66, :413-433); retention default 14 days clamped 1–365 (src/main/services/logger.ts:68; setter src/main/index.ts:280-287); 2000-record ring buffer serves `log:getRecords` (src/main/services/logger.ts:69, :246-252) | Plus per-job `scan-*.log` (src/main/services/library-scanner.worker.ts:102) and `convert-<ts>.log` (src/main/ipc/library.ipc.ts:2028-2050) |
| User templates | `<userData>/metadata-templates/`, seeded once, never overwritten; honoured via `DOUJIN_TEMPLATE_DIR` (src/main/services/metadata/templates.ts:142-162) | Lets users edit what lands in their files without rebuilding |
| Metadata write temp | `output_path + '.tmp'` from the Python script (src/main/services/xmp-inject.ts:49) | No 255-byte guard; disappears with D3 |

> **Port implications**
> - The two thumbnail schemes coexist because a rescan regenerates exactly the scanner's
>   path — a port that unifies them must also unify the regeneration lookups, or orphaned
>   thumbnails accumulate.
> - The `.part`-sibling + 255-byte rule is a Windows `ENAMETOOLONG` defence measured in
>   UTF-8 bytes of the *basename*; keep the byte-based (not char-based) limit and the
>   code-point-safe truncation (src/main/services/temp-path.ts:54-66).
> - Log level/retention/tail changes are process-lifetime only — not persisted
>   (src/renderer/src/components/settings/LogsPage.tsx:56-58). A port should either persist
>   them or document the same limitation.

---

## 8. Renderer architecture in brief

- **Shell**: `HashRouter` under `QueryClientProvider`; when `onboardingCompleted` is false
  the `OnboardingWizard` renders **instead of the router** — no route, no URL, cannot be
  reopened once completed (src/renderer/src/App.tsx:87-95; wizard
  src/renderer/src/components/onboarding/OnboardingWizard.tsx:23-73). Before first paint the
  app blocks on settings load from the DB (src/renderer/src/App.tsx:76-84).
- **6 routes**, all nested under one `AppShell` (sidebar + scrolling `<Outlet/>` + status
  bar): `/` → redirect `/library`, `/search`, `/library`, `/favorites` (guarded on API key
  by `FavoritesGuard`), `/downloads`, `/settings`; no 404 route
  (src/renderer/src/routes.tsx:14-26).
- **12 zustand stores** (src/renderer/src/stores/), one line each: `auth` — login state,
  loaded from main; `search` — query, results, pagination, rate-limit countdown;
  `search-history` — recents (max 30) + favourites, **persisted to localStorage**;
  `favorites` — favourites results + library facts; `library` — filters, sort, rows,
  detail item/series; `settings` — 18 fields, **persisted via SQLite IPC**; `cdn` —
  thumb/image server lists fetched once; `conversion` — Convert-Library-Metadata job
  (log lines capped 200); `cbz-conversion` — PDF→CBZ job with active/queued id sets;
  `sync-progress` — sync job, terminal message cleared after 6 s; `ui` — theme, sidebar,
  active route, **persisted to localStorage** but `sidebarCollapsed` has no UI control
  (dead state, src/renderer/src/stores/ui.store.ts:25-37); `job-progress.ts` — not a
  store, a hook deriving `ProgressJob[]` from the three job stores. Job listeners are
  registered once in `App` for the app's lifetime, not per-component
  (src/renderer/src/App.tsx:41-66).
- **Freshness is nine 2000 ms `setInterval` polls** — react-query is mounted but unused
  (§6). Sites: StatusBar counts (src/renderer/src/components/layout/StatusBar.tsx:76),
  Sidebar download badge (src/renderer/src/components/layout/Sidebar.tsx:70), DownloadsPage
  (src/renderer/src/components/downloads/DownloadsPage.tsx:146), SearchPage per-result
  status, FavoritesPage, GalleryDetail per-gallery status, LogsPage tail (while
  auto-refresh), SearchPage rate-limit countdown (1 s), and — the expensive one —
  **`LibraryCard` polls its own thumbnail every 2 s with no early-return once found**:
  src/renderer/src/components/library/LibraryCard.tsx:72-85. A 60-card viewport issues
  ~30 IPC calls/second indefinitely; this, not react-query, is the idle-CPU baseline.
- **Virtualisation only on LibraryPage**: `Virtuoso` (list) and `VirtuosoGrid`
  (grid/compact), both `overscan={400}` (src/renderer/src/components/library/LibraryPage.tsx:1198-1207,
  :1364-1373). Search/Favorites/Downloads page instead. Thumbnails are held as base64 data
  URLs in component state with no eviction; unmount is the only reclaim
  (src/renderer/src/components/library/LibraryCard.tsx:72-85).
- **Feedback**: no toast system anywhere; `Notice` banners (14 call sites), ephemeral
  inline "Saved" states, job `lastMessage` cleared after 6 s, OS notifications from main
  only (`discovery-03` §A6). `ErrorBoundary` is fully implemented and never imported —
  uncaught render errors leave a blank screen (src/renderer/src/main.tsx:33-59).
- **Keyboard**: no global shortcut layer; every binding is component-local, and the two
  document-level viewers (`CbzViewer`, `PdfViewer`) have **no input-field guard** on their
  handlers (`discovery-03` §A4). `PdfViewer` renders every page eagerly to a full-size
  canvas, yielding every 5th page (src/renderer/src/components/library/PdfViewer.tsx:94-109).

> **Port implications**
> - The onboarding-not-a-route fact is user-visible behaviour: a port that makes it a route
>   changes what "reopen onboarding" means; keep it as a full-screen takeover unless
>   consciously changed.
> - Replace the nine polls with push over the existing event channels
>   (`download:progress`, `library:newItem(s)`, job progress events); the per-card thumbnail
>   poll is the specific anti-pattern to eliminate, and baselines must measure idle CPU
>   with a populated grid open (plan §4b).
> - Transcribe component-local keybindings verbatim, including the missing input guards —
>   they are parity surface (`04-parity-ledger.md`).
