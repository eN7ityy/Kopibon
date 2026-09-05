# 03 — Data model (1.x contract for the Rust port)

The SQLite database is the only persistent state that must survive a port. This document is the **complete data model of 1.x** and the contract a Rust (rusqlite) port must honour: it must open an **existing production DB** in place, keep working, and introduce no migration surprises.

The single most important fact: **`schema.ts` is decorative; `runMigrations()` is the contract.** There is no Drizzle migration history — `drizzle.config.ts` points at `./src/main/db/migrations`, which does not exist, and no `meta/_journal.json` anywhere (`plans/kopibon_rust_port/discovery-02-backend.md` §3). The DDL is applied at runtime by the hand-written idempotent migrator `runMigrations()` (`src/main/db/connection.ts:146-405`). Citations are `path:line` against the working tree on `rust_conversion`.

---

## 1. Connection facts

| Fact | Value | Cite |
|---|---|---|
| DB filename | `db.sqlite` inside the data dir | `src/main/db/connection.ts:22,35,42` |
| Encoding | `PRAGMA encoding = "UTF-8"` | `connection.ts:79`, `:502` |
| Journal mode | `PRAGMA journal_mode = WAL` | `connection.ts:80`, `:503` |
| Foreign keys | `PRAGMA foreign_keys = ON` | `connection.ts:81`, `:504` |
| Busy timeout | `PRAGMA busy_timeout = 5000` — **worker connections only** | `connection.ts:505` |

The main-process connection (`initDatabase()`, `connection.ts:69-87`) sets encoding/WAL/foreign_keys but **no busy_timeout**; workers opened via `openWorkerConnection()` (`connection.ts:500-507`) set all four. A rusqlite port should set `busy_timeout` on every connection — the 1.x asymmetry is an accident, not a requirement — but WAL + `foreign_keys=ON` are mandatory.

**DB path resolution** (`resolveDbDir()`, `connection.ts:11-44`), in order: (1) `$KOPIBON_DATA_DIR` → `<dir>/db.sqlite` (`connection.ts:19-24`) — the main process sets it to `app.getPath('userData')` **before** `initDatabase()` and any worker spawn (`src/main/index.ts:101`), so every thread resolves the same file; (2) `app.getPath('userData')` via a guarded runtime `require('electron')` (`connection.ts:28-40`) — main-process fallback; (3) `~/.config/kopibon/db.sqlite` via `homedir()` (`connection.ts:41-43`) — last resort only, because it diverges from Electron's userData on Windows and would give each worker its own empty DB (comment `connection.ts:14-18`). The dir is created with `mkdirSync(recursive)` before open (`connection.ts:73-76`).

---

## 2. Authoritative schema — all tables

Verbatim column-by-column from the `CREATE TABLE IF NOT EXISTS` block (`connection.ts:147-308`). Columns marked **[ALTER]** were added by the `PRAGMA table_info`-guarded steps (`connection.ts:334-394`) and do **not** appear in the CREATE statements — in a fresh DB they exist only because the ALTERs run right after. Timestamps are `unixepoch()` = **seconds** unless noted. The DDL block contains **14 `CREATE TABLE` statements**, not 13 as sometimes counted (`connection.ts:148-306`) — a port that models only 13 will silently drop one of the two raw-SQL queues.

### 2.1 `gallery` (`connection.ts:148-163`)
| Column | Type | Default | Null |
|---|---|---|---|
| `id` | INTEGER PRIMARY KEY (nhentai id — **not** autoincrement) | — | NO |
| `media_id` | INTEGER | — | NO |
| `title_pretty` | TEXT | — | NO |
| `title_english` | TEXT | — | YES |
| `title_japanese` | TEXT | — | YES |
| `page_count` | INTEGER | 0 | NO |
| `favorites_count` | INTEGER | 0 | YES |
| `upload_date` | INTEGER | — | YES |
| `thumbnail_url` | TEXT | — | YES |
| `cover_url` | TEXT | — | YES |
| `raw_tags_json` | TEXT | `'[]'` | NO |
| `raw_json` | TEXT | — | NO |
| `created_at` / `updated_at` | INTEGER | `unixepoch()` | NO |

No indexes beyond the PK (`discovery-02-backend.md` §3).

