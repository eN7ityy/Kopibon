# Subsystem plan 05 — Database layer (`kopibon-core::db`)

Execution plan for the rusqlite port of `src/main/db/` (connection, migrator,
9 repositories), built first in Phase A because every other subsystem sits on
it. The **normative contract is [03-data-model.md](../03-data-model.md)** —
schema (§2), state machines (§6), settings (§7), repository inventory (§8),
search behaviour (§9) and the ten port rules (§10) live there and are cited,
not restated. Supporting: [01-current-architecture.md](../01-current-architecture.md)
§4, S6 spike evidence ([06-technology-decision.md](../06-technology-decision.md)
§1), [05-baselines.md](../05-baselines.md) §5 (parity over numbers). All
`path:line` citations are to `src/main/` unless marked.

---

## 1. Module boundaries

One module subtree in `kopibon-core`, mirroring `src/main/db/repositories/`
one-to-one so a reviewer can diff method-for-method against
[03-data-model.md](../03-data-model.md) §8:

```
kopibon-core/src/db/
├── mod.rs          // Db handle, open(), close(), re-exports
├── connection.rs   // path resolution, pragmas, connection management (§4)
├── migrator.rs     // runMigrations port: DDL + guarded ALTERs + sentinels (§3)
├── seed.rs         // seedDefaults port (03-data-model §7.1)
├── settings.rs     // typed wrapper over app_settings (§5)
├── search.rs       // buildLibraryFilter port (§6)
├── library.rs      // library.repo.ts   (898 lines, 34 methods)
├── series.rs       // series.repo.ts    (409)
├── download.rs     // download.repo.ts  (132)
├── conversion.rs   // conversion.repo.ts (157)
├── sync.rs         // sync.repo.ts      (129)
├── blocked.rs      // blocked.repo.ts    (110)
├── tag_cache.rs    // tag-cache.repo.ts  (74)
├── gallery.rs      // gallery.repo.ts    (47)
└── maintenance.rs  // startup sweep port (src/main/services/startup-maintenance.ts:52-143)
```

Dependency rule: `db` depends on nothing above it; consumers (scanner,
download, conversion, sync, the future binary) take `&Db`. Drizzle vs raw
better-sqlite3 (03-data-model §8) is irrelevant in Rust — every repo is plain
SQL against the same handle; the two raw repos exist in 1.x only because
`UPDATE…RETURNING` was needed (`connection.ts:96-102`).

## 2. Crates

| Need | Crate | Notes |
|---|---|---|
| SQLite | `rusqlite` with the `bundled` feature | S6 proved the bundled build opens the production DB (06-technology-decision §1). Bundled pins SQLite ≥ 3.35, which `RETURNING` requires — do not build against a system libsqlite3 older than that |
| Pool | `r2d2` + `r2d2_sqlite` | read connections (§4); or hand-rolled `Mutex<Vec<Connection>>` if the dependency is unwanted — the policy matters, not the crate |
| Time | `jiff` | `unixepoch()` equivalents written as SQL defaults, not Rust clocks (§7) |

## 3. The migrator — the one component that must be exact

`migrator.rs` is a line-for-line port of `runMigrations()`
(`connection.ts:146-405`). [03-data-model.md](../03-data-model.md) §10.1 is the
checklist item; implementation notes:

1. **DDL block verbatim** — all 14 `CREATE TABLE IF NOT EXISTS` statements
   (`connection.ts:147-308`), the two inline `UNIQUE` queue keys
   (`scan_queue.file_path` `:252`, `conversion_queue.file_path` `:262`,
   `sync_queue.library_item_id` `:288`), then the three collation indexes as
   separate statements exactly because they carry `COLLATE NOCASE`
   (`:319, :325-328, :331`). Copy the SQL strings; do not re-derive them from
   `schema.ts` (03-data-model §3: the Drizzle file is decorative and already
   wrong — `output_format` default `'cbz'` vs DDL `'pdf'` `schema.ts:100` vs
   `connection.ts:211`, module-load `Date.now()` defaults, missing
   `conversion_queue`/`sync_queue` entirely).
