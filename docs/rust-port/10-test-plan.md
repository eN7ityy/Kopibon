# 10 — Test plan

Golden corpus, diff levels, the differential harness, the Kavita acceptance suite, the mass-delete guard, the
crash/recovery suite, and the test inventory. Implements planning plan §5
(`plans/kopibon_rust_port/00-planning-plan.md:255-278`); the contract being tested is
[07-metadata-spec.md](07-metadata-spec.md); subsystem test tables live in `08-subsystem-plans/01–07` §Tests and
are collected — with IDs and commands — in §7 here. This document is the **spec**; `CHECKLISTS/tests.md` is its
machine-readable mirror (same IDs, one line per test: `ID | level | fixture | command`).

---

## 1. Golden corpus — split in two

### 1.1 LEGACY fixtures — read-only scanner inputs

Files produced by earlier builds. They are **inputs to the scanner and the parse sides only — never writer
targets**. They carry the old Notes string `Tagged by Doujin Downloader — nhentai gallery N` and **both marker
placements** (prefix `[nhentai-00000] Title.pdf` from the custom-entry sanitiser, suffix
`Title [nhentai-528499].cbz` from the download sanitiser). Scanner tolerance is D7
([07-metadata-spec.md](07-metadata-spec.md) §8): the parse side reads both product names; `applyGalleryIdToFilename`
handles either placement; galleryId precedence is Web > Notes > filename marker (02-scanner plan §5.2). Source: a
read-only sample copied from the production library (breadth per [16-open-questions.md](16-open-questions.md) Q5);
legacy Notes are never rewritten unprompted by any path under test.

### 1.2 CURRENT-BUILD fixtures — the writer's byte targets

Captured **fresh from 1.x** across all **12 write paths** ([07-metadata-spec.md](07-metadata-spec.md) §6):
download→PDF, download→CBZ, custom entry→CBZ/PDF, `updateMetadata`, `renameSeries`, `assignSeries`, sync,
`convertAllMetadata`, PDF→CBZ convert, attach/detach id (filename-only), and CLI `rewrite-comicinfo`. Capture
runs each path in a real 1.x build against the disposable clone (Q5) with all volatile fields injectable (07 §9:
clock parameters for `MetadataDate`/`dc:date`-fallback/`calibre:timestamp`/`/CreationDate`/`/ModDate`; mtime
parameters for the ZIP DOS/UT stamps; page order explicit). Each captured artefact is committed with a
provenance manifest (sha256, 1.x version, template set, injected volatile values). The legacy corpus of 1.1 is
explicitly **not** a byte target — the writer always emits the current product string (D7).

### 1.3 The three existing golden fixtures

In `/mnt/bragi/Kavita/DoujinsTest/`, produced by 1.x on 2026-09-05, known good in Kavita (library Doujin-Test, id 6) — 07-metadata-spec §11:

1. `DEMONBANE FANZIN Vol. 1_ DEMONBANE CAUSAL SEQUENCE [nhentai-528499].cbz` — 51 entries (ComicInfo + 50
   pages); one-shot, parody `demonbane` as SeriesGroup, `LanguageISO ja`, legacy Notes string.
2. `Red Crais - Part 1 - [nhentai-527515].cbz` — 36 entries; publisher present (circle as publisher),
   characters, 2-tag+parody Genre.
3. `Kaijou Gentei Omakebon [nhentai-527302].pdf` — 16 pages; Info dict `/Author (shaa)`, pdf-lib `/Creator`,
   7-token `/Keywords`, `/Producer (pikepdf 10.8.0)`, `/Trapped (/False)`; XMP packet 1782 B, no calibre block
   (one-shot).

**Notes-string exclusion (Q11, normative):** the fixtures predate the rebrand, so ComicInfo byte-parity tests
**exclude/normalise the `Notes` line** — every other element is an exact target (07-metadata-spec §11,
[16-open-questions.md](16-open-questions.md) Q11). The current writer string is `comicinfo.template:15` and is
asserted as such against CURRENT-BUILD fixtures instead. All three files are copied read-only into the repo test
area with sha256 provenance before Phase A starts (network-mount risk, 01-metadata-engine plan §10).

