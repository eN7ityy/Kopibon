# Phase 2.5 — Gallery Detail + Download Wiring: Handoff Brief

## Status: Ready for Implementation

---

## Problem Statement

The backend download pipeline (manager, PDF generator, metadata writer) and UI components (GalleryDetail, GalleryCard) all exist from Phase 2, but they are not connected end-to-end:

1. **Clicking a gallery card** opens `nhentai.net/g/{id}` in an external browser instead of the in-app GalleryDetail panel
2. **Artist/tag chips** in GalleryDetail open `nhentai.net/tag/{name}` externally instead of searching within the app
3. **Download button** in GalleryDetail calls `onDownload(galleryId)` but this prop may not be wired to the actual download queue
4. **Download status badges** may not update in real-time as items move through the queue

---

## Changes Required

### C1 — SearchPage: Gallery Click Opens Detail Panel

**File:** [`src/renderer/src/components/search/SearchPage.tsx`](src/renderer/src/components/search/SearchPage.tsx)

Current behavior (line 132): `handleGalleryClick` calls `window.api.shell.openExternal(...)` — opens nhentai in browser.

New behavior:
- Add state: `const [selectedGalleryId, setSelectedGalleryId] = useState<number | null>(null)`
- `handleGalleryClick` sets `selectedGalleryId` instead of opening browser
- When `selectedGalleryId` is set, render `<GalleryDetail>` as an overlay
- `onClose` clears `selectedGalleryId`
- `onDownload` calls `window.api.downloads.addToQueue(galleryId)` — actually adds to the download queue
- `onAddToQueue` calls `window.api.downloads.addToQueue(galleryId)` (same for now; Download = immediate, Queue = queued)
- After adding to queue, refresh download statuses for visible gallery cards
- When a tag/artist is clicked inside GalleryDetail (see C2), the detail panel closes AND the search query is updated

### C2 — GalleryDetail: Artist/Tag Clicks Search In-App

**File:** [`src/renderer/src/components/gallery/GalleryDetail.tsx`](src/renderer/src/components/gallery/GalleryDetail.tsx)

Current behavior: `handleTagClick` (line 95) opens `nhentai.net/tag/{name}` externally.

New behavior:
- Add new prop: `onTagClick: (tagType: string, tagName: string) => void`
- Artist chip click → `onTagClick('artist', name)` → closes detail, sets search query to `artist:"{name}"`
- Tag chip click → `onTagClick('tag', name)` → closes detail, sets search query to `"{name}"`
- Group chip click → `onTagClick('group', name)` → closes detail, sets search query to `group:"{name}"`
- Parody chip click → `onTagClick('parody', name)` → closes detail, sets search query to `parody:"{name}"`
- Keep external link at bottom: "Open on nhentai ↗" → `window.api.shell.openExternal(...)`

**SearchPage handles `onTagClick`:**
- Clear `selectedGalleryId` (closes detail panel)
- Set `store.setQuery(tagQuery)` — updates the search input
- Immediately trigger `performSearch(1, false)` with the new query
- Scroll to top of results

### C3 — Download Button: Full Pipeline Wiring

**File:** [`src/renderer/src/components/search/SearchPage.tsx`](src/renderer/src/components/search/SearchPage.tsx) (small change)

In `handleDownload`:
1. Call `window.api.downloads.addToQueue(galleryId)` — adds to the download manager queue
2. The download manager (already implemented in Phase 2.3) picks it up automatically
3. The download manager handles: metadata fetch → CDN config → image downloads → PDF generation → metadata embedding → library placement
4. After calling addToQueue, poll `window.api.downloads.getByGalleryId(galleryId)` to update the status badge
5. Or use IPC events: listen for `download:progress` events from main process to update status in real-time

