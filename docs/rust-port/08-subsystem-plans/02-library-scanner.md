# Subsystem plan 02 — Library scanner (`kopibon-core::scanner`)

Execution plan for the Rust port of `src/main/services/library-scanner.worker.ts`
(1113 lines) as a `kopibon-core::scanner` module, built headless in Phase A and
differentially tested against a live 1.x scan. Contract sources:
[03-data-model.md](../03-data-model.md) §2.9 (scan_queue), §6.2 (state machine),
[01-current-architecture.md](../01-current-architecture.md) §3b (flow), §1.2
(worker row), [04-parity-ledger.md](../04-parity-ledger.md) (the mass-delete
guard is the P0, highest-consequence non-metadata test). All citations are to
`src/main/services/library-scanner.worker.ts` unless marked.

---

## 1. Module boundaries

```
kopibon-core/src/scanner/
├── mod.rs        // ScanJob: public control surface (start/pause/resume/cancel), event stream
├── walk.rs       // walkLibraryFiles port: rules, reserved dirs, failedDirs (§2)
├── queue.rs      // scan_queue lifecycle: populate, requeue, claim, complete, cleanup (§4)
├── extract/
│   ├── pdf.rs    // docinfo + XMP regex extraction (§5.1)
│   ├── cbz.rs    // ComicInfo.xml parse-side extraction (§5.2)
├── thumbnail.rs  // scanner-scheme thumbnails + repairThumbnail (§6)
├── process.rs    // processFile port: skip rules, row insert/update, stub gallery (§7)
└── removal.rs    // the triple-guarded removal pass (§8 — highest consequence)
```

Owns one `rusqlite` connection for its lifetime (§9). Consumes
`metadata::xml_utils` (decode) and `metadata::filenames`; produces
`ScanEvent`s consumed by the future IPC layer (event channels
`library:scanProgress/newItems/scanComplete/scanPaused/scanCancelled/scanError`,
02-ipc-surface.md §3). Does **not** own the metadata *writers* (scanner only
reads).

## 2. Walk rules (walk.rs)

Port `walkLibraryFiles` (:592-622) exactly:

- Recursive walk, files only, extensions `.pdf`/`.cbz` case-insensitive (:613-615).
- Skip entries starting with `.` (:605); skip the reserved directories
  `_Unsorted`, `_migration_staging`, `_originals` by exact name (:606-607).
- **Every read failure is recorded**, never swallowed: `failedDirs: Vec<(dir,
  error)>` (:596-601). A partial walk must be distinguishable from a complete
  one — this is removal-guard input #1 (§8). A **missing** root aborts the scan
  with an error event before any queue work (:872-875); an unreadable-but-existing
  one surfaces only as `failedDirs` entries, which is exactly why the removal
  guard consumes that list rather than a boolean.
- Result sorted newest-mtime-first so recent downloads scan first (:880-882).

Rust: `walkdir` with `sort_by` off (order comes from the mtime sort), manual
`DirEntry::file_type` filtering; collect `failedDirs` from `walkdir::Error`
per-entry via `filter_entry` + a custom error sink (walkdir flattens the
recursive-readdir failure the TS code gets from `readdir` — verify per-level
behaviour in tests with a chmod-000 directory).

## 3. Concurrency model

The 1.x worker is a single-threaded loop. **Port decision: keep it
single-threaded per scan.** Rationale: order (`priority DESC, id ASC`), the
pause gate, the batch flush timing, and the removal guard all assume one
consumer; parallelising would reorder `scan_queue` claims and change nothing
observable except speed. `rayon` is explicitly rejected. The scan runs as one
`tokio` task (spawn_blocking for CPU/IO-heavy items if profiling demands,
still one logical consumer — [06-technology-decision.md](../06-technology-decision.md)
§8). Scan remains a **singleton**: a second start is refused while one is live
(src/main/ipc/library.ipc.ts:990-993) — enforce with a process-global `Mutex<()>`
or a `ScanJob` handle held by the app state.

## 4. scan_queue lifecycle (queue.rs)

Machine (03-data-model §6.2): `pending → scanning → (row deleted on complete) | failed`.