---

## 2. The three diff levels

A failing diff is unambiguous because every test names its required level up front
([07-metadata-spec.md](07-metadata-spec.md) §1 is the authority):

| Level | Meaning | Required per artefact |
|---|---|---|
| **byte-identical** | The two artefacts are the same sequence of bytes | `ComicInfo.xml` as written (Notes line excluded per Q11); PDF XMP packet bytes (via the two lxml normalisations, 07 §2); ZIP container on **every structural field** of the S3 list (version-made-by 831, method 0, flags 0x0800/0x0808, UT extra CD-only, external attrs, no comment); page image bytes for DCTDecode sources (S4) |
| **canonically-identical** | Parsed to a canonical form (field→value map, child order normalised) then compared — the pre-agreed fallback if a byte spike had failed; currently **no artefact sits here** (S1/S3 both PASSed) | none today; retained as the D2 escape hatch |
| **semantically-identical** | Values equal after decoding; encoding/container layout may differ | `/Keywords` + Info dict values (D6: the port emits `Producer = "Kopibon 2.x"` and `/Trapped /False` as a name, so the Info dict is semantic by decision, not defect); scanner DB rows field-for-field excluding timestamps; thumbnails role-equivalent (dimensions/quality/deterministic name, not mozjpeg bitstreams — 02-scanner plan §6) |
| — | Whole-PDF bytes | **not a target** (pikepdf rewrites the file; 07 §1) |

The matrix runner reports each failure as `cell(path, artefact): level required X, got Y-diff-at-<offset-or-field>` — a test that cannot name its level does not enter the inventory (§7).

## 3. The differential harness

**JS side** — `tests/differential/harness.mjs` (dev tree, never shipped) imports the **real built 1.x modules**
from `dist/` and executes one op per invocation: `node harness.mjs <op> <context.json>` over `buildComicInfoXml`,
`buildXmpXml`, `buildDocInfo`/`buildKeywordTokens`, `generateCbz`, `applyXmpWithPikepdf`, `parseComicInfoXml`,
`applyGalleryIdToFilename`, `tempSiblingPath`, and the template engine itself (01-metadata-engine plan §8).
**Rust side** — the `kopibon-core` headless CLI exposes the same ops; the runner invokes both, compares at the
required level, and compares **error strings** where JS throws (1-based line numbers are load-bearing, 07 §2).

**Fuzz seeding** — the seed corpus is the existing suites, not invention:

- **26 template cases** from `template-engine.test.ts` (substitution 12, optional lines 6, sections 9, each 4,
  file shape 3 — enumeration in `plans/kopibon_rust_port/discovery-01-metadata.md:383-398`; 07 §2);
- **58 mapper cases** from `mappers.test.ts`, which run against the **real** template files
  (`mappers.test.ts:17-25`; discovery-01 `:399+`) — ComicInfo structure, Kavita field rules,
  LocalizedSeries/StoryArc, context completeness, release date, language, XMP.

On top of the seeds: generated contexts per 01-metadata-engine plan §8 (empty/all-populated, `galleryId` ∈
{absent, 0, 528499}, `seriesIndex` ∈ {absent, 0, 1, 2.5, 1e21}, CRLF/trailing-newline variants, every XML-escape
and illegal-char input) and generated templates over random nesting/`?` markers/context shapes. **Minimum 10k
cases per CI run; nightly 1M soak; any mismatch shrinks to a fixed vector.**

**Sibling harnesses** — `tests/differential/db_harness.mjs` (better-sqlite3 vs rusqlite on a byte copy of the
production DB, 05-DB plan §8) and the scanner differential (live 1.x `library:scan` vs the Rust scan on the same
tree, 02-scanner plan §11). Sync/download/conversion run against a shared fixture nhentai server modelling
Retry-After, 429s and CDN rotation identically on both sides (03/04/06/07 plans).

## 4. Kavita acceptance suite — verified environment (Q8)

