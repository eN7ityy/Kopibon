# Phase 3 — Library Integration: Handoff Brief

## Status: Ready for Implementation

---

## What's Already Done (from Prior Phases)

| Component | Status | Notes |
|-----------|--------|-------|
| P3.1 Library migration | ✅ Complete | 4,623 PDFs restructured to `{Artist}/{Series?}/[nhentai-{id}] {Title}.pdf` |
| P3.5 Download status badges | ✅ Complete | `GalleryCard.tsx` already shows In Library/Queued/Downloading |
| P3.8 Gallery ID matching | ✅ Complete | Migration scripts matched 4,378 of 4,623 PDFs to nhentai IDs |
| Database schema | ✅ Complete | `library_item`, `library_item_artist`, `library_scan_log` tables defined |
| Library repository | ✅ Complete | `library.repo.ts` has full CRUD + find by artist/series/galleryId, artist names |
| Library IPC handlers | ✅ Partial | Has `getAll`, `getById`, `getByGalleryId`, `search`, `getArtists`, `getAllArtistNames`, `count` — needs `scan`, `update`, `delete`, `updateSeries` |
| Preload bridge | ✅ Complete | `api.library.*` already wired |
| Library page UI | 🔴 Placeholder | Currently shows "Library is empty" static message |

---

## Tasks to Implement

### T1 — Library Scanner Service

**File:** `src/main/services/library-scanner.ts` (NEW)

This is the core backend service that scans the library directory on disk and populates the SQLite database. It must:

1. **Walk** the library root directory (`/mnt/bragi/Kavita/Doujins/` or user-configured)
2. **For each PDF** found in the `{Artist}/{Series?}/{Filename}.pdf` structure:
   - Use `pdf-lib` to extract embedded metadata:
     - `/Title` → title
     - `/Author` → split by commas → primary artist + all artists
     - `/Keywords` → extract `nhentai:(\d+)` for gallery ID, remaining tokens are tags
     - `/CreationDate` → date
   - Parse filename for `[nhentai-{id}]` prefix as gallery ID fallback
3. **Compare against database**:
   - If `gallery_id` matches an existing `library_item` → skip
   - If `gallery_id` is new → insert `library_item` + `library_item_artist` rows + `gallery` row (if not cached)
   - If no gallery ID → insert as `is_custom = 1` with metadata from PDF
   - If file no longer exists on disk → mark as removed
4. **Log results** to `library_scan_log` table with counts: total, new, removed, errors
5. **Report progress** back to renderer via IPC events for a progress bar

**IPC additions** (in `src/main/ipc/library.ipc.ts`):
- `library:scan` → triggers scanner, returns `{ scanning: true }` immediately, sends progress via `webContents.send('library:scanProgress', { current, total })`
- `library:getScanStatus` → returns last scan log entry

### T2 — Library Page UI

**File:** `src/renderer/src/components/library/LibraryPage.tsx` (REWRITE)

Replace the placeholder with a fully functional library browser:

1. **Toolbar** at top:
   - "Rescan Library" button (triggers `library:scan`, shows progress bar during scan)
   - "Add Custom" button (opens Custom Entry form — T4)
   - Search within library (text input, filters results client-side)
   - Sort dropdown: Date Added, Title, Artist, Page Count
2. **Grid of library items** — reuse `GalleryGrid` and `GalleryCard` components from search page:
   - Each card shows the same layout as search cards
   - Click opens detail or opens the PDF file in system viewer
   - Download status badge shows "In Library" by default
3. **Filter sidebar or dropdown**:
   - By artist (checkboxes populated from `getAllArtistNames`)
   - By series (checkboxes populated from distinct series_name values)
   - "Unmatched" toggle — shows only items without a nhentai gallery ID
4. **States**:
   - Loading: skeleton grid (12 cards)
   - Empty: "Library is empty" with Browse button
   - Error: "Library scan failed" with retry
   - Network mount unavailable: show cached results with warning banner

### T3 — Autocomplete Fields (Backend + UI)

**Backend (new IPC handler in `library.ipc.ts`):**
- `library:autocompleteArtists(query: string)` → returns top 10 artist names matching query, ranked by frequency in library
- `library:autocompleteSeries(query: string)` → returns top 10 series names matching query

**UI component:** `src/renderer/src/components/shared/AutocompleteInput.tsx` (NEW)
- Text input with dropdown suggestion list
- Debounced 150ms query to IPC
- Highlights matching portion of suggestion text
- Keyboard navigable (arrow keys + Enter)
- Allows free-text values not in suggestions (for new artists/series)
- Reusable across Custom Entry form and Series Assignment

### T4 — Series Assignment

**Files:** `src/renderer/src/components/library/SeriesAssignment.tsx` (NEW) + backend handler