1. **Wiped at boot** by startup maintenance before any scan
   (src/main/services/startup-maintenance.ts:68; rationale :14-18) — intra-run
   progress only; the real incrementality is §7's mtime+size skip. Keep the wipe
   in the boot transaction order given in 03-data-model §10.7.
2. **Populate:** `INSERT OR IGNORE INTO scan_queue (file_path, status) VALUES (?, 'pending')`
   with **paths relative to library root**, one transaction (:640-648).
3. **Requeue:** within a run, `UPDATE scan_queue SET status='pending' WHERE
   status IN ('scanning','failed')` (:658-664) — a failed file becomes visible
   to later scans instead of being skipped forever.
4. **Work query:** `pending OR scanning, ORDER BY priority DESC, id ASC`
   (:894-896); claim = `UPDATE ... SET status='scanning' WHERE file_path = ?`
   (:940). Single consumer, so no `RETURNING` needed (matches 03-data-model
   §6.2; do not "upgrade" it).
5. **Terminal:** complete → `markQueueItem(status, scanned_at, error?)`
   (:744-749); errors recorded with message. After the run, completed rows are
   deleted (:1082).

## 5. Extraction

### 5.1 PDF (extract/pdf.rs)

Port `extractPdfMetadata` (:248-322) with two components:

- **Docinfo** via `lopdf` (replaces pdf-lib's getters): `/Title`, `/Author`
  split on `','` (:260), `/Keywords` token parse (:262-281), `/CreationDate`,
  `/Subject` legacy series fallback (:285-290). `/Keywords` parser is the
  matched pair of the writer (07-metadata-spec §5): `nhentai:(\d+)`
  (:68, :265-266), `series_index:(\d+(\.\d+)?)`, `calibre_series:(.+)`,
  `language:(\w+)`, `publisher:(.+)` (:269-276); leftover tokens are `tags`.
- **XMP** by regex over the raw buffer (:172-244): the exact pattern set of
  :126-149 — nested `calibre:series` (`rdf:parseType="Resource"` + `rdf:value`)
  before flat; `ns0:series_index` before `calibreSI:`; `dc:language` Bag before
  flat; `dc:description` inner `rdf:li` before plain child (the nesting bug the
  comment documents, :137-143); `dc:title`/`dc:creator`/`dc:date`/`pdfx:isbn`
  as pikepdf-file fallbacks. Every value goes through `decodeXmlEntities`
  (:157-166 — hex, decimal, named five, ampersand **last**; shared with
  `metadata::xml_utils`). Precedence after extraction per :296-319 (XMP series
  overrides Subject; XMP series_index overrides Keywords; title/authors/date/
  galleryId only when the docinfo side found nothing).

`pdfx:isbn` regex is `(\d+)` — a non-numeric id simply doesn't match; keep it.

### 5.2 CBZ (extract/cbz.rs)

Port `extractCbzMetadata` (:338-417): stream the root `ComicInfo.xml` entry
(`zip` crate read side is fine here), then `metadata::comicinfo::parse`
(parse side of `src/main/services/comicinfo.ts:59+`, per-field regexes,
entity-decoded). Mapping (:386-410): `seriesName = null` when `series == title`
(:393-396 — never fabricate a one-item series); `seriesIndex` from Number
(legacy Volume too, src/main/services/comicinfo.ts:76-80); `tags = genres + tags`;
galleryId precedence **Web > Notes > filename** (:402-410 —
`nhentai\.net\/g\/(\d+)`, then `nhentai gallery (\d+)` in Notes, then the
filename marker via `extractIdFromFilename` :324-327). Filename fallback runs
in `processFile` when metadata carries none (:779-780).

## 6. Thumbnails (thumbnail.rs)

- Naming: `sha1(absolute_path)[0..16].jpg` inside the thumbnail dir
  (:488-490, :548-549); dir from the caller (`thumbnailDir` param) defaulting to
  `<userData>/thumbnails` (:91); settings override resolution lives in the IPC
  layer (src/main/ipc/library.ipc.ts:215-218). Keep this scheme — the rescan
  path re-derives exactly it (src/main/ipc/library.ipc.ts:200-208), and the *other* scheme
  (`<galleryId>.jpg` @300×400, download workers) shares the dir; do not unify
  (01-current-architecture §7 port note).
- Size/quality: **600×800 `fit: inside`** (never upscale), **quality 82**
  (:479-481). CBZ: first non-`ComicInfo.xml` entry (:504-510). PDF: 1.x shells
  to `pdftoppm -f 1 -l 1 -singlefile -jpeg -scale-to 800` (:553-560); the port
  renders page 1 with the vendored pdfium (F1 resolved option A,
  `scanner::thumbnail::generate_pdf_thumbnail`) and feeds it through the same
  fit-inside/q82 encoder under the same `sha1(path)[0..16].jpg` name.
- **sharp → `image` crate. JPEG re-encode parity is NOT byte-critical.** State
  the tolerance explicitly: thumbnail files are cache artefacts keyed by path;
  the DB stores only the bare filename, and nothing compares their bytes. The
  port's target is *equivalent role*: same dimensions (fit-inside 600×800, no
  upscale), visually comparable quality, deterministic filename. Do not spend
  effort matching mozjpeg bitstreams; if size-per-image drifts materially
  (>2×), revisit with a `mozjpeg` binding, not before. Sanctioned fix: sharp's
  silent catch becomes a loud per-file failure logged and counted, never a
  crash of the scan (07-metadata-spec §12.1).
