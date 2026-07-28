# Nhentai Doujin Downloader — Revised Architecture & Implementation Plan

## Part 1: Current-State Audit Summary

### 1.1 What Exists Today

The project is a Python/Tkinter desktop tool with two active scripts:

| Script | Role |
|--------|------|
| [NhentaiPDF_Converter_Tagger.py](NhentaiPDF_Converter_Tagger.py:1) | Scans folders for images or `.txt` files containing gallery IDs, downloads images from nhentai CDN, converts to PDF via reportlab, embeds metadata via Calibre CLI |
| [Nhentai_ImageLibrary_completer.py](Nhentai_ImageLibrary_completer.py:1) | Recovers incomplete qBittorrent downloads by re-fetching images from nhentai CDN |

Four legacy scripts ([oldScripts/](oldScripts/)) provide earlier iterations of PDF conversion, metadata tagging, Jellyfin/Kavita ComicInfo.xml generation, and PDF-to-image extraction.

### 1.2 Live Library Analysis

The production library at `/mnt/bragi/Kavita/Doujins/` follows this structure:

```
Doujins/
├── {Artist Name}/
│   └── {Title}.pdf
├── {Artist A, Artist B}/
│   └── {Title}.pdf
├── Unknown/
├── GrimmyDraws/
├── Varking/
├── Zelhypno/
├── Zephyrgales/
├── .driveinfo.calibre
└── .metadata.calibre
```

- **500+ artist directories**, each containing one or more PDF files
- PDFs have Calibre-embedded metadata (title, author, series, tags, date)
- No ComicInfo.xml files present; metadata lives inside PDFs
- Some artist directories are multi-artist collaborations (comma-separated names)
- `Unknown/` directory exists for items without matched artists
- The `.driveinfo.calibre` confirms prior Calibre management
- The application currently requires Calibre's `ebook-meta` CLI in PATH

### 1.3 Critical Pain Points

1. **Calibre dependency**: `ebook-meta` must be installed and in PATH; breaks if Calibre is not present
2. **No library awareness**: The tool does not know what already exists in the library; no deduplication
3. **Tkinter UI**: Dated, non-responsive, no dark mode, no accessibility
4. **Sequential downloads**: One image at a time; a 100-page gallery takes 100+ sequential HTTP requests
5. **No persistence**: Crash = all queue state lost
6. **Windows-only**: Hardcoded `F:/` paths, `.bat` launchers
7. **No series support**: Series is set in Calibre but not managed by the tool
8. **No custom entries**: Cannot add doujinshi not on nhentai
9. **No API key support**: Stuck at unauthenticated rate limits (30 req/min)
10. **Monolithic architecture**: 850-line single file mixing UI, API, PDF generation, and file I/O

---

## Part 2: Revised Architecture

### 2.1 Core Design Philosophy

The rewrite is a **lightweight, focused download tool for doujinshi** — not a full nhentai frontend. It integrates directly with the existing Kavita library on disk. Browsing, favorites, tags, and login are optional enhancements, never required for core operation.

### 2.2 Tech Stack

| Layer | Choice | Justification |
|-------|--------|---------------|
| Runtime | Electron 33 | Cross-platform desktop, filesystem access, native notifications |
| Renderer | React 18 + TypeScript 5 | Component model, type safety, ecosystem |
| Styling | Tailwind CSS 4 | Utility-first, dark mode built-in, zero runtime |
| State (client) | Zustand | Minimal boilerplate, no providers needed |
| State (server) | TanStack React Query v5 | Caching, auto-refetch, infinite scroll, mutations |
| API client | `ky` + custom rate limiter | Modern fetch wrapper, retry, hooks, streaming |
| Database | SQLite via `better-sqlite3` | Embedded, zero-config, fast local queries |
| PDF generation | `pdf-lib` | Pure JS, no native dependencies, metadata embedding |
| Image processing | `sharp` | High-performance, streaming, WebP/AVIF support |
| Metadata | PDF metadata via pdf-lib (`/Keywords` for gallery ID) + XMP ISBN fallback | No Calibre dependency |
| Testing | Vitest (unit) + Playwright (E2E) | Modern, fast, parallel |
| Packaging | electron-builder | Auto-update, AppImage/NSIS/DMG |

### 2.3 Why Not Python/Tkinter

| Concern | Python/Tkinter | Electron/React+Tailwind |
|---------|---------------|--------------------------|
| Cross-Platform UI | Manual, platform-inconsistent | Native-feeling, responsive |
| Dark Mode | Not available | Built into Tailwind |
| File System | Good (stdlib) | Good (Node.js fs) |
| PDF Generation | reportlab (mature) | pdf-lib (pure JS, adequate) |
| Database | sqlite3 (built-in) | better-sqlite3 (sync, fast) |
| Distribution | PyInstaller (fragile) | electron-builder (mature, auto-update) |
| Developer Experience | No hot-reload for GUI | Vite HMR, React DevTools |
| Accessibility | Minimal | ARIA-first with proper tooling |

---

## Part 3: API Exploitation

### 3.1 Endpoint Usage (Prioritized)