### 2.2 `library_item` (`connection.ts:165-188` + ALTERs `:339-362`)
| Column | Type | Default | Null | Notes |
|---|---|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | — | NO | |
| `gallery_id` | INTEGER UNIQUE | — | YES | nhentai id, null for custom items |
| `is_custom` | INTEGER | 0 | NO | 0 = scanned/downloaded, 1 = hand-made, 2 = pending-download placeholder (`download-manager.ts:293-306`) |
| `custom_title` | TEXT | — | YES | |
| `custom_tags` | TEXT | — | YES | comma-joined text — **the tag store for library items** |
| `custom_language` / `custom_date` | TEXT | — | YES | |
| `custom_cover_path` | TEXT | — | YES | bare filename post-migration (`connection.ts:396-438`) |
| `file_path` | TEXT | — | NO | **relative to library root** post-migration (`connection.ts:440-493`) |
| `file_size` | INTEGER | — | YES | |
| `format` | TEXT | `'pdf'` | NO | |
| `primary_artist` | TEXT | — | NO | |
| `series_name` | TEXT | — | YES | source of truth for grouping |
| `series_index` | REAL | — | YES | **[ALTER]** `connection.ts:345-347` |
| `language` | TEXT | — | YES | **[ALTER]** `connection.ts:348-350` |
| `publisher` | TEXT | — | YES | **[ALTER]** `connection.ts:351-353` |
| `description` | TEXT | — | YES | **[ALTER]** `connection.ts:354-356` |
| `series_id` | INTEGER | — | YES | **[ALTER]** `connection.ts:357-359`; FK-by-convention → `series.id` |
| `page_count` | INTEGER | — | YES | **[ALTER]** `connection.ts:360-362`; null = not yet known |
| `read_progress` | INTEGER | 0 | NO | |
| `file_mtime` | INTEGER | — | YES | **[ALTER]** `connection.ts:339-341`; incremental-scan skip key |
| `thumbnail_path` | TEXT | — | YES | **[ALTER]** `connection.ts:342-344`; bare filename |
| `added_at` / `updated_at` | INTEGER | `unixepoch()` | NO | |

Series *visibility* is a query-time `HAVING COUNT(*) >= 2`, never a stored flag (`src/main/db/schema.ts:39-51`).

### 2.3 `library_item_artist` (`connection.ts:190-195`)
| Column | Type | Default | Null |
|---|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | — | NO |
| `library_item_id` | INTEGER | — | NO |
| `artist_name` | TEXT | — | NO |
| `sort_order` | INTEGER | 0 | NO |

Indexes `idx_library_item_artist_unique (library_item_id, artist_name)` and `idx_library_item_artist_name (artist_name)` (`connection.ts:197-201`). **No FK** — orphans swept at startup (`startup-maintenance.ts:96-101`).

### 2.4 `download_queue` (`connection.ts:203-216`)
| Column | Type | Default | Null |
|---|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | — | NO |
| `gallery_id` | INTEGER | — | NO |
| `status` | TEXT | `'queued'` | NO |
| `priority` | INTEGER | 0 | NO |
| `retry_count` | INTEGER | 0 | NO |
| `max_retries` | INTEGER | 3 | NO |
| `error_message` | TEXT | — | YES |
| `output_format` | TEXT | `'pdf'` | NO |
| `output_directory` | TEXT | — | YES |
| `queued_at` | INTEGER | `unixepoch()` | NO |
| `started_at` / `completed_at` | INTEGER | — | YES |

No indexes. The DDL default `'pdf'` is authoritative — see §3.

### 2.5 `download_page` (`connection.ts:218-227`)
| Column | Type | Default | Null |
|---|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | — | NO |
| `queue_id` | INTEGER | — | NO |
| `page_number` | INTEGER | — | NO |
| `url` | TEXT | — | NO |
| `status` | TEXT | `'pending'` | NO |
| `local_path` / `file_size` | TEXT / INTEGER | — | YES |
| `retry_count` | INTEGER | 0 | NO |

Per-attempt bookkeeping; the whole table is wiped at boot (`startup-maintenance.ts:66`).

### 2.6 `favorite` (`connection.ts:229-233`)
| Column | Type | Default | Null |
|---|---|---|---|
| `gallery_id` | INTEGER PRIMARY KEY (nhentai id) | — | NO |
| `added_at` | INTEGER | `unixepoch()` | NO |
| `synced` | INTEGER | 1 | NO |

### 2.7 `app_settings` (`connection.ts:235-239`)
| Column | Type | Default | Null |
|---|---|---|---|
| `key` | TEXT PRIMARY KEY | — | NO |
| `value` | TEXT | — | NO |
| `updated_at` | INTEGER | `unixepoch()` | NO |

Everything is stored as TEXT — see §7.

### 2.8 `library_scan_log` (`connection.ts:241-248`)
| Column | Type | Default | Null |
|---|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | — | NO |
| `scanned_at` | INTEGER | `unixepoch()` | NO |
| `total_items` / `new_items` / `removed_items` | INTEGER | 0 | NO |
| `errors_json` | TEXT | `'[]'` | YES |

