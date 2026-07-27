# Background Worker Library Scanner — Architecture Plan

## Problem Statement

The current scanner runs in the Electron main process's event loop. Even with chunked processing (yielding every 50 files, batching progress every 25), it still:
- Blocks the renderer from communicating during `PDFDocument.load()` calls
- Cannot be truly paused/resumed — only cancelled
- Re-scans every file on every run (no incremental detection)
- Competes with UI-initiated DB writes for the single SQLite connection
- Has no persistent queue state — crash = start over

## Proposed Architecture

```
┌──────────────────┐     postMessage      ┌──────────────────────┐
│  Electron Main   │◄────────────────────►│  Worker Thread        │
│  Process         │                      │  (library-scanner     │
│                  │   progress, newItem, │   .worker.ts)         │
│  IPC ──►Renderer │   complete, error    │                       │
│                  │                      │  Own SQLite connection│
│  library:scan    │   start, pause,      │  pdf-lib parsing      │
│  library:pause   │   resume, cancel     │  thumbnail generation │
│  library:resume  │                      │  filesystem walking   │
│  library:cancel  │                      │                       │
└──────────────────┘                      └──────────────────────┘
```

### Why `worker_threads` over alternatives

| Approach | Pros | Cons |
|----------|------|------|
| `worker_threads` | Shared memory, fast messaging, same process space, no IPC serialization overhead | Cannot share Drizzle ORM instances (need raw `better-sqlite3`) |
| `child_process.fork()` | Full isolation | Slow serialization, separate node instance memory overhead |
| `utilityProcess` (Electron) | Chromium-managed lifecycle | Electron-specific, heavier than worker_threads |

**Decision: `worker_threads`** — lightest weight, fastest messaging, and we already use `better-sqlite3` which supports multiple connections in WAL mode.

## Implementation Plan

### Phase A: Schema & Infrastructure

#### A1. Extend `library_item` schema

Add columns to [`src/main/db/schema.ts`](src/main/db/schema.ts:24):

```typescript
export const libraryItem = sqliteTable('library_item', {
  // ... existing columns ...
  fileMtime: integer('file_mtime'),          // fs stat mtimeMs
  thumbnailPath: text('thumbnail_path'),      // path to generated thumbnail
})
```

Migration: `ALTER TABLE library_item ADD COLUMN file_mtime INTEGER;` + `ADD COLUMN thumbnail_path TEXT;`

#### A2. New `scan_queue` table

```typescript
export const scanQueue = sqliteTable('scan_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  filePath: text('file_path').notNull().unique(),
  status: text('status').notNull().default('pending'), // pending | scanning | completed | failed
  priority: integer('priority').notNull().default(0),
  errorMessage: text('error_message'),
  scannedAt: integer('scanned_at'),
  createdAt: integer('created_at').notNull().default(Date.now()),
})
```

#### A3. Database connection for worker

The worker thread creates its own `better-sqlite3` connection to the same WAL-mode database. Two connections in WAL mode can read/write concurrently without blocking each other. Add `openWorkerConnection()` to [`src/main/db/connection.ts`](src/main/db/connection.ts:29).

### Phase B: Worker Thread

#### B1. Create `src/main/services/library-scanner.worker.ts`

The worker script:

```typescript
import { parentPort } from 'worker_threads'
import { openWorkerConnection } from '../db/connection'
import { PDFDocument } from 'pdf-lib'
// ... etc

// Message protocol
type WorkerCommand = 
  | { type: 'start'; libraryRoot: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cancel' }

type WorkerEvent =
  | { type: 'progress'; current: number; total: number; status: string }
  | { type: 'newItem'; item: { id: number; title: string; artist: string } }
  | { type: 'complete'; result: ScanResult }
  | { type: 'error'; message: string }
  | { type: 'paused' }
  | { type: 'cancelled' }

let state: 'idle' | 'scanning' | 'paused' | 'cancelled' = 'idle'

parentPort.on('message', async (cmd: WorkerCommand) => {
  switch (cmd.type) {
    case 'start': await startScan(cmd.libraryRoot); break
    case 'pause': state = 'paused'; parentPort.postMessage({ type: 'paused' }); break
    case 'resume': if (state === 'paused') { state = 'scanning'; resumeScan(); }; break
    case 'cancel': state = 'cancelled'; parentPort.postMessage({ type: 'cancelled' }); break
  }
})
```

Key behaviors:
- On `start`: populate `scan_queue` from filesystem walk, then process queue sequentially
- On `pause`: finish current file, then yield — queue state persists in DB
- On `resume`: re-read `scan_queue` for pending items, continue processing
- On `cancel`: mark all pending items as cancelled, exit
- Each file: check `file_mtime` in `library_item` — if unchanged, skip (incremental)
- DB writes: batch in transactions of 50 items using `BEGIN IMMEDIATE` / `COMMIT`
- After each file: check `state` for pause/cancel; send progress every 10 files

### Phase C: Main Process Integration

#### C1. Worker manager in `library.ipc.ts`