```
CORE (always built in, login optional for use):
├── GET /api/v2/galleries/{id}        → Gallery detail with tags, pages, metadata
├── GET /api/v2/cdn                   → Image server list
├── GET /api/v2/search                → Text search with filters
├── GET /api/v2/config                → Rate limit awareness
├── GET /api/v2/user                  → Validate key, show profile (built always, login optional)
└── GET /api/v2/user/favorites        → Paginated favorites list (built always, login optional)

ENHANCED (requires API key, implemented when needed):
├── POST/DELETE /api/v2/user/favorites/{id} → Sync favorites (future)
└── GET /api/v2/galleries/{id}/related → Discovery

OPTIONAL (nice-to-have):
├── GET /api/v2/tags                  → Tag autocomplete
├── GET /api/v2/artists/{id}          → Artist detail
├── GET /api/v2/groups/{id}           → Group detail
├── GET /api/v2/parodies/{id}         → Parody detail
└── GET /api/v2/characters/{id}       → Character detail
```

### 3.2 Search Parameters

```
GET /api/v2/search
  ?query={text}           Full-text, supports "exact phrase" and -exclude
  &sort={recent|popular|popular-today|popular-week|popular-month|popular-year}
  &page={n}
  &per_page={25}
  &language={english|japanese|chinese|...}
  &category={doujinshi|manga|artist-cg|...}
```

### 3.3 Rate Limiting

| Auth Level | Rate | Strategy |
|------------|------|----------|
| Anonymous | ~30 req/min | Token bucket, 2s inter-request delay, queue-aware |
| API Key | Higher (exact limit from `/api/v2/config`) | Dynamic from `X-RateLimit-*` response headers |

Rate limiter uses a token bucket with burst capacity. Download queue automatically spaces API calls. Image downloads hit CDN servers (not the API), so they do not consume API rate limit.

---

## Part 4: Library Integration

### 4.1 Directory Structure

The library root path is user-configurable (default: `/mnt/bragi/Kavita/Doujins/`). The on-disk structure:

```
{library_root}/
├── {Primary Artist}/
│   ├── {Series Name}/
│   │   └── [nhentai-{id}] {safe_title}.pdf
│   ├── [nhentai-{id}] {safe_title}.pdf     (standalone, no series)
│   └── [nhentai-00000] {safe_title}.pdf    (no nhentai ID, placeholder)
├── {Another Artist}/
│   ├── {Series Name}/
│   │   └── [nhentai-{id}] {safe_title}.pdf
│   └── [nhentai-{id}] {safe_title}.pdf
├── _Unsorted/                               (empty post-migration)
└── _migration_staging/                      (JSON log files)
```

Rules:
- ALL PDFs use `[nhentai-{id}] {safe_title}.pdf` naming. PDFs without a nhentai ID use placeholder `[nhentai-00000]`
- `safe_title` = title with filesystem-invalid chars stripped, truncated to ~180 bytes (CJK-safe) at last word boundary
- Series items nested in `{Series Name}/` subdirectory under the artist; standalone items flat under the artist
- Series directory names also truncated to 180 bytes for CIFS compatibility
- Multi-artist doujins stored under primary (first) artist only; all artists embedded in metadata
- PDFs with unreadable/missing metadata go to `_Unsorted/` (currently empty after migration)

### 4.2 Migration Strategy

The existing library has Calibre-managed folders with inconsistent naming (comma-separated artist folders, bare title filenames, no nhentai ID prefix). The migration runs on first launch:

1. **Scan phase**: Walk all directories, open every PDF, extract embedded metadata (Title, Author, Series, nhentai gallery ID from `/Keywords` `nhentai:{id}` token or XMP ISBN fallback)
2. **Classification**:
   - Has gallery ID + valid metadata → classify by primary artist + series
   - Has metadata but no gallery ID → classify by primary artist + series, flag for later ID matching
   - Unreadable or missing metadata → `_Unsorted/`
3. **Preview dialog**: Show the planned new structure with before/after paths for every file
4. **Execution** (after user approval):
   - Create new artist directories as needed (using primary artist from metadata, not folder name)
   - Create series subdirectories as needed
   - Move files to their new locations, applying the `[nhentai-{id}] {Title}.pdf` naming scheme
   - Delete empty source directories
   - Populate `library_item` and `library_item_artist` tables from metadata
5. **Rollback safety**: All operations are file moves (not copies or deletes). A detailed migration log is written to `~/.config/doujin-downloader/logs/migration-{date}.log` for manual recovery

#### 4.1.1 Multi-Artist Handling

When a doujin has multiple artists, it is stored under the **primary (first) artist's** directory only. All artists are recorded in the database and embedded in the PDF metadata. The Library UI can filter and group by any artist, regardless of which directory the file lives in.

For example, a doujin by artists "alpha" and "beta" is stored as:
```
{library_root}/alpha/{Title}.pdf
```
The database records both "alpha" and "beta" as linked artists. Browsing by "beta" in the Library shows this item alongside beta's solo works.

#### 4.1.2 Migration of Comma-Separated Folders

The existing library contains folders named `artist1, artist2, artist3` from Calibre's handling. A migration runs on first launch:

1. Detect folders whose name contains a comma
2. Extract the first artist name from the folder name
3. Create `{first_artist}/` directory if it does not exist
4. Move all PDFs from `artist1, artist2/` into `{first_artist}/`
5. Delete the now-empty `artist1, artist2/` folder
6. If `{first_artist}/` already exists, merge contents (no overwrites; name conflicts get a `_2` suffix)
7. Record all artists (from the original folder name) in the database

This migration is non-destructive: PDF files are moved, never deleted. A dry-run preview is shown before execution, listing all planned moves for user confirmation.

### 4.2 Library Scanning & Indexing

On first launch and on user-triggered re-scan:

1. Walk the library root directory
2. For each `{Artist}/{Title}.pdf`, read embedded PDF metadata (title, author, series, tags, date)
3. If a PDF's metadata includes a nhentai gallery ID (stored in `/Keywords` as `nhentai:{id}` token, or XMP ISBN fallback), link it to the corresponding gallery record
4. Build an in-memory + SQLite index mapping:
   - `gallery_id → file_path` (for nhentai-sourced items)
   - `title_hash → file_path` (for custom/non-nhentai items)
5. Display library contents in the app as a browsable grid

### 4.3 Download Status Integration

When browsing nhentai search results or gallery details, each item shows a status badge:

| State | Indicator |
|-------|-----------|
| **Downloaded** | Green checkmark + "In Library" |
| **Queued** | Orange clock + position in queue |
| **Downloading** | Blue spinner + progress percentage |
| **Not Downloaded** | No badge (or grey download icon) |

Status is determined by querying the local database for the gallery ID, not by filesystem polling (faster, works when library is on network storage).

### 4.4 Series Support

nhentai does not provide series grouping. The application supports manual series assignment:

1. In Library view, select one or more items
2. Assign a series name via an autocomplete text field that suggests existing series names as you type (queried from the local database)
3. Series metadata is written into the PDF's embedded metadata
4. Items belonging to the same series are visually grouped in the Library view
5. Existing Calibre series data is preserved and imported during library scan

### 4.5 Custom Doujin Entry

For doujinshi not available on nhentai:

1. Click "Add Custom" in the Library or via a dedicated button
2. Fill in a metadata form:
   - Title (required, free-text)
   - Artists (required, multi-input field with autocomplete): type to see existing artist names from the library; each selected artist becomes a chip/tag; supports adding new artist names not yet in the library; at minimum one artist required
   - Series (optional, autocomplete field): suggestions from existing series names as you type
   - Tags (free-text, comma-separated chips)
   - Language (dropdown)
   - Date (date picker)
   - Cover image (file picker)
3. Select the source PDF or image folder
4. The application processes it identically to nhentai downloads:
   - If images: convert to PDF with metadata embedding
   - If PDF: embed the entered metadata directly
5. The PDF is stored under the primary (first) artist's directory; all artists are linked in the database
6. The custom entry appears in the Library alongside nhentai-sourced items

### 4.6 Autocomplete Fields

Artist and Series input fields throughout the application provide typeahead suggestions sourced from the local database:

| Field | Source | Behavior |
|-------|--------|----------|
| Artist (multi) | `library_item_artist` table + nhentai gallery tags | Dropdown filtered as user types; selecting adds a chip; free-text allowed for new artists |
| Artist (single/primary) | Same source | Dropdown filtered as user types; free-text allowed |
| Series | `library_item.series_name` distinct values | Dropdown filtered as user types; free-text allowed for new series |

The autocomplete is implemented with a debounced (150ms) query to the local SQLite database via IPC, returning top 10 matches ranked by frequency in the library.

---

## Part 5: Application Architecture

### 5.1 Process Model

```
┌─────────────────────────────────────────────────────────┐
│                    Electron Main Process                 │
│                                                         │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌──────────┐ │
│  │ API      │ │ Download  │ │ PDF Gen  │ │ Library  │ │
│  │ Service  │ │ Manager   │ │ Service  │ │ Scanner  │ │
│  └────┬─────┘ └─────┬─────┘ └────┬─────┘ └────┬─────┘ │
│       │             │            │            │        │
│  ┌────┴─────────────┴────────────┴────────────┴────┐   │
│  │              SQLite Database                     │   │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────────┐  │   │
│  │  │ galleries │ │ library  │ │ download_queue │  │   │
│  │  └──────────┘ └──────────┘ └────────────────┘  │   │
│  └────────────────────────────────────────────────┘   │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │  IPC Bridge (typed, context-isolated)            │  │
│  └────────────────────┬─────────────────────────────┘  │
└───────────────────────┼────────────────────────────────┘
                        │
┌───────────────────────┼────────────────────────────────┐
│              Electron Renderer Process                  │
│  ┌────────────────────┴─────────────────────────────┐  │
│  │                   React App                       │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │  │
│  │  │ Zustand  │ │ React    │ │ Tailwind +       │ │  │
│  │  │ (UI state│ │ Query    │ │ Headless UI      │ │  │
│  │  │  store)  │ │ (cache)  │ │ (components)     │ │  │
│  │  └──────────┘ └──────────┘ └──────────────────┘ │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 5.2 Database Schema

```sql
gallery (
  id INTEGER PRIMARY KEY,
  media_id INTEGER NOT NULL,
  title_pretty TEXT NOT NULL,
  title_english TEXT,
  title_japanese TEXT,
  page_count INTEGER NOT NULL DEFAULT 0,
  favorites_count INTEGER DEFAULT 0,
  upload_date INTEGER,
  thumbnail_url TEXT,
  cover_url TEXT,
  raw_tags_json TEXT NOT NULL DEFAULT '[]',
  raw_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

library_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gallery_id INTEGER UNIQUE,
  is_custom INTEGER NOT NULL DEFAULT 0,
  custom_title TEXT,
  custom_tags TEXT,
  custom_language TEXT,
  custom_date TEXT,
  custom_cover_path TEXT,
  file_path TEXT NOT NULL,
  file_size INTEGER,
  format TEXT NOT NULL DEFAULT 'pdf',
  primary_artist TEXT NOT NULL,
  series_name TEXT,
  read_progress INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (gallery_id) REFERENCES gallery(id)
);