### 2.9 `scan_queue` (`connection.ts:250-258`)
| Column | Type | Default | Null |
|---|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | — | NO |
| `file_path` | TEXT NOT NULL **UNIQUE** (inline) | — | NO |
| `status` | TEXT | `'pending'` | NO |
| `priority` | INTEGER | 0 | NO |
| `error_message` / `scanned_at` | TEXT / INTEGER | — | YES |
| `created_at` | INTEGER | `unixepoch()` | NO |

`file_path` is relative to library root post-migration (`connection.ts:471-488`). Whole table wiped at boot (`startup-maintenance.ts:68`).

### 2.10 `conversion_queue` (`connection.ts:260-269` + ALTERs `:386-391`)
| Column | Type | Default | Null | Notes |
|---|---|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | — | NO | |
| `file_path` | TEXT NOT NULL **UNIQUE** (inline) | — | NO | relative to library root |
| `status` | TEXT | `'pending'` | NO | |
| `priority` | INTEGER | 0 | NO | |
| `error_message` | TEXT | — | YES | truncated to 2000 chars on write (`conversion.repo.ts:103`) |
| `started_at` / `completed_at` | INTEGER | — | YES | |
| `created_at` | INTEGER | `unixepoch()` | NO | |
| `library_item_id` | INTEGER | — | YES | **[ALTER]** `connection.ts:386-388` |
| `keep_original` | INTEGER | 1 | NO | **[ALTER]** `connection.ts:389-391`; per-row dialog choice |

### 2.11 `blocked_value` (`connection.ts:271-277`)
| Column | Type | Default | Null | Notes |
|---|---|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | — | NO | |
| `type` | TEXT | — | NO | one of `tag / artist / group / parody / character / language / text` (`schema.ts:168-169`) |
| `value` | TEXT | — | NO | stored as entered, matched NOCASE |
| `mode` | TEXT | `'exclude'` | NO | `exclude` or `dim` |
| `created_at` | INTEGER | `unixepoch()` | NO | |

`UNIQUE(type, value COLLATE NOCASE)` — see §4.

### 2.12 `tag_cache` (`connection.ts:279-284`)
| Column | Type | Default | Null |
|---|---|---|---|
| `id` | INTEGER PRIMARY KEY (nhentai tag id — **not** autoincrement) | — | NO |
| `type` | TEXT | — | NO |
| `name` | TEXT | — | NO |
| `updated_at` | INTEGER | `unixepoch()` | NO |

### 2.13 `sync_queue` (`connection.ts:286-294`)
| Column | Type | Default | Null |
|---|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | — | NO |
| `library_item_id` | INTEGER NOT NULL **UNIQUE** (inline) | — | NO |
| `status` | TEXT | `'pending'` | NO |
| `error_message` | TEXT | — | YES |
| `started_at` / `completed_at` | INTEGER | — | YES |
| `created_at` | INTEGER | `unixepoch()` | NO |

### 2.14 `series` (`connection.ts:296-306` + ALTER `:364-367`)
| Column | Type | Default | Null | Notes |
|---|---|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | — | NO | |
| `name` | TEXT | — | NO | matched case-insensitively against `library_item.series_name` |
| `sort_name` | TEXT | — | YES | display/sort override |
| `cover_item_id` | INTEGER | — | YES | member whose cover represents the group |
| `cover_path` | TEXT | — | YES | hand-picked image, wins over `cover_item_id` |
| `is_manual` | INTEGER | 0 | NO | regrouping leaves these alone |
| `is_dissolved` | INTEGER | 0 | NO | **[ALTER]** `connection.ts:364-367` |
| `created_at` / `updated_at` | INTEGER | `unixepoch()` | NO | |

---

## 3. Schema drift — `schema.ts` vs `connection.ts`

The Drizzle schema (`src/main/db/schema.ts`) and the runtime DDL are **two independent sources of truth that already diverge**. Verified divergences:

1. **`download_queue.output_format` default**: `'cbz'` in Drizzle (`schema.ts:100`) vs **`'pdf'`** in the DDL (`connection.ts:211`). A fresh 1.x insert that omits the column gets `'pdf'`.
2. **Timestamp defaults**: Drizzle uses `Date.now()` — evaluated **once at module load** — at `schema.ts:18-19, 70-71, 102, 124, 133, 140, 174, 198, 244-245, 263`; the DDL uses `unixepoch()` (**seconds**). A module-load default is both stale (every row hitting the default gets the same process-start ms value) and a **unit mismatch** (ms vs s).
3. **`conversion_queue` and `sync_queue` do not exist in `schema.ts` at all** (the file ends at `scan_queue`, `schema.ts:256-264`). They exist only as raw SQL (`connection.ts:260-269, 286-294`), which is why their repositories use the raw handle via `getSqlite()` (`connection.ts:96-109`).
4. **`library_item.series_id` and `page_count`** are declared in Drizzle (`schema.ts:51, 66`) but exist in real DBs **only via ALTER** (`connection.ts:357-362`) — not in the CREATE statement (`:165-188`).
5. `blocked_value`'s unique index is declared in Drizzle **without** the `COLLATE NOCASE` the real index carries (`schema.ts:179` vs `connection.ts:325-328`).

