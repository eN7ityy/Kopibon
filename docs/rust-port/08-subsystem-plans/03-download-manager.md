# Subsystem plan 03 — Download manager (`kopibon-core::download`)

Execution plan for the Rust port of `src/main/services/download-manager.ts`
(977 lines) plus the two generation workers it spawns
(`download-pdf.worker.ts`, `download-cbz.worker.ts`), built headless in Phase
A. Contract sources: [03-data-model.md](../03-data-model.md) §2.4/§2.5 (tables),
§6.1 (state machine — cite, don't restate),
[01-current-architecture.md](../01-current-architecture.md) §3a (flow),
[07-metadata-spec.md](../07-metadata-spec.md) (the metadata the workers write),
[04-parity-ledger.md](../04-parity-ledger.md). All citations are to
`src/main/services/download-manager.ts` unless marked.

---

## 1. Module boundaries

```
kopibon-core/src/download/
├── mod.rs        // DownloadManager: queue pump, claim, active set, pause/cancel control
├── pipeline.rs   // downloadItem port: metadata → placeholder → pages → convert (§4)
├── cdn.rs        // server rotation + demotion/re-promotion state (§5)
├── scratch.rs    // <userData>/download-tmp/<galleryId>/ lifecycle (§4)
├── worker_pdf.rs // image → JPEG → minimal PDF assembly (§6, replaces download-pdf.worker)
├── worker_cbz.rs // StoreZipWriter assembly + thumbnail (§6, replaces download-cbz.worker)
└── events.rs     // DownloadProgress + notification sink trait (§8)
```

Depends on `metadata` (writers, filenames, context builders), `nhentai`
([04-nhentai-client.md](04-nhentai-client.md) — gallery fetch, CDN config) and
the DB layer. In Rust the worker threads become **spawned tasks** of the same
process ([06-technology-decision.md](../06-technology-decision.md) §8); the
message protocol of 01-current-architecture §1.2 (`progress` / `complete` /
`error`) is preserved as channel contracts. The settle-once-then-terminate
dance (:581-600) exists because workers never exit — it collapses to an
awaited `JoinHandle`/`oneshot`.

## 2. Queue states and transitions

Normative: **[03-data-model.md](../03-data-model.md) §6.1** — `queued →
downloading → converting → completed`, plus `paused`, `failed`
(src/main/db/schema.ts:95); completed rows pruned at boot
(src/main/services/startup-maintenance.ts:78-91), queued/paused/failed kept as
user intent (:20-24). Extra port obligations: `findActiveByGalleryId` retry
semantics (src/main/db/repositories/download.repo.ts:44-52 — a retry is never
blocked by a finished row); `download_page` rows are per-attempt bookkeeping,
wiped at boot and deleted on completion/reconcile (03-data-model §2.5).

## 3. Claim semantics — port decision

1.x claims with a read-then-write: `findByStatus('queued')`, in-memory sort
`priority DESC, queuedAt ASC`, separate `UPDATE → 'downloading'`
(:210-224, sort at :215), safe only because a single in-process scheduler is
guarded by the `processingQueue` reentrancy flag (:179-181).

**Port decision: keep the single-scheduler; do not adopt `UPDATE…RETURNING`
for the download queue.** Recommendation and reasons: the port is one process
with exactly one pump task (a dedicated `tokio` task owning a mpsc command
channel — the async equivalent of the `processingQueue` guard, which is the
documented invariant 03-data-model §10.4 allows); `RETURNING` would buy
nothing and would drag along a second claim pattern to keep consistent with
the 1.x behaviour we diff against. The conversion/sync queues keep their
`RETURNING` claims (03-data-model §6.3/§6.4) — they genuinely have N runners.
If a future port ever allows multiple download consumers, that is the trigger
to switch to the `src/main/db/repositories/conversion.repo.ts:69-88` pattern; record the invariant in
the module docs. Unit stamp: 1.x writes `startedAt: Date.now()` ms (:221);
port writes `unixepoch()` seconds per 03-data-model §10.5 (tolerate ms on read).

## 4. Pipeline (pipeline.rs) — port of `downloadItem` (:332-765)

In order, each step observable in the progress events and DB:

1. **Metadata** — `parseCachedGallery` (:40-65): a `gallery` row is usable
   only with real `tags`/`pages`/`num_pages`/`media_id`/`title`; scanner stubs
   are cache **misses** (the upsert then repairs them as a side effect).
   Miss → `GET /galleries/{id}` via the nhentai client, `gallery` row upsert
   incl. rawJson (:339-371).
2. **Placeholder row** — if no library item exists for the gallery: insert
   `is_custom=2`, `file_path=''`, title/tags/language/artist/publisher from
   the gallery (:387-416). Every status resolver reads is_custom=2 as
   "downloading" — a placeholder left behind after failure is the bug
   `removePlaceholder` (:293-309) exists to undo; preserve the lifecycle
   (placeholder on success: `is_custom 2 → 0` + real fields at :701-713;
   deleted on failure).
3. **CDN** — fetch config (1 h cache client-side), filter empty strings,
   `orderServers` demoted-last (:419-420, :257-262; mechanics §5).
4. **Page rows** — N `download_page` rows `pending` (:422-431).
5. **Scratch** — `<userData>/download-tmp/<galleryId>/` purged then created
   **fresh at the start of every attempt** (:99-102, :433-439); purged again
   on failure, on reconcile, and in `finally` (:314-327, :282, :759-764).
6. **Pages** — batches of **3** concurrent (:449-462); per page
   `downloadPageWithRetry` (:770-867): up to 3 attempts, server =
   `servers[attempt % len]`, URL
   `https://{host}/galleries/{mediaId}/{n}.{ext}` (:783-787), **30 s timeout**
   (:791), UA `Doujin-Downloader/1.0` (:795), 404 → next server silently
   (:800-804), non-404 failure counts toward demotion (§5), exponential
   backoff `1s·2^attempt` (:863), extension from the gallery's page path
   (:811-823), file written as `%04d.{ext}` (:825). A page that exhausts
   retries marks its `download_page` row failed (:492-497). After all batches:
   any missing page → `failDownload("{k} of {n} pages failed")` (:526-535).
   Pause polls between batches on a 500 ms sleep (:457-459); cancel checked
   per batch (:451-454, :520-523).
7. **Convert** — status → `converting` + event (:538-541); output path
   `{libraryRoot}/{primaryArtist}/{safeTitle} [nhentai-{galleryId}].{pdf|cbz}`
   with **sanitiser 1** (`_`-substitute `[/\\?%*:|"<>]`, 180-char cap;
   :547-553 = 07-metadata-spec §7 row 1); series/volume preserved from any
   existing row (:555-558); settings mapped to worker options
   (`compressPdf`/`compressionQuality` clamp 1–95/`pageSize` Dynamic|Fit to
   Image|Letter|A4|`blackBackground`; CBZ gets `cbzMangaDirection`, :628-648).
8. **Complete** — row `completed` (:653-656); library item updated with size,
   page count **counted from the file** (src/main/services/page-count.ts via
   :699), `file_path` relativised
   (src/main/services/library-paths.ts:19-36), artist rows inserted when empty
   (:716-726), thumbnail path stored as bare filename (:729-734); **re-download
   deletes the superseded file only after the new one exists** (:678-695);
   `download_page` rows deleted (:739); notification gated on
   `showNotifications` (:744-746). The Kavita scan hook stays **disabled**
   (:748-755 — do not restore it; Kavita's watch folder owns discovery).
9. **Failure** — `failDownload` (:314-327): row `failed` + message, placeholder
   removed, scratch purged, terminal `failed` progress event.

## 5. CDN rotation + demotion (cdn.rs)

Port :127-134, :257-262, :831-853 exactly. State: per bare hostname
(protocol stripped) a consecutive-non-404 failure counter, plus a demoted set.
`DEMOTE_THRESHOLD = 3`; demoted hosts sink to the **end** of the server list
(never dropped, :257-262); **one success clears the count and re-promotes**
(:831-837). 404s never count (:800-804 — page-specific miss). This is the
scheduler's stateful concern; the renderer's rotation re-implementations (no
demotion) are UI-only and die with the renderer
(planning plan §1 discovery table). Concurrency caution: the maps are shared
across parallel page batches — put them behind the pump's single task or a
`Mutex` and keep counter semantics identical.

## 6. Generation workers

- **CBZ** (worker_cb.rs → `metadata::writers`): `StoreZipWriter` with
  `ComicInfo.xml` first (rendered with `pageCount = imagePaths.len()`,
  src/main/services/cbz-generator.ts:63) + pages `%04d.{ext}` STOREd, `.part` sibling via
  `temp_sibling_path`, atomic rename (src/main/services/cbz-generator.ts:59, :110-151);
  optional re-encode pass when quality/maxDimension requested (:72-100).
  Thumbnail: `<thumbnailDir>/<galleryId>.jpg` @300×400 q80 from the first
  page (src/main/services/download-pdf.worker.ts:90-98, src/main/services/download-cbz.worker.ts:100) — the
  second naming scheme; bytes not parity-critical (same tolerance as
  [02-library-scanner.md](02-library-scanner.md) §6).
- **PDF** (worker_pdf.rs): 1.x uses pdf-lib + sharp. **Rust path: decode with
  the `image` crate → JPEG re-encode at the configured quality (when
  quality < 100; per-page failure falls back to embedding original bytes,
  src/main/services/pdf-generator.ts:71-83) → assemble with `lopdf`**: one image-only PDF, one
  `DCTDecode` XObject per page, page boxes per `pageSize` (`dynamic` = width
  1800 scaled by aspect, `fit` = image dims, `letter`/`a4` fixed; :138-158),
  aspect-preserving centred draw (:162-179), optional black background rect
  (:182-190). This is well inside lopdf's capability (S1/S4 already read and
  wrote such streams); a dedicated `pdf-writer` crate would also do, but one
  PDF dependency is preferred. Unfixable page (decode + embed both fail) is
  **dropped with a loud log**, never silent (src/main/services/pdf-generator.ts:121-125;
  the sanctioned loudness fix).
- **Metadata write** on the PDF path: XMP + Info dict via
  `metadata::writers::pdf` (lopdf, D6 semantics); failure is **warn-only,
  non-fatal** — the PDF ships without metadata (src/main/services/download-pdf.worker.ts:48-81,
  07-metadata-spec §6 row 1). CBZ path has no XMP step
  (src/main/services/download-cbz.worker.ts:87).

## 7. Crash reconciliation + control

- `reconcileInterrupted` (:271-290): at boot, before the pump
  (src/main/index.ts:189-212) — every `downloading`/`converting` row →
  `queued`, `started_at`/`error_message` nulled, **page rows deleted**,
  **scratch dir purged**; count logged and returned.
- Concurrency: `applyConcurrencyFromSettings` (:163-169) reads
  `downloadConcurrency` (default '3', 03-data-model §7.1); clamp **1–8**
  (:144-152); raising it fills new slots immediately (:151).
- Pause/resume/cancel (:872-935): in-memory flags on the active item, DB
  mirrors (`paused`/`downloading`); non-active `queued` rows flip to `paused`
  and back; cancel of a queued/paused row deletes row + pages (:928-934).
  `pauseAll`/`resumeAll` (:940-966) sweep both layers. Cancel of an in-flight
  item is cooperative — the batch loop sees it and routes through
  `failDownload("Cancelled by user")` (:451-454, :520-523).

## 8. Events and notifications

`DownloadProgress` (:69-80) maps 1:1 to the `download:progress` event
(02-ipc-surface.md); emit after every batch with speed (real bytes
accumulated, :486-491) and ETA (:500-506), plus `converting`/`completed`/
`failed` status events. Notifications go through a `Notifier` trait so Phase A
is headless-testable; the GUI impl wraps the OS notification
(:744-746, `showNotifications` setting, 03-data-model §7.2).

## 9. Tests

Differential where 1.x is drivable (network mocked identically on both sides
via a local fixture server), state-machine tests otherwise:

| Test | Asserts |
|---|---|
| State machine | every legal + illegal transition of 03-data-model §6.1; terminal states match |
| Claim order | priority DESC, queuedAt ASC under a mixed queue; single scheduler holds under concurrent `processQueue` calls |
| Fill-to-max | concurrency clamp 1–8; raising fills slots; lowering lets running jobs finish |
| Page pipeline | fixture server: success, 404-then-success (server rotation), non-404 ×3 → demotion, success re-promotes, batch-of-3 ordering, 30 s timeout, `%04d` naming, backoff schedule |
| Placeholder lifecycle | is_custom=2 → 0 on success; row deleted on failure; `file_path=''` never escapes |
| Output path | sanitiser 1 + `[nhentai-{id}]` suffix; artist dir creation; existing series preserved |
| **Simulated crash recovery** | kill the process mid-`downloading` and mid-`converting` (SIGKILL against a test harness); reboot sequence: reconcile flips both to `queued`, pages wiped, scratch purged, pump resumes, download completes; assert no `download_page` orphans and empty `download-tmp/` |
| Superseded re-download | old file removed only after new file exists; failure between leaves both |
| Page count | counted from the written file, not `num_pages` (drop-a-page fixture) |
| Boot maintenance interplay | completed rows pruned per retention; queued/paused/failed kept (src/main/services/startup-maintenance.ts:78-91) |
| Worker output | CBZ = S3 structural checklist; PDF page size/background/centring vs golden image-only PDF; XMP failure warn-only |
| Events | progress payloads equal 1.x's on the same scripted run |

## 10. Exit criteria

1. State-machine + claim-order tests green; single-scheduler invariant
   documented in code and held under the concurrency test.
2. Simulated crash recovery test green from both interrupted states, twice in
   a row (idempotent reconcile).
3. CDN demotion/re-promotion exercised exactly per §5 on a scripted
   multi-server fixture.
4. A full end-to-end download (fixture server → file on disk → DB rows →
   thumbnail → events) produces rows and artefacts equal to a 1.x run on the
   same fixture gallery, at the artefact parity levels of
   [07-metadata-spec.md](../07-metadata-spec.md).
5. Kavita scan hook absent; notifications trait-abstracted.

## 11. Risks

| Risk | Mitigation |
|---|---|
| PDF assembler divergence on exotic page sizes/DPI | golden image-only PDFs per pageSize mode; the app's PDFs are image-only by construction — assert no font or vector content is ever emitted |
| Demotion state shared across parallel batches introduces races | keep counters on the single pump task (§5); unit-test interleavings |
| ms-vs-s timestamp mixing on `started_at` | write seconds (03-data-model §10.5); tolerate ms on read; never rewrite old rows |
| Placeholder row leak on crash between insert and reconcile | reconcile covers `downloading`; add a boot sweep test for orphaned `is_custom=2` rows with empty `file_path` whose queue row is gone — mirror `removePlaceholder` logic, flag if found |
| Fixture-server fidelity (Retry-After, chunked images) | fixture server models headers/timing explicitly; shared with [04-nhentai-client.md](04-nhentai-client.md) tests |