library_item_artist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_item_id INTEGER NOT NULL,
  artist_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (library_item_id) REFERENCES library_item(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_library_item_artist_unique
  ON library_item_artist(library_item_id, artist_name);

CREATE INDEX idx_library_item_artist_name
  ON library_item_artist(artist_name);

download_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gallery_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  error_message TEXT,
  output_format TEXT NOT NULL DEFAULT 'pdf',
  output_directory TEXT,
  queued_at INTEGER NOT NULL DEFAULT (unixepoch()),
  started_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (gallery_id) REFERENCES gallery(id)
);

download_page (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id INTEGER NOT NULL,
  page_number INTEGER NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  local_path TEXT,
  file_size INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (queue_id) REFERENCES download_queue(id) ON DELETE CASCADE
);

favorite (
  gallery_id INTEGER PRIMARY KEY,
  added_at INTEGER NOT NULL DEFAULT (unixepoch()),
  synced INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (gallery_id) REFERENCES gallery(id)
);

app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

library_scan_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scanned_at INTEGER NOT NULL DEFAULT (unixepoch()),
  total_items INTEGER NOT NULL DEFAULT 0,
  new_items INTEGER NOT NULL DEFAULT 0,
  removed_items INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT DEFAULT '[]'
);
```

### 5.3 Project Structure

```
doujin-downloader/
├── package.json
├── electron.vite.config.ts
├── tsconfig.json
├── tailwind.config.ts
├── resources/
│   └── icon.png
├── src/
│   ├── main/
│   │   ├── index.ts
│   │   ├── ipc/
│   │   │   ├── api.ipc.ts
│   │   │   ├── download.ipc.ts
│   │   │   ├── library.ipc.ts
│   │   │   └── settings.ipc.ts
│   │   ├── services/
│   │   │   ├── api-client.ts
│   │   │   ├── rate-limiter.ts
│   │   │   ├── download-manager.ts
│   │   │   ├── pdf-generator.ts
│   │   │   ├── metadata-writer.ts
│   │   │   ├── library-scanner.ts
│   │   │   └── file-utils.ts
│   │   ├── db/
│   │   │   ├── connection.ts
│   │   │   ├── schema.ts
│   │   │   ├── migrations/
│   │   │   └── repositories/
│   │   │       ├── gallery.repo.ts
│   │   │       ├── library.repo.ts
│   │   │       ├── download.repo.ts
│   │   │       └── settings.repo.ts
│   │   └── utils/
│   │       ├── sanitize.ts
│   │       ├── hash.ts
│   │       └── logger.ts
│   ├── preload/
│   │   ├── index.ts
│   │   └── index.d.ts
│   └── renderer/
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── routes.tsx
│       ├── components/
│       │   ├── layout/
│       │   │   ├── AppShell.tsx
│       │   │   ├── Sidebar.tsx
│       │   │   └── StatusBar.tsx
│       │   ├── search/
│       │   │   ├── SearchPage.tsx
│       │   │   ├── SearchBar.tsx
│       │   │   ├── GalleryGrid.tsx
│       │   │   └── GalleryCard.tsx
│       │   ├── gallery/
│       │   │   └── GalleryDetail.tsx
│       │   ├── downloads/
│       │   │   ├── DownloadPage.tsx
│       │   │   ├── DownloadItem.tsx
│       │   │   └── DownloadProgress.tsx
│       │   ├── library/
│       │   │   ├── LibraryPage.tsx
│       │   │   ├── LibraryGrid.tsx
│       │   │   ├── LibraryCard.tsx
│       │   │   └── CustomEntryForm.tsx
│       │   ├── settings/
│       │   │   └── SettingsPage.tsx
│       │   └── shared/
│       │       ├── StatusBadge.tsx
│       │       ├── EmptyState.tsx
│       │       ├── ErrorState.tsx
│       │       ├── LoadingSkeleton.tsx
│       │       └── ConfirmDialog.tsx
│       ├── hooks/
│       │   ├── useIpc.ts
│       │   ├── useLibrary.ts
│       │   └── useDownloads.ts
│       ├── stores/
│       │   ├── ui.store.ts
│       │   └── settings.store.ts
│       ├── queries/
│       │   ├── search.queries.ts
│       │   ├── gallery.queries.ts
│       │   ├── library.queries.ts
│       │   └── download.queries.ts
│       └── types/
│           ├── api.types.ts
│           ├── library.types.ts
│           └── download.types.ts
├── tests/
│   ├── unit/
│   │   ├── services/
│   │   └── components/
│   ├── integration/
│   └── e2e/
└── docs/
    ├── user-guide.md
    └── development.md
