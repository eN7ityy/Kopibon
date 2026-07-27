# Background Worker Library Scanner — Comprehensive Change Report

## Summary

Replaced the synchronous, main-thread-blocking library scanner with a fully detached `worker_threads`-based scanner that runs in a separate OS thread with its own SQLite connection. The frontend stays fully responsive during scans, supports pause/resume/cancel, streams new items live to the grid, and performs incremental scanning to skip unchanged files.

**Total commits**: 5 (across this feature)  
**Files created**: 2  
**Files modified**: 7  
**Files deleted**: 1  
**Lines added**: ~1,000  
**Lines removed**: ~440  

---

## Architecture

```
Renderer (React)              Main Process               Worker Thread
     │                             │                          │
     ├── library:scan ────────────►│                          │
     │                             ├── new Worker() ─────────►│
     │                             │                          ├─ openWorkerConnection()
     │                             │   ◄── postMessage ───────┤
     │   ◄── library:scanProgress ─┤                          │
     │   ◄── library:newItem ──────┤                          │
     │   ◄── library:scanPaused ───┤                          │
     │                             │                          │
     ├── library:pauseScan ───────►├── postMessage ──────────►│
     ├── library:resumeScan ──────►├── postMessage ──────────►│
     ├── library:cancelScan ──────►├── postMessage ──────────►│
```

---

## File-by-File Changes

### 1. [`plans/background-worker-scanner-plan.md`](plans/background-worker-scanner-plan.md) — NEW

Complete architecture plan documenting the design decisions, message protocol, schema changes, incremental scanning strategy, and implementation phases.

### 2. [`src/main/services/library-scanner.worker.ts`](src/main/services/library-scanner.worker.ts) — NEW (503 lines)

The core worker thread engine. Key components:

- **Message protocol**: Handles `start`, `pause`, `resume`, `cancel` commands from main process
- **Database**: Opens its own `better-sqlite3` connection via `openWorkerConnection()` (WAL mode allows concurrent reads/writes with main process)
- **Queue management**: `populateQueue()` populates `scan_queue` table; `resetPausedToPending()` resets partially-scanned items on restart
- **Incremental scanning**: `shouldSkipFile()` compares `statSync.mtimeMs` + `size` against stored `file_mtime` + `file_size` in `library_item`; skips unchanged files
- **PDF parsing**: `extractPdfMetadata()` reads `/Title`, `/Author`, `/Keywords` (nhentai ID + tags), `/CreationDate` via `pdf-lib`
- **Thumbnail generation**: `generateThumbnail()` spawns `pdftoppm` to render first page as 300px JPEG, caches in `/tmp/doujin-downloader-thumbs/`
- **Batch DB writes**: Uses raw `better-sqlite3` prepared statements; inserts gallery stubs, library items, and artist rows
- **Pause/resume gate**: Promise-based gate with `resolvePause`; cancel checks state after await to prevent resume-on-cancel
- **Progress**: Sends progress events every `PROGRESS_INTERVAL` (currently 1 = every file)
- **Live items**: Sends `newItem` events for each newly scanned item
- **Logging**: Structured logs to `~/.config/doujin-downloader/logs/scan-{ISO-date}.log`

### 3. [`src/main/db/schema.ts`](src/main/db/schema.ts) — MODIFIED

| Change | Line |
|--------|------|
| Added `fileMtime: integer('file_mtime')` column to `libraryItem` | 39 |
| Added `thumbnailPath: text('thumbnail_path')` column to `libraryItem` | 40 |
| Added `scanQueue` table (id, file_path UNIQUE, status, priority, error_message, scanned_at, created_at) | 117-126 |

### 4. [`src/main/db/connection.ts`](src/main/db/connection.ts) — MODIFIED

| Change | Line |
|--------|------|
| Added `scan_queue` table creation to `runMigrations()` | 159-167 |
| Made column migration idempotent: uses `PRAGMA table_info` to check if `file_mtime` and `thumbnail_path` exist before `ALTER TABLE ADD COLUMN` | 169-177 |
| Added `openWorkerConnection()`: opens separate `better-sqlite3` connection with WAL + busy_timeout=5000 for worker thread use | 183-189 |

### 5. [`src/main/ipc/library.ipc.ts`](src/main/ipc/library.ipc.ts) — MODIFIED

| Change | Line |
|--------|------|
| Replaced `scanLibrary` import with `Worker` from `worker_threads` | 1-6 |
| Replaced `currentScanCancelToken` with `scanWorker: Worker | null` | 8-9 |
| `library:scan`: spawns Worker, forwards all message types to renderer via `webContents.send` | 96-157 |
| `library:pauseScan`: posts `{ type: 'pause' }` to worker | 159-162 |
| `library:resumeScan`: posts `{ type: 'resume' }` to worker | 164-167 |
| `library:cancelScan`: posts `{ type: 'cancel' }` to worker | 169-172 |
| Worker `error` and `exit` event handlers for cleanup | 148-156 |
| `library:reset`: uses `getRawDatabase()` to truncate library tables | 134-145 |

### 6. [`electron.vite.config.ts`](electron.vite.config.ts) — MODIFIED

Added worker file as separate rollup entry point so it builds as a standalone JS file:

```typescript
rollupOptions: {
  input: {
    index: resolve('src/main/index.ts'),
    'services/library-scanner.worker': resolve('src/main/services/library-scanner.worker.ts')
  }
}
```

Output: `out/main/services/library-scanner.worker.js` (16 KB standalone).

