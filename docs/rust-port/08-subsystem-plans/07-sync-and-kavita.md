# Subsystem plan 07 — Sync and Kavita (`kopibon-core::sync`, `kopibon-core::kavita`)

Execution plan for the nhentai metadata sync (`src/main/services/sync.worker.ts`,
209 lines + the batch pump in `src/main/ipc/library.ipc.ts:2460-2696`) and the
Kavita client (`src/main/services/kavita-client.ts`, 742 lines). Built
headless in Phase A; the Kavita acceptance hooks feed
`10-test-plan.md`. Contract sources: [03-data-model.md](../03-data-model.md)
§6.4 (sync_queue machine), [02-ipc-surface.md](../02-ipc-surface.md) §2.6/§2.12/§5.4
(channel contracts), [16-open-questions.md](../16-open-questions.md) Q7/Q8.
Citations are to `src/main/` unless marked.

---

## 1. Module boundaries

```
kopibon-core/src/sync/
├── mod.rs      // SyncJob: serial pump over sync_queue, pacing, cancel-after-current
├── worker.rs   // fetchGallery + metadata rebuild (port of sync.worker.ts)
└── events.rs   // library:syncProgress / syncComplete + notifier sink traits

kopibon-core/src/kavita/
├── mod.rs      // KavitaClient: request core, endpoints (§5)
├── config.rs   // read_config, is_configured, decrypt boundary
└── paths.rs    // translate_to_kavita_path
```

`sync` depends on `metadata` (`apply_metadata` — the in-place rewrite),
`nhentai` ([04-nhentai-client.md](04-nhentai-client.md) — the rate limiter)
and `db`. `kavita` depends only on `db` (settings) + `reqwest`; it is
fire-and-forget by contract and never blocks a file operation's outcome.

## 2. The sync worker (`worker.rs`) — port of `sync.worker.ts`

One item per invocation: fetch the gallery from the API, rebuild canonical
metadata, rewrite the archive **in place**.

1. **Fetch with retry** (`:41-80`): up to **3 attempts** (`MAX_RETRIES :39`);
   `User-Agent: DoujinDownloader/1.0 (eN7ityy)`, `Authorization: Key {apiKey}`
   when a key is stored (`:43-46`). A **429 is not an attempt**: it reads
   `Retry-After` (default 5), sleeps `retryAfter*1000 + 0..1000 ms` jitter,
   and `continue`s — the loop can extend indefinitely by design
   (`:52-60`). Other failures log per-attempt ("attempt 1/3 …") and back off
   `2000 + attempt*1000` ms (`:62-76`).
2. **Metadata rebuild** (`:88-142`): title = pretty → english → `Gallery #id`;
   language resolved by **priority from all language-type tags**, not the
   first (`:100-104`); publisher = first group; creators = artists → groups →
   `['Unknown']`; `file_metadata_from_gallery` with **seriesName/seriesIndex
   from our own DB** — nhentai has no series; omitting it silently dissolved
   series members on sync (`:27-37, :128-142`).
3. **In-place rewrite** — one `apply_metadata` call branches on format
   (ComicInfo rewrite for CBZ, XMP for PDF) (`:146`); failure posts
   `error` with the mapper's message (`:148-159`). **The archive is rewritten
   in place; a killed worker mid-write corrupts the file** — this is the
   reason cancel never terminates an in-flight sync (§3).
4. **Post back** — success carries: typed `rawTags` (`{id,type,name}`,
   `:180-184`), **the whole API response** as `gallery` (`:190-195` — sync
   used to post tags only and 837 rows stayed permanently poorer), and the
   flat `metadata` payload `{title, primaryArtist, tags, language,
   publisher}` (`:196-202`).
5. **Main-side commit** (port into `mod.rs`, `library.ipc.ts:2312-2399`):
   library row updated with the flat metadata; **page count re-derived from
   the rewritten file** (`:2324-2328`); the cached `gallery` row upserted with
   rawTagsJson + every field the response carried (mediaId, titles, pageCount,
   favoritesCount, uploadDate, thumbnail/cover URLs, rawJson)
   (`:2356-2394`). All best-effort: a commit failure must not fail the sync
   result (`:2397-2399`). Settle-once semantics (`:2273-2278`) and the
   exit-backstop ("Sync worker stopped before it reported a result",
   `:2439-2445`) collapse into a `JoinHandle` but keep their one-settle rule.