```

---

## Part 6: UI/UX Design

### 6.1 Shell Layout

```
┌──────────────────────────────────────────────────────────┐
│  Doujin Downloader                          [─] [□] [×]  │
├─────────────┬────────────────────────────────────────────┤
│             │                                            │
│  🔍 Search  │         Content Area                       │
│  📚 Library │         (Search, Library,                   │
│  ⭐ Favorites│          Favorites, Gallery Detail,         │
│  ⬇️ Queue   │          Downloads, Settings)               │
│  ⚙️ Settings│                                            │
│             │                                            │
│             │                                            │
├─────────────┴────────────────────────────────────────────┤
│  ⬇️ 2 active · 5 queued · 1,234 in library  nhentai.net ↗│
└──────────────────────────────────────────────────────────┘
```

Favorites is conditionally shown in the sidebar only when the user is logged in with a valid API key. The rest of the app functions fully without authentication — search, download, library, and settings all work anonymously.

### 6.2 Primary Views

**Search Page**

- Search bar at top with autocomplete (queries nhentai tag list when available, otherwise free-text)
- Optional filter bar (collapsible): language dropdown, sort select, category select
- Gallery grid showing results with infinite scroll
- Each card shows: cover thumbnail, title, artist, page count, language badge, **download status badge**
- Clicking a card opens the Gallery Detail sidebar/panel

**Gallery Detail** (slide-over panel)

- Cover image at larger resolution
- Title (pretty), alternative titles
- Tags as clickable chips (clicking navigates to a new search for that tag)
- Artist(s) and group(s) as clickable links
- Page count, upload date, favorites count
- **Download status badge** prominently displayed
- Primary action button: "Download" or "Already Downloaded ✓"
- Secondary: "Add to Queue" (if Download is configured for queue mode)

**Library Page**

- Grid of all items in the library, sorted by date added (newest first)
- Each card: cover thumbnail, title, artist, series (if set), format badge
- Click opens file in system viewer, or shows detail
- Filter bar: by artist, series, format, language, date range
- Search within library
- "Add Custom" button in the toolbar
- Right-click context menu: Edit Series, Edit Metadata, Open File, Open Folder, Delete

**Downloads Page**

- Two sections: Active downloads and Queued items
- **Active downloads**: each shows title, cover thumbnail, page progress bar (e.g., "12/34 pages"), speed, ETA
- Multiple simultaneous downloads with individual progress bars
- **Queued items**: reorderable list with drag handles, remove button
- Global controls: pause all, resume all, clear completed
- Failed items: show error message, retry button, max retry count indicator

**Settings Page**

- **Library**: Root path (with file picker), "Rescan Library" button, last scan timestamp
- **API**: Optional API key field with validation indicator
- **Downloads**: Concurrent download slots (1-8), output format (PDF), compression quality, page size
- **Interface**: Theme toggle (light/dark/system), language
- **Advanced**: "Rebuild Database" button, log viewer, cache management

### 6.3 State Matrix

| Component | Loading | Empty | Error | Edge |
|-----------|---------|-------|-------|------|
| Search Grid | 12 skeleton cards with shimmer | "No results" + illustration + suggested tags | "Search failed" + retry button | Rate limited: countdown timer overlay |
| Gallery Detail | Skeleton panel | N/A | "Gallery not found or removed" | 410 Gone: show cached metadata if available |
| Library Grid | Skeleton cards | "Library is empty. Download your first doujin or add a custom entry." + Browse button | "Library scan failed" + retry | Network mount unavailable: show cached index, warning banner |
| Download List | Skeleton items | "No active downloads. Search for doujinshi to get started." + Search button | Per-item error with retry/skip | Disk full: pause all, show warning |
| Settings | Form skeleton | N/A | Per-field validation error | API key invalid: inline error, red border |

### 6.4 Accessibility

- Full keyboard navigation (Tab, Enter, Escape, arrow keys for grid navigation)
- Focus trapping in modals and the gallery detail panel
- Screen reader announcements for download progress and status changes
- WCAG AA color contrast in both light and dark themes
- Text scaling support
- `prefers-reduced-motion` respected for all animations

---

## Part 7: Key Workflows

### 7.1 Download Flow

```
User searches/browses nhentai
        │
        ▼
User clicks "Download" on a gallery
        │
        ▼
Check: Already in library?
  ├── Yes → Show "Already Downloaded" with option to re-download
  └── No  → Continue
        │
        ▼
Fetch gallery metadata via API
  └── Cache metadata in SQLite
        │
        ▼
Add to download queue (persisted to SQLite)
        │
        ▼
Download Manager picks up item (respects concurrency limit)
        │
        ▼
Fetch CDN server list (cached 1 hour)
        │
        ▼
Download images in parallel within the item (up to 3 per item)
  ├── Each page: try primary CDN server
  ├── On failure: rotate to next CDN server
  └── On total failure: mark page failed, retry from queue
        │
        ▼
All images downloaded → convert to PDF via pdf-lib
        │
        ▼
Embed metadata into PDF:
  ├── Title (pretty)
  ├── Author (artist names, multiple authors comma-separated in /Author field)
  ├── Series (if assigned in app; Kavita reads this to group items)
  ├── Volume (auto-incremented per series or user-set)
  ├── Tags (from API, written to /Keywords)
  ├── Date (upload date, written to /CreationDate)
  └── Gallery ID: appended to /Keywords as `nhentai:{id}` token
        │
        ▼
Determine output path:
  ├── Has series → {root}/{Primary Artist}/{Series Name}/[nhentai-{id}] {safe_title}.pdf
  └── No series  → {root}/{Primary Artist}/[nhentai-{id}] {safe_title}.pdf

The `[nhentai-{id}] {safe_title}.pdf` naming scheme applies universally. Items with a series simply reside in a series subdirectory. Safe title truncation: 120 chars at last word boundary. Filesystem-invalid characters stripped.
        │
        ▼
Update library database, mark download complete
        │
        ▼
Send system notification (optional)
```

### 7.2 Library Scan Flow

```
User clicks "Rescan Library" or app launches
        │
        ▼
Walk library root recursively
        │
        ▼
For each {Artist}/{Title}.pdf:
  ├── Read embedded PDF metadata
  ├── Extract nhentai gallery ID if present
  ├── Check against library database
  │   ├── Known ID, same path → skip
  │   ├── Known ID, new path → update path
  │   ├── New ID → insert library_item, link to gallery
  │   └── No ID → insert as custom item with metadata from PDF
  └── Record timestamp
        │
        ▼
Detect removed items:
  └── DB entries with paths no longer on disk → mark as removed
        │
        ▼