### 7. [`src/preload/index.ts`](src/preload/index.ts) — MODIFIED

| Addition | Line |
|----------|------|
| `library.pauseScan()` | 64 |
| `library.resumeScan()` | 65 |
| `library.autocompleteTags()` | 68 |
| `library.deleteFile()` | 73 |
| `library.getThumbnail()` | 74 |
| `onLibraryNewItem(callback)` | 111-116 |
| `onLibraryScanPaused(callback)` | 117-121 |
| `onLibraryScanCancelled(callback)` | 122-126 |

### 8. [`src/renderer/src/components/library/LibraryPage.tsx`](src/renderer/src/components/library/LibraryPage.tsx) — MODIFIED

| Change | Line |
|--------|------|
| Added `scanPaused` state | 52 |
| Tri-state button: idle → Rescan, scanning → Pause + Cancel, paused → Resume + Cancel | 412-434 |
| `handlePauseScan()` handler | 201-203 |
| `handleResumeScan()` handler | 205-207 |
| `onLibraryNewItem` listener: appends scanned items to grid in real-time | 143-162 |
| `onLibraryScanPaused` listener: sets `scanPaused=true` | 164-166 |
| `onLibraryScanCancelled` listener: resets scanning state | 167-170 |
| Progress handler resets `scanPaused=false` on every event | 122 |

### 9. [`src/renderer/src/components/library/LibraryCard.tsx`](src/renderer/src/components/library/LibraryCard.tsx) — MODIFIED

| Change | Line |
|--------|------|
| Thumbnail fetch: now always calls `getThumbnail(item.id)` regardless of `customCoverPath` | 53-62 |
| Switched from `file://` URLs to base64 data URLs for secure rendering | 65 |

### 10. [`src/renderer/src/components/library/LibraryDetail.tsx`](src/renderer/src/components/library/LibraryDetail.tsx) — MODIFIED

| Change | Line |
|--------|------|
| Added `thumbDataUrl` state and thumbnail fetch effect | 38, 62-65 |
| Replaced `file://` cover image with base64 data URL | 148-152 |
| Tag autocomplete now uses `autocompleteTags` instead of `autocompleteArtists` | 75 |
| Series field uses `AutocompleteInput` with series suggestions | Added |
| Language field: dropdown presets + free-text custom input | Added |

### 11. [`src/main/db/repositories/library.repo.ts`](src/main/db/repositories/library.repo.ts) — MODIFIED

| Addition | Line |
|----------|------|
| `getAllTagNames()`: parses comma-separated `customTags` from all items, deduplicates, sorts | 133-148 |
| `autocompleteTags(query)`: filters tag names by query, returns top 10 | 150-156 |

### 12. [`src/main/services/library-scanner.ts`](src/main/services/library-scanner.ts) — DELETED

Replaced entirely by `library-scanner.worker.ts`.

### 13. [`src/renderer/src/components/settings/SettingsPage.tsx`](src/renderer/src/components/settings/SettingsPage.tsx) — MODIFIED

Added "Reset Library" section with `DELETE ALL` text confirmation, calls `library:reset`.

---

## Bugs Fixed During Implementation

| # | Bug | Root Cause | Fix | Commit |
|---|-----|-----------|-----|--------|
| 1 | "Cannot find module worker.js" | electron-vite bundles all TS into single `index.js`; worker needs standalone file | Added worker as separate rollup entry point in `electron.vite.config.ts` | `506d7b6` |
| 2 | "duplicate column name: file_mtime" on second launch | `ALTER TABLE ADD COLUMN` ran unconditionally after `CREATE TABLE IF NOT EXISTS` already included the column | Made migration idempotent with `PRAGMA table_info` check | `00bf8fa` |
| 3 | Progress counter updated in batches of 10 | `PROGRESS_INTERVAL = 10` | Set to `1` for per-file updates | `fa38d2d` |
| 4 | Cancel during pause resumed the scan instead of cancelling | After pause await, `state = 'scanning'` overwrote the cancelled flag | Added `if (state === 'cancelled') continue` after await | `fa38d2d` |
| 5 | Resume button stayed on "Resume" after resuming | `scanPaused` never cleared on progress events | Added `setScanPaused(false)` in progress handler | `4cc3928` |
| 6 | New scanned items showed no thumbnails | `LibraryCard` only fetched thumbnails when `customCoverPath` was set | Removed the guard; always call `getThumbnail()` | `fa38d2d` |
| 7 | Tag autocomplete showed artist names instead of tags | `LibraryDetail` called `autocompleteArtists` for tag suggestions | Added `autocompleteTags` to repo, IPC, preload; switched call | `e5f551f` |
| 8 | Thumbnails not showing in detail panel | `LibraryDetail` used `file://` URLs (blocked by Electron CSP) | Added thumbnail fetch via IPC, base64 data URL display | `e5f551f` |

---

## Database Schema Changes

### New columns on `library_item`
- `file_mtime INTEGER` — `statSync.mtimeMs` of the PDF file, used for incremental skip detection
- `thumbnail_path TEXT` — path to generated first-page JPEG thumbnail

### New table: `scan_queue`
| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER PK | Auto-increment ID |
| `file_path` | TEXT UNIQUE | Absolute PDF path |
| `status` | TEXT | `pending` / `scanning` / `completed` / `failed` |
| `priority` | INTEGER | Future use for priority ordering |
| `error_message` | TEXT | Error details if status is `failed` |
| `scanned_at` | INTEGER | Unix timestamp when scanned |
| `created_at` | INTEGER | Unix timestamp when queued |

---