## 3. The batch pump (`mod.rs`) — port of `library:syncBatch`

`library:syncBatch` is bound twice (`src/preload/index.ts:219, :226`) — as
`syncBatch(ids)` and as `resumeSync()` invoking with `[]`. One operation,
`ids: Option<Vec<i64>>` ([02-ipc-surface.md](../02-ipc-surface.md) §4.3).

- **Queue lifecycle** (03-data-model §6.4): `ids.length > 0` → fresh batch:
  `clearFinished()` then `enqueue(ids)` (`library.ipc.ts:2552-2555`); empty →
  **resume** whatever is pending. `total = pending + syncing` (`:2557-2558`).
- **Strictly serial, one claim at a time** (`:2596-2599`): a crash strands
  exactly one `'syncing'` row for startup to requeue. No runner pool — N
  runners would buy nothing at 40 items/min and would break pacing.
- **Guards per item** (`:2603-2613`): missing row, no `galleryId`, already
  syncing, or conversion-locked → `finish(itemId, 'No nhentai id, or the file
  is in use')` + failed count, continue.
- **Pacing at 90 %** (`:2577-2580`): `target = max(1, floor(limit * 0.9))`
  where `limit = endpointLimitPerMinute('gallery', hasKey)`
  (`rate-limiter.ts:181` — 20/min anonymous, 45/min keyed);
  `intervalMs = ceil(60_000 / target)`. **The sleep counts the item's own
  work**: only the *remaining* part of the interval is slept, so a 30 MB CBZ
  rewrite (~1 s) is not paid twice (`:2650-2659`). Port the same
  work-counts-against-the-interval behaviour with an interval start timestamp.
- **Cancel is cooperative** (`:2522-2526`, `:2235-2246`): the flag is checked
  before the next claim; the in-flight item is **allowed to finish** — the
  worker is never terminated mid-rewrite. Progress after every item
  (`current, total, title, etaSeconds` `:2631-2648`), `library:syncComplete`
  at the end (`:2662-2669`), and an OS notification whose cancelled wording
  reports what was attempted, not the batch size (`:2671-2685`).
- **Return** `{succeeded, failed, total: ids.length}` (`:2687-2694` — note
  `total` is the *requested* batch size, not `pending+syncing` on resume;
  port as-is).

**sync_queue lifecycle / resume banner.** `requeueInterrupted()`
(`sync.repo.ts:107-114`, `'syncing'→'pending'`, `started_at = NULL`) runs at
startup (`startup-maintenance.ts:131-135`). `library:getSyncQueue`
(`library.ipc.ts:2505-2515`) returns counts + `outstanding` + `recentErrors(5)`
— the **ResumeSyncBanner contract**: the renderer offers "resume" whenever
`outstanding > 0`, and `resumeSync()` (empty ids) continues; "discard" is
`library:clearSyncQueue` (`:2518-2520`, wipes pending too,
`sync.repo.ts:125-128`). `library:syncItem` (`:2460-2494`) is the single-item
path: refuses `'Already syncing'` / `'No nhentai ID'`, bypasses the queue.
Timestamps: claim/finish wrote `Date.now()` ms in 1.x (`sync.repo.ts:64, :75`)
— the port writes seconds per 03-data-model §10.5 and tolerates ms on read.

## 4. Sync-pump tests

| Test | Asserts |
|---|---|
| Retry ladder | fixture server: 500,500,200 → success; 3 failures → error with per-attempt logs; 429 with `Retry-After: 7` → sleep ≈7–8 s and **not** counted against MAX_RETRIES (429×5 then 200 still succeeds); default Retry-After when header missing |
| Pacing | keyed vs anonymous limits; measured inter-item interval ≥ `intervalMs` with the work time subtracted; floor(target,1) at tiny limits |
| Serial claim | crash (SIGKILL) with one item in flight → exactly one `syncing` row after reboot; `requeueInterrupted` + resume completes it; counts after resume describe this run |
| In-place rewrite safety | kill the process mid-rewrite (injected slow writer) → the file is *not* torn by design constraints to check: assert the port's write path keeps the temp-sibling/rename guarantees of `metadata::writers` (01-metadata-engine §5) |
| Cancel-after-current | cancel flag set during item k → k completes and is counted, k+1 never claims, notification wording `Stopped after X of Y` |
| Post-back commit | sync of a stub gallery row enriches it to download-standard (rawJson, titles, favourites, URLs); page count re-derived after rewrite; commit failure leaves the sync reported successful |
| Series preservation | syncing a series member keeps `series_name`/`series_index` in the written ComicInfo (the dissolve regression) |
| Banner contract | getSyncQueue outstanding/errors shapes; clearSyncQueue wipes pending; resumeSync with empty queue returns zeroed totals |