2. **PRAGMA-guarded ALTERs** — port the `PRAGMA table_info` checks
   (`connection.ts:334-394`): `library_item` gains 8 columns (`file_mtime`,
   `thumbnail_path`, `series_index`, `language`, `publisher`, `description`,
   `series_id`, `page_count`), `series` gains `is_dissolved`
   (`:364-367`), `conversion_queue` gains `library_item_id` + `keep_original`
   (`:386-391`). Each is a no-op on any DB that already has the column. In
   Rust this reads `PRAGMA table_info(<t>)` into a `HashSet<String>` per table
   before the ALTER block — same shape, same order.
3. **The two `_migrated_*` sentinels, key strings verbatim**
   (03-data-model §7.3): `_migrated_cover_paths` (`connection.ts:413, :435-437`)
   and `_migrated_file_paths` (`:445, :490-492`). Port `migrateCoverPaths`
   (`:411-438`) and `migrateFilePaths` (`:444-493`) including their exact
   corner rules: files outside the library root keep absolute paths, no
   library root set → **skip and retry on a later boot** (do not write the
   sentinel, `:450`), the trailing-`..` guard `:464`, and the queue tables
   migrated after `library_item` (`:471-488`).
4. **Zero-surprise guarantee.** On an already-migrated 1.x DB the whole
   function must execute only `IF NOT EXISTS` / no-op statements. The test in
   §8 asserts `sqlite_master` text is unchanged across a Rust open of the
   production copy.

**Verified production snapshot facts** (S6, recorded in
[06-technology-decision.md](../06-technology-decision.md) §1 and
[05-baselines.md](../05-baselines.md) §2): WAL journal mode, `integrity_check`
ok, **5261 `library_item` rows**, all 14 tables, the `COLLATE NOCASE` indexes
present, and **mixed ms/s timestamps confirmed live** (03-data-model §10.5
lists the five writers that produced ms rows). The migrator tests run against
a byte copy of this DB — never the live one.

## 4. Connection management — port decision

1.x: one synchronous better-sqlite3 connection in main (all IPC handlers run
serialized on the main thread) plus one connection **per worker thread** via
`openWorkerConnection()` (`connection.ts:500-507`) with
`busy_timeout = 5000` (`:505`) — while the main connection sets no busy
timeout at all (`:79-81`, an accident per 03-data-model §1).

**Port decision: WAL + a read pool + one serialized write path, with
`busy_timeout = 5000` on every connection.** Concretely: `Db` owns a
`Mutex<Connection>` reserved for writes (queue claims, row updates,
maintenance) and a small pool of read connections for queries; every
connection sets `journal_mode = WAL`, `foreign_keys = ON`, `synchronous`
left at SQLite's WAL default. Justification: WAL gives one writer plus
concurrent readers — exactly the 1.x topology (main + N workers) without the
threads; the two atomic claims are single-statement write transactions, so
serializing writes through one mutex cannot deadlock or lose the
"exactly one runner" property, and busy_timeout remains as the backstop for
the seconds-long maintenance transaction (`startup-maintenance.ts:65-102`)
starving a worker's claim, which WAL does *not* prevent (writer/writer).
Rusqlite `Connection` is `!Sync`, so handlers call the DB through
`tokio::task::spawn_blocking` — state this in the module docs so nobody
"fixes" it with an async wrapper. The single-writer rule is also what lets
[03-download-manager.md](03-download-manager.md) §3 keep its single-scheduler
invariant unchanged.

## 5. Settings — typed wrapper over `app_settings`

`settings.rs` wraps the raw key/value store (`settings.repo.ts:9-49`) with
typed accessors for every key in 03-data-model §7.1–§7.2, e.g.
`library_path() -> Option<&str>` (default `''` means *unset* —
`connection.ts:124-127`), `download_concurrency() -> u32` (clamp 1–8),
`output_format()`, `cbz_keep_original() -> bool` (`!== 'false'` semantics,
`library.ipc.ts:2959`), `series_grouping() -> bool` (`=== 'true'`), the
`kavita*` quartet and the 9 `search*` keys (`search-settings.ipc.ts:68-84`).
Rules:

- Store `String`s, parse at the accessor; a malformed value falls back to the
  documented default (1.x parses with `Number()`/`===` comparisons and no
  validation — reproduce the fallback, not a stricter parser).