- `repairThumbnail` (:434-466): on every touched existing row, if the stored
  `custom_cover_path` doesn't resolve on disk, regenerate and write **both**
  columns (`custom_cover_path` + `thumbnail_path`) — they had drifted (:456-462).

## 7. processFile (process.rs)

Port :753-861 in order; the order is observable:

1. Recently-modified skip: mtime < 5 s old → mark completed, skip (:757-764)
   — downloads write files concurrently with the scan.
2. Incremental skip `shouldSkipFile` (:668-687): stat mtime (ms) + size vs
   `library_item.file_mtime`/`file_size` on the relative path; equal → skip.
   **This, not scan_queue, is the incrementality.**
3. Extract (§5) → `galleryId` (metadata, else filename marker, :779-780).
4. Derive row fields: `primaryArtist` = first path segment below root
   (:782-784); `seriesName` = metadata series else directory segment when depth
   ≥ 3 (:785-787); `artists` = metadata authors else `[primaryArtist]` (:788);
   `title` = metadata title else basename minus extension minus a leading
   marker (:790); `isCustom = galleryId ? 0 : 1` (:791).
5. Existence: by `gallery_id` (:797-806) then by `file_path` (:808-815) — both
   update mtime/size, repair thumbnails, mark completed, and return skipped.
6. Thumbnail only when the row (about to be) has none (:818-823).
7. Insert `library_item` (:691-715, exact column set incl. `series_index`,
   `language`, `publisher`, `description`) + artists `INSERT OR IGNORE`
   (:724-728) + `gallery` **stub** upsert when a galleryId exists (:730-742 —
   `{id, media_id, title{pretty}}` shape; the download manager treats that
   shape as a cache miss, 03-download-manager plan §4).
8. Errors: mark failed with message, continue (:855-860).

## 8. The removal pass (removal.rs) — triple guard

The highest-consequence non-metadata test
([04-parity-ledger.md](../04-parity-ledger.md); planning plan §5). Port
:972-1044 exactly; **all three guards are mandatory**:

1. **Unreadable directory** (`walk.failedDirs` non-empty) → skip removal,
   reason names up to 3 dirs (:980-988).
2. **Count collapse:** last `library_scan_log.total_items >= 50` and discovered
   `< 80%` of it → skip (empty-mountpoint backstop), :993-1001.
3. **Resolution blowout:** rows whose stored path no longer resolves `> 20%`
   of all rows → skip (:1022-1028) — catches path-resolution breakage the walk
   count cannot see.

Only when no guard trips: rows absent from the discovered set are deleted with
their artist rows in **one transaction** (:1030-1044 — no FKs exist, artist
cleanup is manual, 03-data-model §5). Always: `library_scan_log` insert
(:1047-1048) and `removalSkippedReason` surfaced in the complete event
(:1053-1056). Simulated-crash/vanished-mount test in §10.

## 9. SQLite connection semantics

