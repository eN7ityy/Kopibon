# Phase 5 — Polish, Onboarding & Discovery: Handoff Brief

## Status: Ready for Implementation

---

## What's Already Done (from Prior Phases)

| Feature | Status |
|---------|--------|
| Search, Favorites, Library tabs with shared components | ✅ |
| Download pipeline (queue → PDF → metadata → library) | ✅ |
| Metadata embedding (all 11 Kavita fields) | ✅ |
| API key auth with safeStorage encryption | ✅ |
| Library scanner with worker thread | ✅ |
| PDF compression options in Settings | ✅ |
| Gallery detail overlay | ✅ |
| Drag-freeze fix on all images | ✅ |
| Gallery detail in-memory cache | ✅ |

---

## Phase 5 Tasks

### F1 — First-Install Database Seeding

**Problem:** A fresh install has no default settings in SQLite. The `connection.ts` creates the DB and runs migrations, but `app_settings` starts empty. The settings store has JS defaults (library path, concurrency, etc.) but these aren't persisted until the user clicks "Save Settings". On app restart before saving, settings are lost.

**Fix in [`src/main/db/connection.ts`](src/main/db/connection.ts):**
After running migrations, check if `app_settings` is empty. If so, seed default values:

```typescript
function seedDefaults(): void {
  const db = getDatabase()
  const count = db.select({ count: sql<number>`count(*)` }).from(appSettings).get()
  if (count?.count === 0) {
    settingsRepo.set('libraryPath', '/mnt/bragi/Kavita/Doujins/')
    settingsRepo.set('downloadConcurrency', '3')
    settingsRepo.set('theme', 'system')
    settingsRepo.set('outputFormat', 'pdf')
    settingsRepo.set('compressPdf', 'true')
    settingsRepo.set('compressionQuality', '80')
    settingsRepo.set('pageSize', 'Dynamic')
    settingsRepo.set('blackBackground', 'true')
  }
}
```

Also handle the case where the DB file or `~/.config/doujin-downloader/` directory doesn't exist — create it on first app launch.

### F2 — Button Click Feedback

**Problem:** Buttons (especially Download, Search, Validate & Save) have no press animation. They feel "stiff". Clicking them shows no visual response.

**Fix:** Add Tailwind active states to all buttons:
- `active:scale-95` — slight shrink on press
- `active:opacity-90` — slight dim on press
- `transition-transform duration-75` — snappy animation

Apply globally to all `<button>` elements by adding to existing class patterns. Check:
- Download button in GalleryDetail
- Search button in SearchPage
- Validate & Save in SettingsPage
- All action buttons in LibraryPage (Rescan, Add Custom, batch actions)
- Prev/Next pagination buttons
- Sidebar nav items (already have hover, need active press)

### F3 — Downloads Tab Live Updates

**Problem:** The Downloads tab currently polls every 2 seconds. When nothing is downloading, it shows empty state. But the StatusBar (bottom bar) shows live counts. The Downloads page should:
1. Show real-time progress via IPC events (not just polling)
2. Clearly indicate "downloading" vs "idle" states
3. Show per-item page progress, speed, ETA

**Current state check:** [`DownloadsPage.tsx`](src/renderer/src/components/downloads/DownloadsPage.tsx) should already have this. Verify it works end-to-end:
- Listen for `download:progress` IPC events from main process
- Show active downloads with progress bars in real-time
- Show queued items below
- Empty state when nothing is downloading/queued
- Pause/Resume/Cancel per item
- Pause All / Resume All global controls

If any of these are broken or missing, implement them.

Also ensure the StatusBar counts update in real-time (not just on mount):
- Active count from `download:progress` events or 2s polling
- Queued count from download queue
- Library count from `library.count()`

### F4 — System Notifications

**Feature:** Send a desktop notification when a download completes.

- Use Electron's [`Notification`](https://www.electronjs.org/docs/latest/api/notification) API
- In [`download-manager.ts`](src/main/services/download-manager.ts), after a download completes successfully, create a notification:
  ```
  title: "Download Complete"
  body: "{title} has been added to your library"
  ```
- Respect OS notification settings (user can disable in system preferences)
- Add a setting toggle "Show download notifications" (default: on) in Settings → Downloads

### F5 — Auto-Update

**Feature:** Enable automatic updates via `electron-updater`.

- Install `electron-updater` package
- Configure in [`electron-builder.yml`](electron-builder.yml) (publish to GitHub Releases)
- Add update check on app start (silent, check for updates)
- If update available: show notification with "Update Available" + "Download & Install" button
- Add "Check for Updates" button in Settings → Advanced
- Show current version in Settings footer

### F6 — Related Galleries Discovery

**Feature:** In GalleryDetail, show a "Related" section below the tags.

- After loading gallery detail, call `GET /api/v2/galleries/{id}/related`
- Show up to 5 related galleries as small horizontal-scroll cards
- Each card: thumbnail + title, clickable to open that gallery's detail
- Uses the in-memory gallery cache to avoid re-fetching details already seen

### F7 — Artist/Group Browsing

**Feature:** Clicking an artist/group tag in GalleryDetail already searches for that artist. Add a dedicated artist view.

- When an artist search is performed (`artist:"Name"`), show a small header above results:
  "Showing works by **Artist Name**" with a link to open on nhentai
- Add artist info if available from `GET /api/v2/artists/{id}` or `GET /api/v2/groups/{id}`
- The API endpoints return artist/group metadata including follower count and all works

---

## Files Affected

| File | Change |
|------|--------|
| [`src/main/db/connection.ts`](src/main/db/connection.ts) | F1: seed default settings on first DB creation |
| [`src/renderer/src/assets/styles.css`](src/renderer/src/assets/styles.css) | F2: global button active states via Tailwind `@layer base` |
| Multiple component files | F2: verify all buttons have active feedback |
| [`src/renderer/src/components/downloads/DownloadsPage.tsx`](src/renderer/src/components/downloads/DownloadsPage.tsx) | F3: verify live progress, fix if broken |
| [`src/renderer/src/components/layout/StatusBar.tsx`](src/renderer/src/components/layout/StatusBar.tsx) | F3: real-time counts |
| [`src/main/services/download-manager.ts`](src/main/services/download-manager.ts) | F4: send Notification on completion |
| [`src/renderer/src/components/settings/SettingsPage.tsx`](src/renderer/src/components/settings/SettingsPage.tsx) | F4: notification toggle |
| [`electron-builder.yml`](electron-builder.yml) + `package.json` | F5: electron-updater config |
| [`src/main/index.ts`](src/main/index.ts) | F5: auto-update check on start |
| [`src/renderer/src/components/gallery/GalleryDetail.tsx`](src/renderer/src/components/gallery/GalleryDetail.tsx) | F6: related galleries section |
| [`src/renderer/src/components/search/SearchPage.tsx`](src/renderer/src/components/search/SearchPage.tsx) | F7: artist header when searching by artist |

---

## Implementation Order

F1 (seeding) → F2 (button feedback) → F3 (downloads live) → F4 (notifications) → F5 (auto-update) → F6 (related) → F7 (artist browsing)

F1–F3 are bug fixes/polish (highest priority). F4–F7 are new features.

---

## Verification

- `npm run build` passes with zero type errors
- Fresh install: delete `~/.config/doujin-downloader/db.sqlite`, launch app → settings appear with defaults
- Pressing Download/any button shows visual feedback
- Downloads tab shows live progress when downloading
- Desktop notification appears on download completion
- "Check for Updates" button appears, rest is silent until release is configured