1. **In Library view**: select one or more items (checkboxes on cards)
2. **Click "Assign Series"** → opens a dialog/modal with:
   - Autocomplete series input (reuses T3 component)
   - Preview of selected items
   - "Apply" button
3. **Backend handler** (`library:assignSeries`):
   - Update `library_item.series_name` for selected items
   - Embed series into each PDF's metadata via `metadata-writer.ts`
   - Move each PDF from `{Artist}/[nhentai-{id}] {Title}.pdf` to `{Artist}/{Series}/[nhentai-{id}] {Title}.pdf`
   - Create series subdirectory if needed
   - Delete empty parent directory if all files moved

### T5 — Custom Entry Form

**File:** `src/renderer/src/components/library/CustomEntryForm.tsx` (NEW — replaces the placeholder mention in the plan)

1. **Form fields**:
   - Title (required, text input)
   - Artists (required, multi-input chip field using AutocompleteInput — selecting adds a removable chip; free-text allowed for new artists)
   - Series (optional, AutocompleteInput)
   - Tags (free-text, comma-separated chips)
   - Language (dropdown: English, Japanese, Chinese, Other)
   - Date (date picker)
   - Cover image (optional, file picker for a custom cover)
   - Source (required, file picker: either a PDF file or an image folder)
2. **On submit**:
   - If image folder selected: convert to PDF via existing `pdf-generator.ts`
   - If PDF selected: copy/link to library
   - Embed entered metadata via `metadata-writer.ts`
   - Store under `{Primary Artist}/[nhentai-00000] {safe_title}.pdf` (placeholder ID for custom entries)
   - Insert into `library_item` table with `is_custom = 1`
3. **Validation**: Title and at least one artist required. Show inline errors.

### T6 — Library Item Detail + Actions

**Extend the existing GalleryDetail** or create a library-specific detail panel:

1. Clicking a library card shows:
   - Cover image
   - Full metadata (title, all artists, series, tags, language, date, page count, file size, file path)
   - "Open File" button (opens PDF in system viewer via `shell.openPath`)
   - "Open Folder" button (opens containing folder in file manager via `shell.showItemInFolder`)
   - "Edit Metadata" button (inline editing of title, artists, series, tags)
   - "Delete" button with confirmation dialog
2. **Right-click context menu** on library cards: same actions
3. **Multi-select mode**: checkboxes on cards → batch delete, batch series assign

---

## Files Summary

### New Files (6)
| File | Purpose |
|------|---------|
| `src/main/services/library-scanner.ts` | Walk library dir, extract PDF metadata, populate DB, report progress |
| `src/renderer/src/components/library/SeriesAssignment.tsx` | Autocomplete series input + apply to selected items |
| `src/renderer/src/components/library/CustomEntryForm.tsx` | Full metadata form for non-nhentai doujinshi |
| `src/renderer/src/components/shared/AutocompleteInput.tsx` | Reusable autocomplete with debounced IPC queries |
| `src/renderer/src/components/library/LibraryDetail.tsx` | Library item detail panel with actions |
| `src/renderer/src/components/library/LibraryCard.tsx` | Library-specific card variant (if needed beyond GalleryCard) |

### Modified Files (5)
| File | Changes |
|------|---------|
| `src/renderer/src/components/library/LibraryPage.tsx` | Full rewrite: toolbar, grid, filters, "Unmatched" mode |
| `src/main/ipc/library.ipc.ts` | Add: scan, autocompleteArtists, autocompleteSeries, assignSeries, delete, update |
| `src/preload/index.ts` | Add new library IPC methods to bridge |
| `src/preload/index.d.ts` | Type declarations for new methods |
| `src/renderer/src/stores/search.store.ts` | May reuse or create `library.store.ts` |

---

## Dependencies

No new npm packages needed. All required packages (`pdf-lib`, `better-sqlite3`, `drizzle-orm`) are already installed.

---

## Order of Implementation

1. **T1** — Library Scanner Service (backend foundation — everything else depends on having data)
2. **T2** — Library Page UI (browse scanned data)
3. **T3** — Autocomplete Fields (shared component needed by T4, T5)
4. **T4** — Series Assignment (depends on T3)
5. **T5** — Custom Entry Form (depends on T3)
6. **T6** — Library Detail + Actions (polish layer)

---

## Verification

After implementation:
- `npm run build` must pass with zero type errors
- On first app launch, clicking "Rescan Library" should populate the database from the existing 4,623 PDFs at `/mnt/bragi/Kavita/Doujins/`
- Library page should show all items in a grid with artist/series/title
- "Unmatched" filter should show ~245 items with `[nhentai-00000]` prefix
- Custom entry form should accept manual metadata and produce a PDF in the correct library location
- Series assignment should move files from artist root into series subdirectory