- **`updated_at` units differ per writer** (`seedDefaults` ms
  `connection.ts:140`; `settingsRepo.set` ms `settings.repo.ts:31,35`; column
  default s) — port writes seconds (rule 5), tolerates ms on read.
- **Encryption boundary stays outside this module.** `kavitaApiKey` is stored
  encrypted with plaintext passthrough (`settings.ipc.ts:34`,
  `auth.ipc.ts:26-36`); the repo returns the stored blob untouched, decrypt
  happens in the settings/auth layer (`keyring` per
  [02-ipc-surface.md](../02-ipc-surface.md) §6; S5 says the *nhentai* key is
  not recoverable, Kavita's is app-level AES — port `decryptKey`, not the OS
  keychain).
- `seedDefaults` port keeps the only-when-empty guard (`connection.ts:120-121`):
  a DB where the user deleted every setting re-seeds on next boot.

## 6. Search — `buildLibraryFilter()` port (03-data-model §9 is the spec)

`search.rs` produces the WHERE clause consumed by `findPaginated`
(`library.repo.ts:392`), `findPaginatedGrouped` (`:482`) and `findAllIds`
(§9: "select all" must resolve exactly the set on screen). Port notes:

- `escape_like_pattern()` escapes `\ % _` (`library.repo.ts:19-21`); every
  value is a bound parameter.
- Free text fans out OR'd over the 7 columns `custom_title, primary_artist,
  series_name, custom_tags, publisher, language, description`
  (`:54-64`) plus `CAST(gallery_id AS TEXT) LIKE ? ESCAPE '\'`
  (`:71`, no COLLATE on digits). **`file_path` is not searched.**
- Artist/series filters are exact `IN` (`:75-81`); tag filters are OR'd
  substring `LIKE` over the comma-joined `custom_tags` (`:83-89`);
  `showUnmatchedOnly` → `gallery_id IS NULL OR gallery_id = 0` (`:91-95`).
- Sorting is `COLLATE NOCASE` (`:406-416` flat; computed `sort_*` columns in
  the grouped union `:541-554` — port that raw SQL verbatim, including the
  `HAVING COUNT(*) >= 2` visibility rule).

> **USER DECISION — tag substring over-match.** Filter `maid` matches tag
> `maids` because tags live in one comma-joined text column. Options: (a)
> preserve 1.x behaviour; (b) split on commas in SQL / add a tag join table so
> filters match whole tags. **Recommendation: preserve in Phase A** (saved
> filters and the parity rule of 03-data-model §10.9 demand row-set equality;
> the ledger would otherwise need a P2 row mid-Phase-A), and **revisit behind
> a `tagExactMatch` flag post-cutover** with a migration to a proper tag table
> if wanted. Recorded as open; nothing in the Phase A build may silently
> change match semantics either way.

## 7. Queue repos and timestamps

- **conversion.rs / sync.rs** port the UPSERT enqueue + atomic claim pairs:
  `conversion.repo.ts:40-61` / `sync.repo.ts:31-48` (`ON CONFLICT … DO UPDATE`
  resetting to `pending`, clearing error/timestamps, refreshing
  `library_item_id`/`keep_original`), and the two `UPDATE … SET status=… WHERE
  id = (SELECT …) AND status='pending' RETURNING …` claims
  (`conversion.repo.ts:69-88`, `sync.repo.ts:56-66`). Keep the redundant
  `AND status='pending'` and the `ORDER BY priority DESC, id ASC` /
  `ORDER BY id` selection order; keep `markFailed`'s 2000-char error truncation
  (`conversion.repo.ts:103`). `keep_original` stays per-row
  (03-data-model §10.10).
- **Timestamps:** new writes are `unixepoch()` seconds everywhere (rule 5),
  *except* keep the shape of what you diff against: the sync queue's
  claim/finish wrote ms (`sync.repo.ts:64, :75`) — write seconds and let the
  differential harness normalise units when comparing, per 03-data-model
  §10.5. Never rewrite old ms rows.
- **download.rs** keeps the read-then-write claim only behind
  [03-download-manager.md](03-download-manager.md) §3's single-scheduler;
  `findActiveByGalleryId`'s active-status set (`download.repo.ts:44-52`) is
  parity-relevant (a retry is never blocked by a finished row).