**Port consequence (normative):** `schema.ts` is NOT the contract. `runMigrations()` is. The Rust port must reproduce the DDL of `connection.ts:147-394` — not the Drizzle declarations — and treat `discovery-02-backend.md` §9.1 ("running `db:generate` against a live DB would produce a misleading diff") as a standing warning.

---

## 4. Indexes and uniqueness constraints

From the CREATE block: `idx_library_item_artist_unique` — UNIQUE on `library_item_artist(library_item_id, artist_name)` (`connection.ts:197-198`); `idx_library_item_artist_name` — on `library_item_artist(artist_name)` (`connection.ts:200-201`).

Declared separately, **because Drizzle's `uniqueIndex()` cannot express a collation** (comments `connection.ts:310-318` and `:321-328`):

- `idx_series_name` — **UNIQUE** on `series(name COLLATE NOCASE)` (`connection.ts:319`). Series names arrive from ComicInfo, nhentai metadata and hand entry, so the same series routinely appears with different capitalisation; without NOCASE those become separate groups.
- `idx_blocked_value_type_value` — **UNIQUE** on `blocked_value(type, value COLLATE NOCASE)` (`connection.ts:325-328`). So `'Yuri'` and `'yuri'` cannot both be added — they would produce two identical negations in every search query.
- `idx_tag_cache_name` — on `tag_cache(name COLLATE NOCASE)` (`connection.ts:331`); dim mode looks tags up by name for every result on screen.

One-off `CREATE INDEX IF NOT EXISTS` statements: `idx_library_item_series_id` on `library_item(series_id)` (`connection.ts:370`) — the grouped library query joins on this for every page; `idx_sync_queue_status` on `sync_queue(status)` (`connection.ts:373`) — the sync loop claims the next pending row on every item; `idx_conversion_queue_status` on `conversion_queue(status)` (`connection.ts:392-394`).

Inline table-level UNIQUE constraints (not separate indexes): `scan_queue.file_path` (`connection.ts:252`), `conversion_queue.file_path` (`connection.ts:262`), `sync_queue.library_item_id` (`connection.ts:288`), plus `library_item.gallery_id` UNIQUE (`connection.ts:167`). The Rust port can express all of these natively in DDL; no Drizzle workaround needs preserving.

---

## 5. Implicit relations — FKs by convention

`foreign_keys=ON` is set (`connection.ts:81`) but **not one table declares a foreign key** (`library.repo.ts:369-373` says it explicitly: "no table actually declares a foreign key, so nothing cascades"). Referential integrity is convention plus cleanup:

| Child column | → Parent | Cleanup |
|---|---|---|
| `library_item.gallery_id` | `gallery.id` | none — dangling links allowed; the "unmatched" filter reads them (`library.repo.ts:91-95`) |
| `library_item.series_id` | `series.id` | `seriesRepo.pruneEmpty()` (`series.repo.ts:399`) |
| `library_item_artist.library_item_id` | `library_item.id` | manual delete in `libraryRepo.delete()` (`library.repo.ts:376-381`) + startup sweep |
| `download_page.queue_id` | `download_queue.id` | `deletePages` on reconcile (`download-manager.ts:281`) |
| `conversion_queue.library_item_id` | `library_item.id` | none (nullable, best-effort link) |
| `sync_queue.library_item_id` | `library_item.id` | none |
| `series.cover_item_id` | `library_item.id` | none |

**The startup orphan sweep** (`src/main/services/startup-maintenance.ts:96-101`, inside the boot transaction at `:65-102`):

```sql
DELETE FROM library_item_artist
 WHERE library_item_id NOT IN (SELECT id FROM library_item)
```