**Verify download manager end-to-end pipeline** (`src/main/services/download-manager.ts`):
- Confirm that after all images download, it calls `pdf-generator.ts` to create the PDF
- Confirm that after PDF generation, it calls `metadata-writer.ts` to embed Title/Author/Keywords(`nhentai:{id}`)/CreationDate
- Confirm the output path follows the plan: `{libraryRoot}/{Primary Artist}/[nhentai-{id}] {safe_title}.pdf`
- If any of these steps are missing, implement them

### C4 — Real-Time Status Updates

**Files:** [`SearchPage.tsx`](src/renderer/src/components/search/SearchPage.tsx), [`GalleryDetail.tsx`](src/renderer/src/components/gallery/GalleryDetail.tsx)

- Listen for IPC events from main process: `ipcRenderer.on('download:progress', ...)`
- When a download status changes, update the `store.downloadStatuses` map
- GalleryDetail should poll or listen for its specific gallery's status
- The `StatusBadge` component already handles all states (in_library, queued, downloading, completed, failed)

### C5 — StatusBar Live Counts

**File:** [`src/renderer/src/components/layout/StatusBar.tsx`](src/renderer/src/components/layout/StatusBar.tsx)

Current: shows placeholder "⬇️ 0 active · 0 queued · 0 in library"

Change to:
- Poll `window.api.downloads.getStatusCounts()` every 2 seconds
- Display real counts: "⬇️ {active} active · {queued} queued · {libraryCount} in library"
- `libraryCount` from `window.api.library.count()`

---

## Files Affected

| File | Change Type |
|------|-------------|
| `src/renderer/src/components/search/SearchPage.tsx` | MODIFY — add selectedGalleryId state, render GalleryDetail overlay, handle tag click → search |
| `src/renderer/src/components/gallery/GalleryDetail.tsx` | MODIFY — change tag/artist clicks to in-app search, keep external link |
| `src/renderer/src/components/layout/StatusBar.tsx` | MODIFY — live counts from API |
| `src/main/services/download-manager.ts` | MODIFY (if needed) — verify end-to-end pipeline connects PDF gen + metadata writer |
| `src/renderer/src/stores/search.store.ts` | MODIFY (if needed) — add `setSearchFromTag(type, name)` helper |
| `src/preload/index.ts` | MODIFY (if needed) — expose IPC event listener for download:progress |
| `src/preload/index.d.ts` | MODIFY (if needed) — type declarations |

---

### C6 — Non-Blocking Download Pipeline

**Concern:** The library scanner initially blocked the Electron main process because it ran CPU-heavy PDF parsing on the main thread. The download manager must not repeat this mistake.

**Current state:** The `DownloadManager` processes downloads asynchronously (`async/await`). HTTP downloads are I/O-bound and non-blocking by design. The potential blocker is **PDF generation** (`pdf-lib` embedding images + saving) which is CPU-bound.

**Required fix (in `download-manager.ts`):**
- After all images are downloaded, offload the PDF generation step to a `worker_thread` (same pattern as `library-scanner.worker.ts`)
- The worker receives: array of image paths, output path, PDF options (page size, quality)
- The worker runs `pdf-lib` and returns the output path
- The main thread waits for the worker without blocking the event loop
- Metadata embedding (`metadata-writer.ts`) stays on main thread since it's a quick I/O operation
- Progress events continue to fire during the worker phase (status: 'converting')

**Alternatively:** If `pdf-lib` generation proves fast enough (<500ms per typical gallery) on the user's hardware, this can be deferred. Add a comment marking the spot for future worker-thread offload.

## Verification

After implementation:
- `npm run build` passes with zero type errors
- Clicking a gallery card in search opens the GalleryDetail panel (not external browser)
- Clicking an artist chip closes the detail and searches for `artist:"Artist Name"`
- Clicking a tag chip closes the detail and searches for the tag
- Clicking "Download" queues the gallery, starts downloading, generates PDF, embeds metadata, places in library
- StatusBar shows real active/queued/library counts
- Download status badge on gallery cards updates in real-time (not_downloaded → downloading → in_library)
- The Electron app remains responsive during downloads (can switch tabs, search, browse library)