- **maintenance.rs** ports `runStartupMaintenance` in its documented order
  (03-data-model §10.7): wipe `download_page` + `scan_queue`, reset
  `conversion_queue` `'converting'→'pending'` (never wipe the table —
  `startup-maintenance.ts:70-76`), prune completed downloads, sweep orphaned
  artists (`:96-101`), then outside the transaction `requeueInterrupted()`
  (`:131-135`) and the `seriesGrouping` relink (`:138`). All best-effort:
  never block startup (`:104-112`).

## 8. Differential tests against live better-sqlite3

Dev-tree harness (`tests/differential/db_harness.mjs`, never shipped) opens a
**byte copy** of the production DB with better-sqlite3; a Rust test binary
opens the same copy with the port and both print JSON per operation:

| Test | Asserts |
|---|---|
| Migration zero-surprise | `sqlite_master` (name + sql, sorted) identical before/after Rust migrator on the already-migrated copy; `integrity_check` ok before/after |
| Migration convergence | synthetic 1.x-era DB (columns dropped, sentinels absent, absolute `file_path`s) converges: ALTERs fire, both path migrations run, sentinels written; re-open → no further changes |
| Sentinel retry | `_migrated_file_paths` with empty `libraryPath` → not written, retried after setting the path |
| Read parity | for every repo read method, identical rows on the 5261-item copy: `findPaginated` over the full filter × sort matrix (search terms with `%`, `_`, `\`, ids, Japanese text), grouped vs flat, autocompletes, `seriesFacts`, `findAllIds` == paged id set |
| Search semantics | the `maid`/`maids` over-match case returns identical rows (or flag documented, per §6 decision); `gallery_id` search; NOCASE ordering |
| Queue claims | N concurrent threads call `claimNext` on both engines → N distinct ids, none duplicated, order `priority DESC, id ASC`; `release`/`requeueInterrupted`/`clearFinished`/`clear` row-equal |
| UPSERT reset | re-enqueue of a failed/completed row resets it, refreshes `library_item_id`/`keep_original`, leaves other rows alone |
| Timestamps | seeded ms rows read unchanged; new rows carry seconds; mixed units tolerated by every comparison query |
| Settings | get/set/delete/seed parity incl. only-when-empty re-seed and the `!== 'false'` / `=== 'true'` coercions |
| Write parity | a scripted mutation set (insert item, add artists, rename series, delete) leaves both DBs byte-equal on affected rows (`updatedAt` normalised to seconds) |

## 9. Exit criteria

1. The production-DB copy opens with `integrity_check ok` and **zero schema
   diff** after the Rust migrator (§8 test 1) — the Phase A precondition for
   every other subsystem.
2. Read parity green over the full filter/sort matrix on the 5261-item copy,
   including the tag over-match case at its documented semantics.
3. Queue claim concurrency test green on both engines with identical claim
   order; UPSERT reset parity green.
4. Every item of 03-data-model §10 has either a test or a checklist note
   pointing at the code that satisfies it — walk the ten in review.
5. `busy_timeout` and WAL asserted by test on every connection the pool can
   hand out; single-writer discipline documented in `mod.rs`.

## 10. Risks

| Risk | Mitigation |
|---|---|
| rusqlite/bundled-SQLite drift from better-sqlite3's build (query planner, collation weights) | differential row-set equality on the real copy is the gate; pin the bundled version and re-run on bump |
| `RETURNING` silently unavailable (system sqlite linked by accident) | `bundled` feature mandatory; a smoke test asserts `RETURNING` works before the suite runs |
| Long maintenance transaction starving worker claims | busy_timeout 5000 + the single-write mutex; document that the sweep is bounded by table sizes, measure on the copy |
| ms/s mixing causes subtle ordering bugs in new code | all comparisons in Rust go through a `Timestamp` newtype that accepts both units (03-data-model §10.5) — unit-test the boundary |
| Tag-filter fix pressure mid-Phase-A | the USER DECISION of §6 is recorded; changing semantics without a ledger row is a defect (04-parity-ledger §9 rule) |
| Windows path shapes in `migrateFilePaths` | `isAbsolute`/`relative` semantics differ per platform — port with the same platform rules as Node's `path` and test the `..`-guard with mixed separators |