with the comment "Nothing declares a foreign key, so historical deletes left artist rows behind." The port must keep this sweep (or declare real FKs — but that changes an existing DB's behaviour; see §10).

---

## 6. The four queue state machines

### 6.1 `download_queue` — `src/main/services/download-manager.ts`
States: `queued → downloading → converting → completed`, plus `paused`, `failed` (`schema.ts:95`).

- **Claim**: `dequeueNext()` (`download-manager.ts:210-224`) — `findByStatus('queued')`, **in-memory sort** by `priority DESC, queuedAt ASC` (`:215`), then a separate `UPDATE` to `downloading` (`:218-220`). A read-then-write claim with no atomicity; safe only because a single in-process scheduler is guarded by `processingQueue` (`:179-181`).
- **Crash recovery**: `reconcileInterrupted()` (`download-manager.ts:271-290`) — every `downloading`/`converting` row → `queued`, `startedAt`/`errorMessage` nulled, page rows deleted (`:281`), scratch dir purged (`:282`). Runs once at startup before `processQueue()` (`index.ts:189`, comment `:269`).
- Completed rows are pruned at boot (`startup-maintenance.ts:78-91`); queued/paused/failed rows are user intent and are kept (`startup-maintenance.ts:20-24`).

### 6.2 `scan_queue` — `src/main/services/library-scanner.worker.ts`
States: `pending → scanning → (row deleted) | failed`.

- **Populate**: `populateQueue()` `INSERT OR IGNORE INTO scan_queue (file_path, status)` (`library-scanner.worker.ts:640-642`).
- **Claim**: single consumer — work query `pending OR scanning, ORDER BY priority DESC, id ASC` (`:895-897`), then `UPDATE scan_queue SET status='scanning' WHERE file_path = ?` (`:940`). No `RETURNING`, none needed.
- **Crash recovery**: the **whole table is wiped at boot** (`startup-maintenance.ts:68`, rationale `:14-18`) — it is intra-scan progress only; real incremental progress is the `file_mtime` + `file_size` skip against `library_item` (`shouldSkipFile`, `library-scanner.worker.ts:668`). Wiping also un-sticks `'failed'` rows, which the work query would otherwise skip forever. Within a run, `requeueIncompleteItems()` (`:658-661`) resets `'scanning'` **and** `'failed'` → `'pending'`.

### 6.3 `conversion_queue` — `src/main/db/repositories/conversion.repo.ts`
States: `pending → converting → completed | failed`, with `release()` back to `pending`.

- **Enqueue (UPSERT)**: `enqueue()` (`conversion.repo.ts:40-61`) — `ON CONFLICT(file_path) DO UPDATE` resetting to `pending`, clearing `error_message`/`started_at`/`completed_at`, refreshing `library_item_id` + `keep_original`. Required because `file_path` is UNIQUE and flips `.pdf → .cbz` on success.
- **Atomic claim**: `claimNext()` (`conversion.repo.ts:69-88`) — a single `UPDATE … SET status='converting', started_at=unixepoch() WHERE id = (SELECT id … WHERE status='pending' ORDER BY priority DESC, id ASC LIMIT 1) AND status='pending' RETURNING …`. The redundant `AND status='pending'` plus `RETURNING` guarantees one row per concurrent runner; this is the only reason raw better-sqlite3 exists alongside Drizzle (`connection.ts:96-102`).
- `markCompleted` `:90-96`; `markFailed` `:98-104` (error truncated to 2000 chars, `:103`); `release` `:107-113`.
- **`keep_original` is stored per row** because it is a per-run choice made in the dialog — a resumed batch must honour it rather than the current setting (`connection.ts:375-380`).
- **Crash recovery**: at boot only `'converting'` → `'pending'` (`startup-maintenance.ts:74-76`); the table is deliberately **not** wiped (`:70-73`) — resumability is the point of the queue. `clearFinished()` (`conversion.repo.ts:152-156`) runs when a fresh (non-resume) batch starts (`library.ipc.ts:3021`); resume skips enqueue entirely (`library.ipc.ts:3008-3030`).

### 6.4 `sync_queue` — `src/main/db/repositories/sync.repo.ts`
States: `pending → syncing → completed | failed`.

- **Enqueue (UPSERT)**: `enqueue()` (`sync.repo.ts:31-48`) — `ON CONFLICT(library_item_id) DO UPDATE` reset to `pending`, mirroring the conversion queue.
- **Atomic claim**: `claimNext()` (`sync.repo.ts:56-66`) — same `UPDATE … WHERE id = (SELECT … ORDER BY id LIMIT 1) RETURNING` shape. **Note:** it stamps `started_at` with `Date.now()` (**ms**), unlike the conversion queue's `unixepoch()` (s) — as do `finish()` (`:68-76`) and the clear/finish path. Real DBs can hold mixed ms/s timestamps in `sync_queue.started_at`/`completed_at`.
- **Crash recovery**: `requeueInterrupted()` (`sync.repo.ts:107-114`) — `'syncing'` → `'pending'`, `started_at = NULL` — called from startup (`startup-maintenance.ts:131-135`), feeding the resume banner.
- The batch loop claims **one at a time** so a crash strands exactly one row (`library.ipc.ts:2596-2598`); empty `ids` = resume from queue, non-empty = fresh batch after `clearFinished()` (`library.ipc.ts:2552-2556`).

A fifth long-running job — "Convert Library Metadata" — has **no queue table**; it walks an in-memory array and is not crash-resumable (`discovery-02-backend.md` §6, last subsection).

---

## 7. Settings — `app_settings`

Key/value TEXT table (`connection.ts:235-239`); access via `settingsRepo` (`src/main/db/repositories/settings.repo.ts:9-49`, read-modify-write `set` at `:26-37`). All values are strings; consumers parse.

### 7.1 Seeded defaults (`seedDefaults`, `connection.ts:119-144`)
Seeded once with `INSERT OR IGNORE` only when the table is **empty** (`:120-121, :139-143`); `updated_at` is `Date.now()` ms here — unlike the column's `unixepoch()` default. A DB that has had every setting deleted will re-seed.

| Key | Default | Consumer |
|---|---|---|
| `libraryPath` | `''` (deliberately empty — comment `connection.ts:124-127`) | download root fallback `download-manager.ts:384`; scan/convert/sync roots `library.ipc.ts:391,521,717,838,958`; originals default `library.ipc.ts:248`; Kavita root compare `kavita-client.ts:388`; path migrations `connection.ts:448` |
| `downloadConcurrency` | `'3'` | worker pool size, clamped 1–8 (`download-manager.ts:164`, `:144-152`) |
| `outputFormat` | `'cbz'` | default for `download:addToQueue` (`download.ipc.ts:58`) |
| `compressPdf` | `'true'` | PDF compression toggle (`download-manager.ts:635`) |
| `compressionQuality` | `'80'` | JPEG quality (`download-manager.ts:636`) |
| `pageSize` | `'Dynamic'` | `'Fit to Image'`/`'Letter'`/`'A4'` mapping (`download-manager.ts:637-639`) |
| `blackBackground` | `'true'` | PDF background (`download-manager.ts:641`) |
| `cbzMangaDirection` | `'YesAndRightToLeft'` | CBZ ComicInfo reading direction (`download-manager.ts:631`, `library.ipc.ts:353`) |
| `cbzKeepOriginal` | `'true'` | default for PDF→CBZ archiving (`library.ipc.ts:2959`) |

### 7.2 Non-seeded keys read by the app

| Key | Default when absent | Consumer |
|---|---|---|
| `thumbnailPath` | `<userData>/thumbnails` (`library.ipc.ts:210-219`) | thumbnail dir resolver `library.ipc.ts:217` |
| `originalsPath` | `<libraryRoot>/_originals/{artist}/` (`library.ipc.ts:246-248`) | originals resolver `library.ipc.ts:246` |
| `seriesGrouping` | off (`!== 'true'`) | regroup gate `library.ipc.ts:71,95,523,639`; toggle write `library.ipc.ts:667`; startup relink `startup-maintenance.ts:138` |
| `showNotifications` | on (`!== 'false'`) | `download-manager.ts:744` |
| `releaseChannel` | inferred, then written back | `updater.ipc.ts:46-49` |
| `nhentai_api_key` | none | `safeStorage` → OS keychain, base64; **plaintext passthrough when encryption unavailable** (`auth.ipc.ts:13-18` encrypt, `:26-36` decrypt); read `auth.ipc.ts:40`, `index.ts:330` |
| `kavitaEnabled` | off (`!== 'true'`) | `kavita-client.ts:179,309` |
| `kavitaUrl` / `kavitaLibraryId` / `kavitaLibraryRoot` | `''` | `kavita-client.ts:157,161,389` |
| `kavitaApiKey` | `''` | encrypted at the settings layer: `ENCRYPTED_SETTINGS = {'kavitaApiKey'}` (`settings.ipc.ts:34`); decrypt `kavita-client.ts:160`, `index.ts:350` |
| `searchDefaultQuery`, `searchDefaultSort`, `searchDefaultLanguage`, `searchMinPages`, `searchMinFavorites`, `searchUploadedWithinDays`, `searchRespectBlacklist`, `searchRememberRecent` | null / off | `SEARCH_SETTING_KEYS` (`search-settings.ipc.ts:68-84`), read `:102-113` |

### 7.3 The `_migrated_*` sentinels

Two one-shot data migrations write sentinel rows into `app_settings` so they run at most once:

- `_migrated_cover_paths` (`connection.ts:413`, written `:435-437`) — strips directory prefixes from `library_item.custom_cover_path` / `thumbnail_path`, leaving bare filenames (`migrateCoverPaths`, `connection.ts:411-438`).
- `_migrated_file_paths` (`connection.ts:445`, written `:490-492`) — rewrites `library_item.file_path`, then `conversion_queue.file_path` and `scan_queue.file_path`, from absolute to **relative to `libraryPath`** (`migrateFilePaths`, `connection.ts:444-493`). Files outside the library root keep their absolute path; with no library root set the migration **skips and retries on later boots** (`connection.ts:450`).

The Rust port must keep both sentinels and their exact key strings — a DB that has not yet run them (e.g. library path set after first launch) must still converge.

---

## 8. Repositories — `src/main/db/repositories/`

Method line-numbers per `discovery-02-backend.md` §4, re-verified against the working tree. "raw" = uses `getSqlite()` (better-sqlite3 handle); "drizzle" = uses `getDatabase()`.

| File | ORM | Notable queries |
|---|---|---|
| `library.repo.ts` (891) | drizzle | `buildLibraryFilter` :46-98 (§9); `findAll` :297, `findById` :302, `findByGalleryId` :307, `findByFilePath` :312, `findByArtist` :317 (join), `findBySeries` :328, `searchByTitle` :337, `findAllWithFilePaths` :346, `insert` :355, `update` :361 (stamps `updatedAt: Date.now()`), `delete` :376 (manual artist cleanup), `deleteOrphanedArtists` :383, `findPaginated` :392, `findAllIds` :451, `findPaginatedGrouped` :482 (raw SQL union, `HAVING COUNT(*) >= 2`), `matchingMemberIds` :583, `seriesFacts` :606, `count` :761, `getArtists` :772, `addArtist` :782, `removeArtists` :787, `getAllArtistNames` :794, `getAllTagNames` :803, `autocompleteTags` :823, `autocompleteArtists` :833, `autocompleteSeries` :849, `getAllSeriesNames` :866, `insertScanLog` :883, `getLastScanLog` :889 |
| `series.repo.ts` (409) | drizzle | `findById` :44, `findByName` :48, `findOrCreate` :61, `resolveFor` :88 (name→series links), `countVisibleFor` :147, `backfillAll` :170 (startup relink), `previewBackfill` :240, `countVisible` :260, `findDisplayableByName` :279, `memberIds` :301, `setCover` :309, `setDissolved` :323, `nameTakenBy` :355, `renameRow` :364, `setSortName` :373, `dissolve` :386, `pruneEmpty` :399 |
| `download.repo.ts` (132) | drizzle | `findAll` :14, `findByStatus` :24, `findActiveByGalleryId` :44 (`status IN ('queued','paused','downloading','converting')` :52 — a retry is never blocked by a finished row), `insert` :58, `getPages` :76, `insertPage(s)` :86/:92, `activeCount` :109, `queuedCount` :121 |
| `conversion.repo.ts` (157) | raw | `enqueue` :40 (UPSERT on `file_path`), `claimNext` :69 (`UPDATE…RETURNING`), `markCompleted` :90, `markFailed` :98, `release` :107, `counts` :115, `pendingItemIds` :127, `recentErrors` :138, `clearFinished` :152 |
| `sync.repo.ts` (129) | raw | `enqueue` :31 (UPSERT on `library_item_id`), `claimNext` :56 (`RETURNING`), `finish` :68, `counts` :78, `recentErrors` :90, `requeueInterrupted` :107, `clearFinished` :117, `clear` :125 |
| `blocked.repo.ts` (110) | drizzle | `list` :31, `entries` :47, `add` :64, `addMany` :87, `setMode` :95, `remove` :101, `clear` :106 |
| `tag-cache.repo.ts` (74) | drizzle | `findByIds` :18, `missingIds` :34, `upsertMany` :41, `count` :61, `clear` :70 |
| `gallery.repo.ts` (47) | drizzle | `findById` :10, `findByMediaId` :15, `upsert` :20, `delete` :34, `count` :39 |
| `settings.repo.ts` (49) | drizzle | `get` :10, `getAll` :16, `set` :26 (read-then-insert/update), `setAll` :39, `delete` :45 |

---

## 9. Search — `buildLibraryFilter()` exact behaviour

There is **no FTS5** virtual table anywhere. All library text search is `LIKE … ESCAPE '\' COLLATE NOCASE`, built by `buildLibraryFilter()` (`library.repo.ts:46-98`), shared by `findPaginated`, `findPaginatedGrouped` and `findAllIds` so "select all" resolves exactly the set on screen (comment `library.repo.ts:30-37`).

- **Free text fans out over 7 columns** OR'd together: `custom_title`, `primary_artist`, `series_name`, `custom_tags`, `publisher`, `language`, `description` (`library.repo.ts:54-64`), each `… LIKE ? ESCAPE '\' COLLATE NOCASE` (`:64`).
- Plus `CAST(gallery_id AS TEXT) LIKE ? ESCAPE '\'` so typing an nhentai id works (`:71` — no COLLATE needed on digits). **`file_path` is not searched.**
- **`escapeLikePattern()`** (`library.repo.ts:19-21`) escapes `\`, `%`, `_`; every value is a bound parameter, never concatenated (comment `:47-49`).
- Artist/series filters are `inArray` **exact match** on `primary_artist` / `series_name` (`:75-81`).
- Tag filters are `custom_tags LIKE '%<tag>%' ESCAPE '\' COLLATE NOCASE` OR'd (`:83-89`) — substring match over the comma-joined text column, so a tag that is a prefix of another **over-matches** (e.g. filter `maid` also hits a tag `maids`). Accepted 1.x behaviour; the port must reproduce it, not fix it, or saved filters change meaning.
- `showUnmatchedOnly` → `gallery_id IS NULL OR gallery_id = 0` (`:91-95`).
- **Sorting is `COLLATE NOCASE`** on the relevant column: flat list `custom_title`/`primary_artist` `COLLATE NOCASE ASC` or `added_at DESC` (`library.repo.ts:406-416`); grouped query sorts computed `sort_title` / `sort_artist` / `sort_added` columns (`:541-554`). Autocomplete (`:823, :833, :849`) is likewise LIKE against distinct column values. Library tag *names* come from splitting `custom_tags` — there is no tag join table for library items (`discovery-02-backend.md` §4).

---

## 10. Port rules for rusqlite (normative checklist)

1. **Open existing production DBs without migration surprises.** Reproduce `runMigrations()` exactly: idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` (`connection.ts:147-331`), and every `ALTER TABLE ADD COLUMN` **guarded by `PRAGMA table_info`** so it is a no-op on databases that already have the column (`connection.ts:334-394`). Do not introduce a new migration framework with its own journal — a first run against a live DB must produce zero schema changes beyond those idempotent statements. Keep the two `_migrated_*` sentinel keys verbatim (§7.3).
2. **schema.ts is not the contract.** When 1.x sources disagree, the DDL wins: `download_queue.output_format` default is `'pdf'` (`connection.ts:211`), `conversion_queue`/`sync_queue` exist, `series_id`/`page_count` are nullable ALTER-added columns (§3).
3. **Keep WAL and `foreign_keys=ON`** on every connection (`connection.ts:79-81, :502-504`), and set a `busy_timeout` (1.x uses 5000 ms on workers, `connection.ts:505`); a multi-connection rusqlite port needs it at least as much.
4. **Keep an atomic claim for the conversion and sync queues.** Either the literal `UPDATE … WHERE id = (SELECT …) RETURNING …` shape (`conversion.repo.ts:73-82`, `sync.repo.ts:59-63`) or an equivalent single atomic statement/transaction that guarantees a row is handed to exactly one runner. The download queue's read-then-write claim (`download-manager.ts:210-224`) may be preserved only behind its single-scheduler invariant.
5. **Keep `unixepoch()` seconds for new rows** in all `*_at` columns (`connection.ts:161-162` et al.). Know that real DBs contain **millisecond rows**: Drizzle module-load `Date.now()` defaults (§3.2), `seedDefaults` (`connection.ts:140`), `settingsRepo.set` (`settings.repo.ts:31,35`), `libraryRepo.update` (`library.repo.ts:361-364`), and the whole `sync_queue` claim/finish path (`sync.repo.ts:60,64,73-75`). Any code comparing timestamps must tolerate both units; do not "fix" old rows.
6. **Path columns are relative to the library root**: `library_item.file_path`, `library_item.thumbnail_path`, `library_item.custom_cover_path`, `scan_queue.file_path`, `conversion_queue.file_path` (`connection.ts:396-493`). `library_item.file_path` outside the root may remain absolute (`connection.ts:464`). Resolve against the `libraryPath` setting (`library.ipc.ts:391` et al.) and keep the skip-and-retry migration semantics for DBs that predate it.
7. **Do not declare foreign keys on an existing DB** as part of the port. Integrity is convention + the startup orphan sweep (`startup-maintenance.ts:96-101`) + manual artist cleanup (`library.repo.ts:376-381`); changing that alters delete semantics for existing users. Keep the boot sweep order: wipe `download_page` and `scan_queue`, reset `conversion_queue.converting → pending`, prune completed downloads, sweep orphaned artists, `requeueInterrupted()` syncs, series relink (`startup-maintenance.ts:65-143`).
8. **Preserve case-insensitive uniqueness semantics**: `series(name)` and `blocked_value(type, value)` are unique **NOCASE** (§4) — port them as `COLLATE NOCASE` unique indexes, not app-level checks.
9. **Reproduce `buildLibraryFilter()` behaviour exactly** (§9): 7 LIKE columns + `CAST(gallery_id AS TEXT)`, `ESCAPE '\'`, NOCASE, substring tag matching with its over-match, no FTS5, NOCASE sorting. A saved filter re-run under the Rust build must return the same rows in the same order.
10. **Queue UPSERT semantics stay**: `conversion_queue` keyed on `file_path` and `sync_queue` keyed on `library_item_id`, both `ON CONFLICT … DO UPDATE` resetting to `pending` and clearing error/timestamps (`conversion.repo.ts:42-53`, `sync.repo.ts:33-42`); `keep_original` remains a per-row column, never read from settings at resume time (`connection.ts:375-380`).