Update scan log, report: {new} new, {removed} removed, {total} total
```

### 7.3 Custom Entry Flow

```
User clicks "Add Custom"
        │
        ▼
Form displayed:
  ├── Title (required, free-text)
  ├── Artists (required, multi-input chip field with autocomplete from existing library artists)
  ├── Series (optional, autocomplete field suggesting existing series)
  ├── Tags (comma-separated chips)
  ├── Language (dropdown)
  ├── Date (date picker)
  └── Source (file picker: PDF or image folder)
        │
        ▼
User submits
        │
        ▼
If image folder:
  └── Convert to PDF via pdf-lib (same pipeline as download)
If PDF:
  └── Open existing PDF with pdf-lib
        │
        ▼
Embed entered metadata into PDF
        │
        ▼
Move/copy to library: {root}/{Primary Artist}/{safe_title}.pdf
        │
        ▼
Insert into library database with is_custom = 1
        │
        ▼
Appear in Library alongside nhentai items
```

---

## Part 8: Migration from Calibre

### 8.1 Current State

The existing library has PDFs with Calibre-embedded metadata. The application must read this metadata without Calibre installed.

### 8.2 Strategy

1. Use `pdf-lib` to extract existing metadata from PDFs during library scan
2. Parse Calibre-specific metadata fields (series, tags, artist list, gallery ID from ISBN)
3. Preserve all existing metadata; never overwrite unless user explicitly edits
4. For new downloads, write metadata using `pdf-lib`'s native API
5. The comma-separated folder migration runs on first launch (see Section 4.1.2)
6. If a structural change is ever needed in the future, a conversion script will be provided alongside the release

### 8.3 Full Library Restructure Migration

The existing library has Calibre-managed folders with:
- Comma-separated multi-artist folder names (e.g., `akino sora, rakko, asahina hikage, akagi asahito, ...`)
- Bare title filenames without nhentai ID prefix
- No series subdirectories (series embedded in PDF metadata only)

The migration ignores existing folder names entirely and rebuilds from embedded PDF metadata. Full details in Section 4.2. The migration creates a clean structure where:
- Each PDF is named `[nhentai-{id}] {Title}.pdf`
- Multi-artist doujins go under the primary (first) artist only
- Series items get nested in series subdirectories
- PDFs with unreadable metadata go to `_Unsorted/`

### 8.4 Metadata Mapping

| Calibre Field | PDF Metadata Key | Application Field |
|---------------|-----------------|-------------------|
| Title | `/Title` | Title |
| Author(s) | `/Author` | Artist(s) → split into `library_item_artist` rows |
| Series | Calibre XMP `{http://calibre-ebook.com/xmp-namespace}series` | Series |
| Tags | `/Keywords` (comma-separated) | Tags |
| Published | `/CreationDate` | Date |
| Gallery ID | `/Keywords` as `nhentai:{id}` token (primary) | Gallery ID |

**Gallery ID Storage:**

The nhentai gallery ID is embedded in the PDF's `/Keywords` docinfo field as a distinct `nhentai:{id}` token alongside existing tag keywords. Example: `big breasts, english, nakadashi, nhentai:224257`.

At read time, the library scanner extracts the ID by regex-matching `nhentai:(\d+)` from `/Keywords`. As a fallback (for legacy Calibre-managed PDFs that predate this migration), it also checks the XMP `{http://ns.adobe.com/pdfx/1.3/}isbn` field.

**Why `/Keywords` instead of XMP:**
- Pikepdf 10.x cannot reliably persist new XMP namespace fields to PDFs that don't already have them (fields silently dropped on save)
- `/Keywords` is a standard docinfo field writable via `pikepdf.open() + pdf.save()` on any PDF
- The future Electron app's `pdf-lib` can also write to `/Keywords` without namespace registration issues

---

## Part 9: Implementation Roadmap

### Phase 1: Foundation

| Task | Description |
|------|-------------|
| P1.1 | Scaffold Electron + React + TypeScript + Vite + Tailwind project |
| P1.2 | Set up SQLite with better-sqlite3, Drizzle ORM, initial schema |
| P1.3 | Implement typed IPC bridge between main and renderer |
| P1.4 | Build API client with rate limiter (token bucket) |
| P1.5 | Build app shell (sidebar, routing, dark/light theme toggle) |
| P1.6 | Implement settings persistence (Zustand + SQLite) |

### Phase 2: Core Download Pipeline

| Task | Description |
|------|-------------|
| P2.0a | Login UI: Settings page "Nhentai Account" section with API key input, validate-and-save via `GET /api/v2/user`, green/red status, clear button. Auth IPC handlers and preload exposure |
| P2.0b | Favorites page: gallery grid matching SearchPage pattern, paginated via `GET /api/v2/user/favorites?page={n}`, search-within-favorites, conditional sidebar item (only when logged in), `/favorites` route with auth guard |
| P2.1 | Search page: search bar, gallery grid, infinite scroll, gallery cards with download status |
| P2.2 | Gallery detail panel: metadata display, tag chips, download button |
| P2.3 | Download manager: queue persistence, concurrent downloads (configurable slots), per-page retry with CDN rotation |
| P2.4 | PDF generator: image→PDF via pdf-lib, compression, page sizing |
| P2.5 | Metadata writer: embed title/author/tags/date/gallery ID into PDFs via pdf-lib |
| P2.6 | Downloads page: active/queued lists, progress bars, pause/resume/cancel |

### Phase 3: Library Integration

| Task | Description |
|------|-------------|
| P3.1 | Full library restructure migration: metadata-driven scan, preview dialog, move files to `{Artist}/{Series?}/[nhentai-{id}] {Title}.pdf` structure, `_Unsorted/` for unreadable items |
| P3.2 | Library scanner: walk directory, read PDF metadata, build index with multi-artist linking |
| P3.3 | Library page: grid view, sort, filter by artist (including secondary artists), search, "Unmatched" filter |
| P3.4 | Autocomplete fields: artist and series typeahead sourced from local database via debounced IPC queries |
| P3.5 | Download status badges: cross-reference gallery IDs against library DB |
| P3.6 | Series assignment: autocomplete series input, embed into PDF, auto-create series subdirectory and move file |
| P3.7 | Custom entry form: multi-artist chip input with autocomplete, full metadata pipeline |
| P3.8 | Gallery ID matching utility: scan library for PDFs missing gallery IDs, search nhentai by title + verify page count + tag overlap, present matches for user confirmation, apply IDs |
| P3.9 | EPUB output support: generate EPUB as an alternative to PDF (better size and loading performance in Kavita) |

### Phase 4: Optional Features

| Task | Description |
|------|-------------|
| P4.1 | Optional API key login with keychain storage |
| P4.2 | Favorites sync with nhentai account |
| P4.3 | Tag browsing and autocomplete |
| P4.4 | Artist/group browsing |
| P4.5 | Related galleries discovery |
| P4.6 | System notifications on download completion |
| P4.7 | Auto-update via electron-updater |

---

## Part 10: Non-Functional Requirements

### 10.1 Performance

| Metric | Target |
|--------|--------|
| App launch (cold) | < 2s |
| Search results render (50 cards) | < 200ms |
| Library scan (1000 items) | < 30s |
| PDF generation (100 pages, with compression) | < 30s |
| Memory (idle) | < 150MB |
| Memory (downloading 3 galleries concurrently) | < 400MB |
| SQLite DB size (10,000 gallery records) | < 50MB |

### 10.2 Data Storage Locations

| Data | Path | Notes |
|------|------|-------|
| SQLite database | `~/.config/doujin-downloader/db.sqlite` | XDG config directory |
| App settings | `~/.config/doujin-downloader/settings.json` | Fallback if DB unavailable |
| Download temp files | `~/.config/doujin-downloader/temp/` | Cleaned on completion |
| Logs | `~/.config/doujin-downloader/logs/` | Rotated, 30-day retention |
| Library (doujin PDFs) | `/mnt/bragi/Kavita/Doujins/` | User-configurable, mounted network storage |

### 10.3 Security

- API key encrypted at rest via Electron `safeStorage`
- Context isolation enabled; no `nodeIntegration` in renderer
- Content Security Policy enforced
- File writes restricted to configured library path
- All user input sanitized before API calls and file path construction

### 10.4 Testing

| Level | Tool | Scope |
|-------|------|-------|
| Unit | Vitest | Services, utilities, stores, repository methods |
| Integration | Vitest + MSW | API client, download pipeline, PDF generation, library scanner |
| E2E | Playwright + Electron | Search → download → convert → library integration flow |

### 10.5 Distribution

- **Windows:** NSIS installer
- **macOS:** DMG
- **Linux:** AppImage
- Auto-update via `electron-updater` with GitHub Releases

---

## Part 11: Resolved Decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | Concurrent download slots | 3 simultaneous downloads, each with up to 3 parallel page fetches. Total: 9 concurrent CDN connections max. CDN requests do not consume API rate limit; API calls (metadata fetch, search) are rate-limited separately via token bucket. |
| 2 | PDF naming convention | `{safe_title} [nhentai-{id}].pdf`. The `[nhentai-{id}]` tag is placed at the END of the filename to prevent Kavita's bracket parser from interpreting `[nhentai` as a series tag. Title truncated at 180 chars. |
| 3 | Library path | Default: `/mnt/bragi/Kavita/Doujins/`. App data (SQLite database, settings, download temp files, logs) stored separately at `~/.config/doujin-downloader/` following the XDG Base Directory Specification. |
| 4 | Login is always built, never required | The app has full login/auth capability built into the codebase (API client, rate limiter, IPC handlers, settings UI), but never requires a key for basic usage. Search, download, and library all work anonymously. Favorites tab is hidden from the sidebar when not logged in. The validated key is stored in `app_settings` table as `nhentai_api_key`. Rate limiter auto-upgrades from 30 req/min anonymous to the `/api/v2/config` value (default 60) when a key is present. |

## Part 12: All Questions Resolved

| # | Question | Decision |
|---|----------|----------|
| 1 | Concurrent download slots | 3 downloads × 3 page fetches, token-bucket rate limited |
| 2 | PDF naming convention | `{title} [nhentai-{id}].pdf` universally. Bracket at END to prevent Kavita bracket parser from creating phantom `[nhentai` series. Series items live in series subdirectory. |
| 3 | Library vs app data paths | Library: `/mnt/bragi/Kavita/Doujins/`; app data: `~/.config/doujin-downloader/` |
| 4 | Calibre marker files | Leave untouched, ignore |
| 5 | Kavita integration | No ComicInfo.xml or folder.jpg needed. Kavita reads embedded PDF metadata. Structure: `{Artist}/{Series}/[nhentai-{id}] {Title}.pdf` for series items, `{Artist}/[nhentai-{id}] {Title}.pdf` for standalone. EPUB output in Phase 3. |
| 6 | Matching unmatched PDFs | Separate utility script/function: search nhentai by title, verify page count and tag overlap before applying ID. "Unmatched" filter in Library view for items lacking gallery IDs. |

## Part 13: Migration Lessons Learned (2026-07-26)

### 13.1 nhentai API v2 Changes

The nhentai v1 API endpoints (`/api/gallery/{id}`, `/api/v1/search`) returned **403 Forbidden** throughout this migration. The v2 API at `https://nhentai.net/api/v2/search` works correctly with the following constraints:

- **Rate limits**: 15 req/min anonymous, 30 req/min with API key
- **Search response**: Returns `english_title`, `japanese_title`, `num_pages`, `id`, `tag_ids` (integer IDs, NOT tag names)
- **Gallery detail**: `GET /api/v2/galleries/{id}` returns full tag details with names, but rate-limited separately at 20 req/min anon
- **Pagination**: Max 25 results per page regardless of `per_page` parameter
- **API key format**: Passed as `Authorization: Key {key}` header

### 13.2 Batched Artist Search Strategy

The initial approach of searching individually for each of 1,502 PDFs by title was immediately rate-limited and found zero results. The successful approach:

1. **Group by primary artist**: 836 unique artists across 1,502 unmatched PDFs
2. **Batch search by artist**: For each artist, make ONE paginated search (`artist:"{name}"`), cache all galleries
3. **Match locally**: Compare page count (exact match required) + title similarity against cached galleries
4. **For "anonymous"**: Skip artist search (returns wrong results), use title-only search per PDF
5. **For single-PDF artists (≤5)**: Title-only search is actually faster than artist batch search (avoids pagination overhead)

**Result**: 1,257 IDs discovered (83.7% match rate), 245 could not be matched. 87% of PDFs were by artists with ≤5 PDFs each.

### 13.3 Pikepdf 10.x Metadata Limitations

This was the most painful discovery of the migration. **Pikepdf 10.8 cannot reliably persist metadata changes to PDFs.** Specific findings:

| Method | Result |
|--------|--------|
| `allow_overwriting_input=True` + modify docinfo | **Silently drops changes** on save (pikepdf bug) |
| `pdf.open_metadata()` + `xmp.set()` for NEW namespaces | **Silently drops new XMP namespace fields** (can only modify existing) |
| `pdf.save()` with `compress_streams=False` + `stream_decode_level` | **Corrupts docinfo**, emptying `/Keywords` on most PDFs |
| `pdf.save(str(tmp))` with NO options, then `shutil.move()` | **Works correctly** ✅ |

**The only reliable method**: Open without `allow_overwriting_input`, modify docinfo, `pdf.save(str(tmp))` with no options, then `shutil.move(str(tmp), str(dest))`.

Additionally: calling `pdf.open_metadata()` inside the same `with` block as docinfo modifications **silently discards docinfo changes**. XMP and docinfo writes must be done in separate passes.

### 13.4 Gallery ID Storage Format

Originally planned to use XMP `{http://ns.adobe.com/pdfx/1.3/}isbn` (Calibre's method), but pikepdf cannot add this namespace to PDFs that don't already have it. Final format:

```
/Keywords: "tag1, tag2, nhentai:224257, tag3"
```

The gallery ID is embedded as a `nhentai:{id}` token within the existing `/Keywords` docinfo field. At read time, the library scanner regex-matches `nhentai:(\d+)` from `/Keywords`. Legacy PDFs that predate this migration may only have the ID in XMP ISBN — the scanner checks that as a fallback.

### 13.5 CIFS Filesystem Quirks

The library lives on a CIFS network mount which introduced several challenges:

- **Filename character transformation**: Chinese/Japanese characters in filenames are transformed to ASCII equivalents (e.g., `合集` → `He Ji`). The metadata INSIDE the PDFs is unaffected — only filesystem names are changed.
- **Cross-device moves**: `os.replace()` between `/tmp` and the CIFS mount fails (Errno 18). Temp files must be written to the same filesystem.
- **Filename length**: CIFS enforces a 255-byte-per-component limit. Combined with `[nhentai-XXXXXX] ` prefix (17 chars) and multi-byte CJK titles (3 bytes/char), the title portion must be limited to ~180 bytes.

### 13.6 Script Execution Summary

| Phase | Script | Time | Result |
|-------|--------|------|--------|
| 1 | Pre-flight checks | <1 min | 4,623 PDFs confirmed |
| 2 | Consolidation | ~30s | All PDFs to `_migration_staging/` |
| 3 | API ID Discovery | ~4 hours | 1,257 found, 245 unmatched |
| 3b | Embed IDs | ~30 min | 4,378 IDs in `/Keywords` |
| 4 | Two-bucket sort | ~22s | 4,378 → `_with_id/`, 245 → `_without_id/` |
| 5 | Rebuild structure | ~5 min | 1,862 artist directories |
| 6 | Cleanup | ~5s | 901 empty dirs removed |
| 7 | Verification | <1 min | All checks passed |

Total migration time: approximately 5 hours (dominated by API rate-limited search).

### 13.7 Key Lessons for Future Development

1. **Never trust pikepdf's in-place editing** — always use `pdf.save(tmp)` + `shutil.move()`
2. **XMP is unreliable for NEW namespaces** — use docinfo fields (`/Keywords`, `/Subject`) instead
3. **Rate-limit all API calls** — nhentai aggressively rate-limits even with API keys. Batch by artist when possible.
4. **Test metadata persistence on the actual filesystem** — CIFS caching, filename encoding, and byte limits all differ from local storage
5. **Use byte-based filename truncation** for CJK content, not character-based
6. **Idempotency is critical** — every script saves progress so a crash mid-run can be resumed