```typescript
import { Worker } from 'worker_threads'

let scanWorker: Worker | null = null
let scanState: 'idle' | 'scanning' | 'paused' = 'idle'

ipcMain.handle('library:scan', async (event, libraryRoot) => {
  if (scanWorker) return { success: false, error: 'Scan already active' }
  
  scanWorker = new Worker(
    path.join(__dirname, '../services/library-scanner.worker.js')
  )
  
  scanWorker.on('message', (msg: WorkerEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    switch (msg.type) {
      case 'progress':
      case 'newItem':
        win?.webContents.send(`library:${msg.type}`, msg)
        break
      case 'complete':
        scanWorker = null
        scanState = 'idle'
        win?.webContents.send('library:scanComplete', msg.result)
        break
      case 'paused':
        scanState = 'paused'
        win?.webContents.send('library:scanPaused')
        break
      case 'cancelled':
        scanWorker?.terminate()
        scanWorker = null
        scanState = 'idle'
        break
    }
  })
  
  scanWorker.postMessage({ type: 'start', libraryRoot })
  scanState = 'scanning'
  return { success: true, data: { scanning: true } }
})

ipcMain.handle('library:pauseScan', () => {
  scanWorker?.postMessage({ type: 'pause' })
})

ipcMain.handle('library:resumeScan', () => {
  scanWorker?.postMessage({ type: 'resume' })
})

ipcMain.handle('library:cancelScan', () => {
  scanWorker?.postMessage({ type: 'cancel' })
})
```

### Phase D: Frontend Integration

#### D1. Update `LibraryPage` toolbar

The scan button becomes a tri-state control:

| State | Button | Action |
|-------|--------|--------|
| `idle` | 🟣 Rescan Library | `library:scan` |
| `scanning` | 🔴 Pause Scan | `library:pauseScan` |
| `paused` | 🟢 Resume Scan | `library:resumeScan` |

A "Cancel" button appears alongside Pause/Resume.

#### D2. Live library updates

The worker sends `newItem` events for each newly scanned item. The renderer listens via `onLibraryNewItem` and appends to the local state, so the grid updates in real-time without requiring a full re-fetch.

### Phase E: Incremental Scanning

#### E1. Skip logic

For each file path in the scan queue:
1. `statSync(filePath)` to get current `mtimeMs` and `size`
2. Query `library_item` for matching `filePath`
3. If found AND `fileMtime === currentMtime` AND `fileSize === currentSize` → skip
4. If found but `fileMtime` changed → re-scan metadata, update DB, regenerate thumbnail
5. If not found → full insert (new item)
6. Store `fileMtime` and `fileSize` on every insert/update

### Phase F: Logging

Worker writes structured logs to `~/.config/doujin-downloader/logs/scan-{date}.log`:

```
[2026-07-27T17:30:00.000Z] SCAN_START libraryRoot=/mnt/bragi/Kavita/Doujins/
[2026-07-27T17:30:01.000Z] DISCOVERY found 4623 PDFs
[2026-07-27T17:30:01.500Z] QUEUE populated 4623 items
[2026-07-27T17:30:02.000Z] PROCESS [1/4623] /path/to/file.pdf galleryId=224257 status=new
[2026-07-27T17:30:02.500Z] THUMBNAIL [1] generated /tmp/.../abc.jpg
[2026-07-27T17:30:02.600Z] DB_INSERT [1] library_item.id=5001
[2026-07-27T17:30:03.000Z] SKIP [50/4623] unchanged mtime=1722000000000
...
[2026-07-27T17:35:00.000Z] SCAN_COMPLETE total=4623 new=12 updated=5 skipped=4606 errors=0
```

## Execution Order

1. **A1–A3**: Schema changes + worker DB connection (foundation)
2. **B1**: Worker thread core logic (scanning engine)
3. **C1**: Main process worker manager (IPC bridge)
4. **D1**: Frontend tri-state button (UI)
5. **D2**: Live item streaming to grid (UX)
6. **E1**: Incremental skip logic (performance)
7. **F1**: Structured logging (diagnostics)
8. **Cleanup**: Remove old `library-scanner.ts` synchronous logic

## Key Design Decisions

1. **Worker uses raw `better-sqlite3`**, not Drizzle ORM. Drizzle instances can't be shared across threads. The worker opens its own connection with `new Database(dbPath)`.

2. **WAL mode already enabled** ([`connection.ts`](src/main/db/connection.ts:38) `PRAGMA journal_mode = WAL`). This lets the worker write while the main process reads — no locks.

3. **Transactions are `BEGIN IMMEDIATE`** to prevent "database is locked" errors. Batched in groups of 50 inserts.

4. **Progress messages are batched** at 10-file intervals to avoid flooding the message port, same pattern as current code.

5. **No new npm packages needed** — `worker_threads` is a Node.js built-in.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/main/services/library-scanner.worker.ts` | CREATE | Worker thread scanning engine |
| `src/main/db/connection.ts` | MODIFY | Add `openWorkerConnection()` |
| `src/main/db/schema.ts` | MODIFY | Add `fileMtime`, `thumbnailPath` columns + `scanQueue` table |
| `src/main/db/migrations/002-scan-queue.sql` | CREATE | Migration SQL |
| `src/main/ipc/library.ipc.ts` | MODIFY | Replace scan handlers with Worker manager |
| `src/preload/index.ts` | MODIFY | Add `pauseScan`, `resumeScan` methods |
| `src/renderer/src/components/library/LibraryPage.tsx` | MODIFY | Tri-state button, live item streaming |
| `src/main/services/library-scanner.ts` | DELETE | Replaced by worker |

## Verification Checklist

- [ ] `npm run build` passes with zero type errors
- [ ] Clicking "Rescan Library" starts worker, progress updates in real-time
- [ ] Pause button appears during scan; clicking it pauses after current file
- [ ] Resume continues from where it left off
- [ ] Cancel immediately terminates worker
- [ ] New items appear in the grid as they're scanned (no manual refresh)
- [ ] Search/filter/edit operations work without blocking during scan
- [ ] Re-scanning skips unchanged files (check logs for SKIP entries)
- [ ] Thumbnails are reused on unchanged files
- [ ] Scan log file is written to `~/.config/doujin-downloader/logs/`
