# Subsystem plan 06 — Conversion pipeline (`kopibon-core::conversion`)

Execution plan for the two long-running conversion jobs and the PDF→CBZ
pipeline: `src/main/services/convert-cbz.worker.ts` (346 lines) +
`pdf-extract.ts` + the DB-backed queue pump in
`src/main/ipc/library.ipc.ts:2929-3379`, and `convertAllMetadata`
(`library.ipc.ts:2010-2224`). Built headless in Phase A, differentially
tested. Contract sources: [03-data-model.md](../03-data-model.md) §6.3
(conversion_queue machine — cite, don't restate),
[07-metadata-spec.md](../07-metadata-spec.md) (the metadata written into each
CBZ), [01-current-architecture.md](../01-current-architecture.md) §3
(worker shape), S4 spike ([06-technology-decision.md](../06-technology-decision.md)
§1, §8). Citations are to `src/main/` unless marked.

---

## 1. Module boundaries

```
kopibon-core/src/conversion/
├── mod.rs           // ConvertToCbzJob: queue pump, runner pool, lock sets, cancel
├── metadata_job.rs  // convertAllMetadata port (DB-backed per Q6, §5)
├── worker_cbz.rs    // port of convert-cbz.worker.ts — the 8 ordered steps (§3)
├── extract.rs       // pdf-extract.ts port: S4 lopdf path + fallback policy (§4)
├── verify.rs        // verifyCbz port (§3 step 5)
├── originals.rs     // _originals/_lossy walk, restore, purge (§6)
└── events.rs        // convertToCbzProgress / convertProgress sinks (traits)
```

Depends on `metadata` (writers, `filenames.rs` sanitiser 3, `apply_metadata`),
`db` (conversion repo), and a `PageCounter` for the archive recount. In Rust
the worker threads become spawned tasks sharing the process
([06-technology-decision.md](../06-technology-decision.md) §8); the message
protocol of the worker (`convert` / `done` with `newPath, fileSize, fileMtime,
lossless, originalKept, forcedKeep, log` — `convert-cbz.worker.ts:7-9, :312-328`)
is preserved as the internal channel contract.

## 2. The queue pump (`mod.rs`) — port of `library:convertToCbz`

[03-data-model.md](../03-data-model.md) §6.3 is the state machine; the pump
around it, in order (`library.ipc.ts:2929-3379`):

1. **Options resolve** — runners = `clamp(downloadConcurrency, 1, 8)`
   (`:2947-2953`); `keep_original` = arg → `cbzKeepOriginal` setting
   (`:2956-2960`); manga direction from `cbzMangaDirection` (`:2972-2975`).
   Guard: keep-original with a missing/unreachable library root refuses the
   whole batch with the exact message at `:2961-2971`.
2. **Dry run** — `{dryRun:true, items, count}` from the ids, no queue writes
   (`:2977-2998`).
3. **Targets** — only rows with `format === 'pdf'`; `skipped = ids − targets`
   (`:3000-3009`). Fresh batch (no `resume`) → `clearFinished()` then
   `enqueue()` (`:3025-3032`); **resume skips enqueue entirely** (`:3011`,
   `:3013-3033`) — the queue is the work list. `batchTotal` = pending count
   after enqueue (`:3035-3048`).
4. **Lock sets** — `cbzQueued`/`cbzConverting` seeded from `pendingItemIds()`
   (`:3050-3051`, sets defined `:183-198`); they back the uniform
   *"This file is being converted to CBZ."* refusal on every mutating library
   channel ([02-ipc-surface.md](../02-ipc-surface.md) §5.8) and
   `library:getCbzConversionState` (`:3769-3780`) for UI rehydration.
5. **Runner loop** — each of the N runner tasks claims via `claimNext()`
   (`:3106`), fetches the library row, and **marks the queue row completed and
   moves on when the item is missing or no longer pdf** (`:3117-3127`) — the
   row is stale, not an error. The worker command carries the full metadata
   payload incl. `uploadDate`/`rawTagsJson` from the cached gallery row
   (`:3136-3148`) and `options.keepOriginal` **from the claimed row, not the
   setting** (`:3179`).
6. **Completion** — on success: rename/move the cover thumbnail to the new
   name, recount pages from the written CBZ, update the row (`filePath`
   relativised, `format='cbz'`, `pageCount`, `fileSize`, `fileMtime`, **both**
   `customCoverPath` and `thumbnailPath` when the cover moved — the two
   columns must never disagree again, `:3218-3254`), then `markCompleted`
   (`:3258-3261`). On cancel: `release()` back to pending (`:3262-3268`).
   On failure: `markFailed` with the error (`:3269-3281`).
7. **Backstops** — worker error and nonzero exit both mark the row failed and
   clear the lock sets (`:3295-3330`); the outer catch clears lock sets,
   re-sends progress and **re-throws** so `handle()` mints an `errorId`
   (`:3366-3377`). After the batch: `invalidateOriginalsInfo()` (`:3348`).
8. **Cancel** — module flag checked before each claim; in-flight workers are
   left to finish and their rows are released (`:3381-3387` + step 6).

## 3. `worker_cbz.rs` — the 8 ordered steps (order is the safety property)

Header rule of `convert-cbz.worker.ts:4-5`: *"The ordering is the safety
property — do not reorder steps 1–8."*

1. **Source check** — `existsSync` or throw `Source file not found: {path}`
   with the full path (`:200-202`): the message must distinguish a stale queue
   row from a vanished network mount (`:191-199`).
2. **Extract** to `<userData>/convert-cbz/{itemId}/` (`:205-215`); extraction
   failure removes the scratch dir and rethrows (`:211-215`) — §4.
3. **Metadata** — `buildConversionMetadata` → `file_metadata_from_library_item`
   with `pageCount = extracted count`, `format: 'cbz'` (`:93-102`); all
   decisions live in the mapper, not here ([07-metadata-spec.md](../07-metadata-spec.md)
   context rules).
4. **Generate CBZ** — output path = source with `.pdf → .cbz`, uniquified
   `-1,-2,…` while it exists (`:225-232`); `StoreZipWriter` with
   `quality: null, maxDimension: null` (no re-encode) (`:234-239`).
5. **Verify** (§3.1 below) — failure unlinks the output, purges scratch and
   throws *"Verification failed — output CBZ did not pass integrity checks"*
   (`:246-259`); the log line carries the expected page count (`:251-253`).
6. **Original handling** — only after verification. `forced_keep =
   !lossless`; `keep = options.keep_original || forced_keep` (`:268-269`).
   Keep → archive the PDF: root = `originalsRoot` setting or
   `<libraryRoot>/_originals` (`:280`); lossless →
   `{root}/{safe_path_segment(artist)}/`, lossy → `{root}/_lossy/{segment}/`
   (`:281-283`, sanitiser 3 at `:74-81` incl. leading-dot collapse); never
   overwrite an archived original — uniquify `-n.pdf` (`:288-294`); forced
   keep logs a warning that the setting was overridden (`:296-300`).
   Not keep → `unlinkSync(filePath)` (`:302`).
7. **Purge scratch, always** (`:305-306`).
8. **Report** — `statSync` of the output for size + mtime, the done message
   with `lossless/originalKept/forcedKeep/originalPath` (`:308-328`).

Catch-all (`:329-345`): on any failure the PDF and DB row are untouched,
scratch cleaned, `done{success:false}` posted. **The port must preserve
"failure leaves the source in place" as an invariant, not a courtesy.**

### 3.1 `verify.rs`

Port `verifyCbz` (`:106-176`) exactly: open the archive; `ComicInfo.xml` must
be **entry 0** and parse with a non-empty `<Title>` (`parseComicInfoXml`,
`comicinfo.ts`); count only image entries (skip directories and ComicInfo —
`:134`); assert `imageCount == expectedPages`, `totalEntries ==
expectedPages + 1` (`:152-157`), and names are zero-padded sequential
`%04d{ext}` preserving each entry's own extension (`:159-163`). Any stream
error → false. Every valid archive must pass; every truncated/tampered
fixture must fail on the specific check.

## 4. Extraction (`extract.rs`) — S4 path and the rasteriser gap

1.x `extractPdfImages` (`pdf-extract.ts:128-206`): expected page count from
`pdfinfo`, never from `gallery.page_count` (scanner stubs are 0) — port reads
it from the document with `lopdf` (`:64-71` equivalent); attempt 1
`pdfimages -all` becomes the **S4 lopdf path: DCTDecode JPEG streams extracted
byte-identical** (S4 PASS 16/16, 06-technology-decision §1) with non-JPEG
streams decoded losslessly where S4 covers them; output sorted by **numeric
trailing index, not lexicographic** — the padding-grows bug (`:85-89`, the
shipped backwards-CBZ regression).

- **Count guard** (`:150-165`): extracted ≠ expected → discard everything,
  warn, fall through. Never trust per-embedded-image counts as page counts.
- **Fallback** (`:177-205`): 1.x rasterises with `pdftoppm -jpeg -r 150`
  (lossy), sets `lossless:false`, and step 6 then forces the original to be
  kept.

> **RESOLVED — pdfium-render (USER DECISION option A, 18-future-work F1
> closed).** The fallback is `conversion::raster`: vendored non-V8
> `libpdfium.so` (`third-party/pdfium/`, BSD-3-Clause — 13-licence-audit §5),
> bound at runtime via `Pdfium::bind_to_library` (never a subprocess — D3
> holds). Attempt 2 renders every page at 150 DPI to `page-%04d.jpg`
> (`method: "pdfium"`, `lossless: false`), with the 1.x count-guard message
> shape on short renders; fidelity spike (3-page vector PDF): 3=3 pages,
> identical 1275×1650, mean-abs-diff ≈0.18/255. Rasteriser-absent still fails
> loud per item (the old *"lossy fallback requires a rasteriser"* text leads
> the error). PDF thumbnails reuse the same binding (page-1 render →
> fit-inside 600×800 q82). Binding is process-global first-call-wins
> (pdfium-render constraint); the absent-path test is isolated in
> `tests/raster_absent.rs`.

## 5. `metadata_job.rs` — convertAllMetadata, made resumable

1.x runs it off an in-memory array — `items[queueIndex++]`, the one long job
with no crash resume (`library.ipc.ts:2094-2100`); pool clamped 1–20
(`:2025`); own log file `userData/logs/convert-<ts>.log` (`:2028-2046`);
progress via `library:convertProgress` with drained `logLines` (`:2057-2065`);
the invoke returns only when done (`:2208-2220`); cancellation is a module
flag (`:2226-2229`). Each item: `apply_metadata` (ComicInfo rewrite / XMP
write per format, `convert.worker.ts:50`) + the `[nhentai-{id}]` marker move
to the filename end preserving the real extension (`convert.worker.ts:56-80`).

> **Port decision (16-open-questions.md Q6 default): DB-backed and
> resumable.** Add a `metadata_queue` table mirroring `conversion_queue`
> (`file_path UNIQUE`, `library_item_id`, `keep_original` not needed,
> `UPDATE…RETURNING` claim) created by the same idempotent migrator —
> harmless `CREATE TABLE IF NOT EXISTS` on existing DBs. This is a **P2
> deviation: a ledger row in [04-parity-ledger.md](../04-parity-ledger.md) §9
> is required** ("convertAllMetadata is crash-resumable in 2.x; 1.x lost its
> place"). Everything else is ported as-is: pool clamp 1–20, per-run log
> file, progress event shape, cancel-flags-current-item semantics, and the
> return payload `{converted, failed, total, cancelled, errors?(≤20)}`
> (`:2216-2219`).

## 6. `originals.rs` — archive walk, restore, purge

- **Walk** (`scanOriginals`, `library.ipc.ts:3498-3541`): recursive, async,
  classifying anything under a `_lossy` segment separately; unreadable dirs
  are skipped, stats that fail count as 0. The cached info (60 s TTL,
  single-flight, keyed by root — `:3439-3482`) and the explicit
  invalidation after every mutation (`:3348, :3686, :3755`) are part of the
  surface (`library:getOriginalsInfo` `:3561-3570`).
- **Restore** (`library:restoreOriginals`, `:3595-3690`) — ordering is the
  safety property, keep it verbatim: rel path with **leading `_lossy`
  segment stripped** so a lossy original lands where its sibling would
  (`:3613-3623`); never overwrite an existing target (`:3628-3631`); move
  the PDF back; **confirm it arrived** before deleting anything (`:3640-3647`);
  then delete the CBZ (failure there is *not* a failed restore — `:3651-3658`);
  then update the row (format back to pdf, size, mtime from the restored
  file, cover rename) (`:3649-3676`). Post-restore metadata edited after the
  conversion is knowingly not recoverable — the UI copy says so.
- **Purge** (`library:purgeOriginals`, `:3692-3767`): lossy kept unless
  `includeLossy`; empty-dir prune walking the archive root *as resolved*
  (the double-append bug at `:3722-3725` is not ported); returns
  `{deleted, bytes, failed, removedDirs}`.

## 7. Tests

Differential where 1.x is drivable (same fixture PDFs through both engines,
network/FS identical); invariant tests otherwise.

| Test | Asserts |
|---|---|
| Golden conversion | each golden PDF fixture converts on both engines; CBZ outputs byte-equal at the 07-metadata-spec levels (ComicInfo first, `%04d`, S3 container fields); row updates equal |
| Step-order invariant | mutation of each step's precondition fails cleanly: missing source (stale row), verification failure, write failure — PDF present and unchanged after every failure |
| Verify gate | truncated archive (page dropped), shuffled page names, ComicInfo not entry 0, extra stray entry → verify fails on the right check; valid archive passes |
| Count guard | PDF whose embedded image count ≠ page count → fallback branch (or, pre-USER-DECISION, loud failure), `lossless=false` downstream, original never deleted |
| Forced keep | lossy conversion with keep_original=false archives to `_lossy/{artist}/`, `forcedKeeps` counted, warning logged; lossy with keep=true lands in `_lossy` too (forced) |
| Archive collisions | re-converting a name that already exists in `_originals` uniquifies `-1.pdf`, never overwrites |
| **Simulated crash mid-batch** | SIGKILL while 3 of 12 items convert; reboot: `converting→pending` via maintenance, resume (`resume:true`) re-claims and completes the batch; per-row `keep_original` honoured (flip the setting between runs to prove it); no orphaned scratch dirs, no double-CBZ |
| Cancel mid-batch | cancel during item k: in-flight item finishes, its row released, pending rows stay pending, counts report `cancelled` |
| Vanished network mount | library on a mount that disappears mid-batch: step 1 `Source file not found: {path}`; no unlink attempted; queue row failed with the path in the message; mount restored → resume succeeds. Same for restore/purge pointing at a vanished `_originals` (zero restorations, no failures counted as deleted) |
| Restore ordering | inject failure at each point: existing target (skip), move done but confirm fails (counted failed, PDF still on disk), CBZ unlink fails (still `restored`); `_lossy` strip test; interruption between move and delete leaves a readable copy |
| Purge | default spares `_lossy`; `includeLossy` takes both; empty dirs pruned; info cache invalidated |
| metadata_job | crash mid-run → resume finishes the remainder; marker-move preserves the real extension; errors capped at 20; log file written |

## 8. Exit criteria

1. Golden fixtures convert at their 07-metadata-spec parity levels; verify
   gate proven both ways (§3.1).
2. Crash-mid-batch and cancel tests green twice in a row (idempotent resume);
   vanished-mount test green for convert, restore and purge.
3. Forced-keep/`_lossy` semantics bit-exact vs 1.x on a lossy-path fixture
   (synthetic PDF injected via the extractor trait until the rasteriser lands).
4. convertAllMetadata resumable (Q6 deviation landed with its ledger row),
   payload and progress shapes equal to 1.x.
5. The 8-step order documented in `worker_cbz.rs` header and asserted by the
   failure-injection tests.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Rasteriser choice blocked (licences, bundled size) | §4 USER DECISION defers it behind a loud error; extractor trait isolates the seam; packaging plan owns the trade-off (06-technology-decision §8) |
| Cover-rename and two-column update drift | port the both-columns update (`:3240-3250`) and test that `customCoverPath`/`thumbnailPath` never disagree after conversion |
| `lopdf` page-count vs `pdfinfo` divergence on exotic PDFs | differential expected-count test over the golden corpus + a hostile-PDF sample (linearised, encrypted-but-readable, zero-page) |
| Scratch dir leaks across crashes | boot-time sweep for `<userData>/convert-cbz/*` added to maintenance — noted as a deviation candidate if 1.x lacks it (it does) |
| Restore semantics on case-insensitive filesystems | the never-overwrite check must use the FS, not a DB lookup; test with a target differing only in case |