Binding facts, resolved in [16-open-questions.md](16-open-questions.md) Q8 (`16-open-questions.md:74-81`) and
recorded in [08-subsystem-plans/07-sync-and-kavita.md](08-subsystem-plans/07-sync-and-kavita.md) §6:

- **Server:** `http://kavita.bragi.internal` **port 80**, unversioned `/api/...` routes (the proxy injects the
  version segment; **never** use `:8080`). Auth: header **`x-api-key`** with the plugin key from
  `plans/kopibon_rust_port/kavita_server.txt`. **Kavita version unknown (Q1, open)** — read it off the UI once
  and pin it here before the suite is declared normative.
- **Test library:** `Doujin-Test`, **id 6** → `/kavita/doujinstest` = `/mnt/bragi/Kavita/DoujinsTest`;
  `lastScanned` `0001-01-01` (clean slate); folder-watching **on**. All mutation tests run inside id 6 only.
- **Production library:** `Doujins`, **id 5 (5287 files)** shares the server and **MUST NEVER be scanned,
  mutated or deleted**. Every mutating helper takes a library id and refuses id 5; the suite harness asserts
  id 5's file count (`/api/Stats/server/stats` → `chapterCount`, plus the per-library series count via
  `/api/Library/libraries`) **before and after every test** — a single changed count fails the whole run.

**Endpoints exercised** (all cited to `src/main/services/kavita-client.ts`):

| Endpoint | Client fn | Cite |
|---|---|---|
| `GET /api/Account` | `testConnection` (never throws) | kavita-client.ts:255-272 |
| `GET /api/Library/libraries` | `getLibraries` | :281-297 |
| `GET /api/Stats/server/stats` | `getItemCount` (60 s cache) | :306-338 |
| `POST /api/Library/scan-folder` `{folderPath, apiKey}` | `scanFolder` (key also in body) | :356-376 |
| `POST /api/Series/scan` `{seriesId, libraryId}` | `scanSeries` | :403-419 |
| `GET /api/Search/search?queryString=` | `searchSeries` | :429-448 |
| `GET /api/Series/{id}` | `getSeries` | :456-492 |
| `GET /api/Series/volumes?seriesId=` | `findChapter` | :544-589 |
| `DELETE /api/Series/{id}` | `deleteSeries` | :597-608 |
| `POST /api/Series/delete-multiple` | `deleteMultipleSeries` | :615-632 |

**Assertions — before and after the mutation suite, including the negatives:**

1. **New downloads must NOT trigger a scan** — the Kavita hook in the download-complete path stays disabled
   (`download-manager.ts:748-755`; 03-download-manager plan §4.8): Kavita's folder-watching owns discovery.
   Assert: a download completes → no `scan-folder` request observed, id 6 counts change only via the watcher.
2. **`updateMetadata` triggers a scan only when the item is in a series Kavita already knows** — assert the
   `scan-folder`/`scan-series` POST fires (with the **translated Kavita path** and `apiKey` in the body; assert
   the request body, not just the 200) for a known-series member, and does **not** fire for a one-shot Kavita
   has not grouped.
3. **`assignSeries` always triggers a scan** (07-sync plan §7).
4. **Delete mirroring** — Q7 decision: implement `library:itemDeleted` (emitted 3× with no subscriber in 1.x,
   `library.ipc.ts:1613, :1668, :1702`); `deleteFile` with Kavita configured deletes the **exact-name** series
   only (`requireExactMatch`, `deleteItemsFromKavita` kavita-client.ts:650-674, `:690-708`); **negative**: no
   exact-name hit → skipped with the warn log, id 6 series count unchanged — an unrelated series' reading
   progress must never vanish on a substring collision. Batch delete → one `delete-multiple` with the deduped
   id set.
5. **Server negatives:** wrong key → `{ok:false}` from `testConnection`; unreachable host → every
   fire-and-forget path swallows and the file operation still succeeds; `getItemCount` cache behaviour (hit
   within 60 s, invalidated by scan/delete, null when disabled).

## 5. The mass-delete guard — highest-consequence non-metadata test