## 5. `kavita/` — port of `kavita-client.ts`

Thin, stateless client; config read from settings **at call time** so a save
takes effect on the next call (`:10-12, :155-163`). Auth is the `x-api-key`
header (Kavita plugin key), never a Bearer token (`:14-16, :201-204`);
10 s timeout per request (`:116, :214-227`); 204/empty bodies resolve to
`None` (`:237-247`).

Endpoints (all cited to `kavita-client.ts`):

| Endpoint | Method | Client fn | Notes |
|---|---|---|---|
| `/api/Account` | GET | `testConnection` `:255-272` | in-band `{ok, version, username}`; **never throws** |
| `/api/Library/libraries` | GET | `getLibraries` `:281-297` | throws → IPC envelope; type-enum → label map `:46-53` |
| `/api/Stats/server/stats` | GET | `getItemCount` `:306-338` | `chapterCount` as the file count; 60 s cache `:127-133`, invalidated by scans/deletes `:344-346`; never throws, null hides the status-bar figure |
| `/api/Library/scan-folder` | POST | `scanFolder` `:356-376` | **key also in the body** `{folderPath, apiKey}` (`:361-368`); path translated first (§5.1); fire-and-forget |
| `/api/Series/scan` | POST | `scanSeries` `:403-419` | `{seriesId, libraryId}`; fire-and-forget |
| `/api/Search/search?queryString=` | GET | `searchSeries` `:429-448` | series-array of the grouped response; failure → `[]` |
| `/api/Series/{id}` | GET | `getSeries` `:456-492` | null on unreachable/gone; format-enum map `:59-65` |
| `/api/Series/volumes?seriesId=` | GET | `findChapter` `:544-589` | basename match over chapter files → chapterId/label/count |
| `/api/Series/{id}` | DELETE | `deleteSeries` `:597-608` | fire-and-forget |
| `/api/Series/delete-multiple` | POST | `deleteMultipleSeries` `:615-632` | positive-integer filter `:616` |

Derived operations: `findSeriesDetail` (`:500-535`) — search by **series name
first**, item title as fallback (a member is indexed under the series name),
exact-NOCASE match preferred over first hit, then chapter resolution;
`scanSeriesForLibraryItem` (`:720-733`) — first-hit fallback acceptable (a
rescan is idempotent); `deleteItemsFromKavita` (`:650-674`) —
**`requireExactMatch = true`** (`:690-708`): Kavita's search is substring, so
"no exact hit" must mean *skip and log*, never "delete the first hit" — an
unrelated series' reading progress must not vanish because a word collided.

### 5.1 Config and paths

- `isConfigured()` (`:178-182`): `kavitaEnabled === 'true'` **and** url+key+
  libraryId all present — the checkbox genuinely gates every write path (it
  did not always; the comment `:168-176` records why the test-connection
  calls bypass it with their own overrides).
- Overrides: the four `kavita:*` IPC channels take optional `(url, apiKey)`
  so the settings pane tests **unsaved** form values (`kavita.ipc.ts:12-16`,
  `:17-24`); the persisted key is decrypted in `readConfig`
  (`:150-154`) — the one reader bypassing the IPC encryption layer.
- `translateToKavitaPath` (`paths.rs`, `:387-396`): re-root the app-side path
  from `libraryPath` onto `kavitaLibraryRoot` (two mounts, same files);
  outside-root or missing roots → input unchanged; trailing-slash strip on
  all three inputs.

### 5.2 The delete-mirroring gap (Q7)