1.x opens the worker's **own** connection via `openWorkerConnection()`
(:1070-1071 → src/main/db/connection.ts:500-507): encoding UTF-8, WAL,
`foreign_keys=ON`, `busy_timeout=5000`, concurrent with the main connection
under WAL. Port: one `rusqlite::Connection` owned by the scan task for the
scan's lifetime, pragmas identical; 03-data-model §10.3 wants `busy_timeout`
on every connection regardless. Writes are short transactions; the scanner
never holds a write txn across a pause.

## 10. Pause / resume / cancel and events

State machine `idle | scanning | paused | cancelled` (:79). Port as a
`ScanJob` handle over a `tokio::sync::watch`/`Notify`: `pause` parks the loop
between items (:927-937 — parked *per item*, not mid-file), `resume` releases,
`cancel` un-parks and exits at the next item boundary (:1104-1111), leaving
`scanning` rows for the next run's requeue. Events: `progress` every item
(PROGRESS_INTERVAL = 1, :70, :960-966); `newItems` batched — flush at **25
items or 500 ms**, whichever first (:907-917, :947-950), final flush after the
loop (:970); terminal `complete` carries
`{total, newItems, removedItems, errors, cancelled, removalSkippedReason}`.
Preserve the batching semantics across whatever transport carries the events
(01-current-architecture §3b, [06-technology-decision.md](../06-technology-decision.md) §8).

## 11. Differential tests

Fixture library = a synthesised tree + the real golden corpus paths, both
under `tests/scanner/`:

| Test | Against 1.x | Notes |
|---|---|---|
| Walk rules | same tree scanned by live 1.x (`library:scan`), diff discovered sets | incl. dotfiles, reserved dirs, nested artists, non-PDF/CBZ noise |
| Extraction parity | 1.x scan DB rows vs Rust rows on the golden corpus + PDFs/CBZs with legacy markers, both marker placements, `&amp;` entities, `Series==Title`, Subject-only files | compare row-for-row (title/artist/series/index/language/publisher/description/galleryId/isCustom) |
| Incremental skip | run twice in both; second pass must touch 0 rows | stat-keyed, not queue-keyed |
| newItems batching | event timing capture from 1.x vs Rust | 25/500 ms semantics, final flush |
| Removal guard 1 | chmod-000 subdir mid-tree | removal skipped, reason non-empty, **zero deletions** |
| Removal guard 2 | last log ≥50, discovered <80% (vanished mount simulation: point root at empty dir) | same |
| Removal guard 3 | DB with >20% stale paths vs clean tree | same |
| Removal happy path | delete 1 file of 10 | exactly 1 row + its artist rows deleted, one txn |
| Pause/resume/cancel | scripted control sequences | item-boundary semantics; `scanning` rows survive cancel |
| Crash mid-scan | SIGKILL the Rust scan, re-run | requeue of `scanning`+`failed`; queue wiped at boot test |
| Thumbnail scheme | regenerate on rescan | `sha1(path)[0:16].jpg` @600×800 naming equality; bytes tolerance per §6 |

## 12. Exit criteria

1. Extraction parity table green on all fixtures (row-for-row vs 1.x).
2. All three removal guards proven by the tests above with zero deletions
   asserted; happy-path removal exact.
3. A full scan of the golden corpus produces a DB whose `library_item` /
   `library_item_artist` / `gallery` rows equal a live 1.x scan's rows (field
   comparison, excluding timestamps).
4. Second-scan incrementality: ≥ 99.9% of items skipped by mtime+size, no
   row churn.
5. Scan singleton enforced; pause/resume/cancel at item boundaries only.

## 13. Risks

| Risk | Mitigation |
|---|---|
| walkdir error semantics differ from per-level `readdir` failures (guard 1 blind spot) | dedicated unreadable-dir test at nested depth; fall back to manual recursion if walkdir can't report per-dir failures |
| PDF rasteriser gap (D3) leaves PDF covers missing | loud per-file failures + Q-S4 tracked; do not silently skip |
| mtime units (1.x stores ms via `Date.now()`) vs rusqlite reads | tolerate both units per 03-data-model §10.5; compare as stored |
| `zip` crate accepting archives yazl/yauzl rejects (or vice versa) | golden corpus opens identically in both; malformed-archive test |
| Row-order divergence if the walk is parallelised | §3: single consumer is a documented invariant |