The scanner's removal pass (`library-scanner.worker.ts:972-1044`; 02-scanner plan §8) is triple-guarded; the port must prove **all three guards, with zero deletions asserted**:

| # | Guard | Simulation | Assert |
|---|---|---|---|
| 1 | Unreadable directory (`failedDirs` non-empty) | `chmod 000` on a nested subdir mid-tree; also root unreadable-but-existing | removal skipped, `removalSkippedReason` names up to 3 dirs, **zero deletions** |
| 2 | Count collapse (last `library_scan_log.total_items ≥ 50`, discovered < 80%) | **vanished network mount**: point the library root at an empty dir (the mount's post-failure view) | same — this is the empty-mountpoint backstop |
| 3 | Resolution blowout (> 20% of rows' stored paths unresolvable) | DB seeded with > 20% stale `file_path`s against a clean tree | same |

Plus the **happy path**: delete exactly 1 of 10 files → exactly that row and its artist rows deleted, one
transaction, `library_scan_log` written. The test runs on the synthesised tree **and** on a disposable clone of
the golden corpus (never the real mount). Nested-depth `chmod 000` is mandatory — walkdir's per-level error
reporting is the flagged risk (02-scanner plan §13); if walkdir cannot report per-dir failures, manual recursion
is the fix, never a weaker guard.

## 6. Crash/recovery suite — SIGKILL mid-batch, per queue

Every kill test runs under `SIGKILL` at a scripted point, reboots the port, and asserts the recovery sequence —
**twice in a row** (idempotent reconcile). 1.x semantics are the contract (03-data-model §6):

| Queue | 1.x recovery contract | Kill point / assert |
|---|---|---|
| Download queue | `reconcileInterrupted()` at boot **before the pump** (`download-manager.ts:271-290`, `index.ts:189`): every `downloading`/`converting` row → `queued`, `started_at`/`error_message` nulled, `download_page` rows deleted, scratch dir purged | mid-`downloading` and mid-`converting`; after reboot: rows re-queued, no `download_page` orphans, `download-tmp/` empty, the download completes |
| Conversion queue | atomic `claimNext` (`UPDATE…RETURNING`, `conversion.repo.ts:69-88`); boot resets `'converting'→'pending'` only — table **not** wiped (`startup-maintenance.ts:74-76`); resume skips enqueue; per-row `keep_original` honoured, not the setting | 3 of 12 items in flight; after reboot + `resume:true`: remaining items complete, no orphaned `<userData>/convert-cbz/*`, no double-CBZ, per-row keep_original proven by flipping the setting between runs |
| Sync queue | strictly serial, one claim at a time (`library.ipc.ts:2596-2599`) — a crash strands **exactly one** `'syncing'` row; `requeueInterrupted()` at boot (`sync.repo.ts:107-114`) feeds the resume banner (`library:getSyncQueue` → resume with empty ids) | mid-rewrite; after reboot: exactly one stranded row, requeued, resume completes it; banner counts describe this run |
| `convertAllMetadata` | 1.x is **non-resumable** — in-memory `items[queueIndex++]` (`library.ipc.ts:2094-2100`), the one long job with no queue table | **Port deviation (Q6, default resumable):** the port adds a DB-backed `metadata_queue` — a P2 ledger row is required (06-conversion plan §5). Kill mid-run → resume finishes the remainder; the test documents that 1.x would have restarted from scratch |
| In-place rewrite safety | the killed sync/metadata worker must never tear an archive: every rewrite goes through `temp_sibling_path` + atomic rename (01-metadata-engine plan §5) | injected slow writer + SIGKILL mid-write: the on-disk file is either the old complete file or the new complete file — never partial; the temp sibling is cleaned on next boot |

Also covered: scan crash (queue wiped at boot, `scanning`/`failed` rows requeued, mtime+size skip makes the
re-run incremental — 02-scanner plan §10/§11) and boot-maintenance ordering (wipe `download_page` + `scan_queue`,
reset conversions, prune completed downloads, orphan sweep, sync requeue, series relink — 03-data-model §10.7).

## 7. Test inventory

Every test has **ID | suite | level | fixture | command** — all four, no exceptions (the corpus checker verifies
`CHECKLISTS/tests.md`, which mirrors this table one line per test). Representative rows; the checklist is the complete list:

| ID | Suite | Level | Fixture | Command |
|---|---|---|---|---|
| TA-01 | Template differential (26 seeds) | byte + error strings | inline seeds | `cargo test --test template_differential` |
| TA-02 | Template fuzz (10k/run; nightly 1M) | byte | generated | `cargo test --test template_fuzz -- --ignored` |
| MA-01 | Mapper differential (58 cases, real templates) | byte | CURRENT-BUILD contexts | `cargo test --test mapper_differential` |
| WR-01 | Field × mutation matrix (12 paths × 4 artefacts) | per §2 | golden 1–3 + CURRENT-BUILD | `cargo test --test differential_matrix` |
| WR-02 | XMP packet round-trip (S1) | byte | fixture 3 (1782 B) | `cargo test --test pdf_writer -- xmp` |
| WR-03 | ZIP structural checklist (S3) + Python zipfile CRC | byte | fixture 1 rebuild | `cargo test --test zip_writer` && `python3 tests/zip/validate.py out.cbz` |
| FN-01 | Sanitiser triplet + 251–255-byte Japanese boundary | byte | filename vectors | `cargo test --test filenames` |
| SC-01 | Scanner row-for-row vs live 1.x scan | semantic | golden + LEGACY | `cargo test --test scanner_differential` |
| SC-02 | Removal triple guard (3× zero deletions + happy path) | invariant | synth tree + clone | `cargo test --test removal_guard` |
| DB-01 | Migration zero-surprise on production copy | invariant | prod-DB byte copy | `cargo test --test db_differential migration` |
| DB-02 | Read parity over filter × sort matrix | semantic | prod-DB byte copy | `cargo test --test db_differential read` |
| DL-01 | Download pipeline vs 1.x, scripted CDN/failure ladder | semantic + byte artefacts | fixture server | `cargo test --test download_differential` |
| CV-01 | Golden PDF→CBZ conversion + verify gate both ways + pdfium lossy fallback (count guard → 3 JPEGs, method pdfium) + rasteriser-absent loud failure | byte | fixture 3 | `cargo test --test conversion` + `cargo test --test raster_absent` |
| SY-01 | Sync retry/pacing/cancel vs 1.x on scripted gallery | semantic | fixture server | `cargo test --test sync_differential` |
| KV-01 | Endpoints + scan-trigger positives/negatives (§4.1–4.4) | invariant | Doujin-Test (id 6) | `cargo test --test kavita_acceptance -- --ignored` |
| KV-02 | Production-library protection (id 5 counts before/after) | invariant | server | embedded in `kavita_acceptance` harness pre/post hook |
| CR-01 | SIGKILL mid-batch, all four queues (§6) | invariant | clone + scratch dirs | `cargo test --test crash_recovery -- --test-threads=1` |
| BR-01 | 144-channel contract suite (130 + 14 events) | invariant | — | `npm run contract:bridge` |
| UI-01 | Ledger rows per route (§ checklist sign-off) | P0/P1 per row | golden library | `CHECKLISTS/ui-parity.md` walk + `npm run contract:bridge` |
| IM-01 | Import matrix + non-destructive sha256 (09 §D) | invariant | scripted 1.x profile | `cargo test --test import_matrix` |

## 8. Rules

1. No test reads the wall clock; volatile fields are injected per 07 §9. A test needing "now" fails review.
2. No test touches: production library id 5, the live production DB, the 1.x install, or the real
   `/mnt/bragi/Kavita/DoujinsTest/` mount as a write target (clone or repo copy only).
3. Fixtures carry provenance (sha256, origin, capture method) and are committed read-only; a drifted fixture is
   a corpus bug, not a test failure to chase.
4. `CHECKLISTS/tests.md` must be regenerable from this document's table — the checker asserts
   ID/level/fixture/command presence for every row.
5. Every behaviour change discovered by a failing test goes through the ledger §9 deviation process
   (04-parity-ledger) — never a silently relaxed assertion.