`library:itemDeleted` is emitted 3× with **no preload subscriber**
(`library.ipc.ts:1613, :1668, :1702`; [02-ipc-surface.md](../02-ipc-surface.md)
§4.1). Kavita delete mirroring is driven by the delete handlers themselves
(fire-and-forget `deleteItemsFromKavita`, gated on `isConfigured()`,
`:1618-1627`; `alsoFromKavita` on the row-only variant because the file
stays and a scan would re-add it). **Port decision per
[16-open-questions.md](../16-open-questions.md) Q7 recommendation: implement
the event** — `sync`/`kavita` emit `library:itemDeleted {id, galleryId}` to
all consumers on delete/deleteMultiple/deleteFileMultiple — so Phase B's
renderer can invalidate search results and a future consumer exists; do not
reproduce the dead surface faithfully.

## 6. Verified test-server facts (Q8, binding for tests)

From [16-open-questions.md](../16-open-questions.md) Q8 and
`plans/kopibon_rust_port/kavita_server.txt`: base `http://kavita.bragi.internal`
(port 80, unversioned `/api/...`), auth = the plugin key in `x-api-key`;
library **Doujin-Test (id 6)** → `/kavita/doujinstest` (= `/mnt/bragi/Kavita/DoujinsTest`),
`lastScanned` 0001-01-01 (clean slate), folder-watching on. **Production
library `Doujins` (id 5, 5287 files) shares the server — no test may scan,
mutate or delete it.** All mutation tests run inside Doujin-Test only; the
suite asserts library id 6 before and after and never resolves a series in
id 5. Server version is Q1 (open) — pin it when read off the UI.

## 7. Kavita acceptance hooks (for `10-test-plan.md`)

The Rust test binary exposes the same operations 1.x does so the acceptance
suite drives either build identically:

| Hook | Before/after assertion |
|---|---|
| `updateMetadata` on an item in a known series | series `pages`/`lastChapterAdded` unchanged or rescan requested only per the handler; **negative**: new downloads alone trigger **no** scan |
| `assignSeries` / `renameSeries` | scan-folder POST observed with the translated Kavita path (assert the request body, not just the 200) |
| `deleteFile` with Kavita configured | exact-name series deleted; **negative**: item with no exact-name match is skipped with the warn log, library id 6 item count unchanged |
| `deleteMultiple` batch | one `delete-multiple` call with the deduped id set |
| `getItemCount` | cache hit within 60 s; invalidated after scan/delete; null when disabled |
| Server negatives | wrong key → testConnection `{ok:false}`; unreachable host → all fire-and-forget paths swallow and the file operation still succeeds |

## 8. Exit criteria

1. Sync differential suite green against a fixture nhentai server (retry
   ladder, pacing, cancel, crash-strand-one-row) with payload shapes equal
   to 1.x on the same scripted gallery.
2. sync_queue lifecycle: enqueue/claim/finish/requeueInterrupted/clear parity
   with `sync.repo.ts`; resume-banner contract matches
   [02-ipc-surface.md](../02-ipc-surface.md) §5.4.
3. Kavita client: all ten endpoints exercised against the Doujin-Test server
   with request-shape assertions (body `apiKey` on scan-folder, translated
   paths); delete path proven to never act without an exact match.
4. Production library (id 5) untouched across the whole suite — asserted by
   comparing its item count before/after every run.
5. `library:itemDeleted` emitted by the three delete paths (Q7 decision
   landed; ledger note if 02-ipc-surface §4 needs the amendment).

## 9. Risks

| Risk | Mitigation |
|---|---|
| Kavita version drift (Q1 unresolved) changes endpoint behaviour | acceptance suite pins the version once read; endpoint table cites exact routes so a diff is mechanical |
| Tests touching the production library | every mutating helper takes the library id and refuses id 5; before/after count assertion in the suite harness |
| In-place rewrite interrupted by a process kill | `apply_metadata`'s temp-sibling + atomic rename (01-metadata-engine §5) is the actual guard; the mid-rewrite kill test asserts it holds |
| Pacing drift vs the shared rate limiter | sync paces itself from `endpointLimitPerMinute` and never shares the limiter instance (1.x comment `:2564-2576`); document that user-driven browsing during a batch may still 429 — the retry ladder absorbs it |
| `translateToKavitaPath` on Windows drive roots | `relative` semantics differ; test with the platform rules noted in 05-database-layer §10 |
| Encrypt/decrypt boundary (app-level AES for `kavitaApiKey`) | port `decryptKey` verbatim with the plaintext-passthrough fallback (settings.ipc.ts:34, auth.ipc.ts:26-36); golden-vector test with a 1.x-encrypted value |
