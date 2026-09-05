# 02 — IPC surface

The complete contract between renderer and main process. Phase B (Electron UI
against the Rust core) must reproduce it channel for channel; Phase C replaces
one side of it. Verified against the working tree, not the 1.x docs:

```
grep -oE "'[a-zA-Z]+:[a-zA-Z]+'" src/preload/index.ts | sort -u | wc -l   # 144
grep -c "ipcRenderer.invoke" src/preload/index.ts                        # 131
grep -c "ipcRenderer.on"     src/preload/index.ts                        # 14
```

144 unique channel strings = **130 request/response** channels (131 invoke call
sites — `library:syncBatch` is bound twice: as `syncBatch` at preload `:219`
and as `resumeSync` at `:226`) + **14 main→renderer events**, across **16
namespaces**. All 130 are registered in main; main additionally registers
`auth:getRateLimits`, which nothing exposes (see §4). Handler paths below are
relative to `src/main/ipc/` unless marked `index.ts`.

---

## 1. Envelope and conventions

### 1.1 The envelope (`handle.ts:53-81`)

Every request/response channel is registered through the `handle()` wrapper.
On a thrown error it catches, logs with a fresh `errorId`, and returns:

```jsonc
{ "success": false, "error": "<err.message>", "errorId": "<Crockford base32>" }
```

`errorId` is minted by `newErrorId()` (`../services/logger.ts:100`): 8 random
bytes, Crockford base32. It is logged alongside the failure so a user can quote
it and the log line can be found.

**Success is not wrapped by the wrapper.** `handle()` passes the handler's
return through untouched (`handle.ts:64-72`); each handler builds its own
`{ success: true, data }`. Consequences the Rust core must match:

- Most channels resolve to `{ success: true, data: … }`.
- A few resolve to bare `undefined` on success — `shell:openExternal`,
  `shell:openPath`, `shell:showItemInFolder`, `log:write`, `log:openFolder`
  (all registered in `auth.ipc.ts:142-152` and `index.ts:245, :293`). The
  renderer awaits and ignores the value.
- A few return `success` as a *boolean result* rather than an envelope:
  `download:pause/resume/cancel` return `{ success: <manager result> }`
  (`download.ipc.ts:82-95`) — there is no `data` and no `errorId` when the
  operation itself failed.
- Several handlers fail softly: they return `{ success: false, error }`
  directly (e.g. `kavita:testConnection` `kavita.ipc.ts:25`,
  `library:getSeriesFacts` `library.ipc.ts:626`) rather than throwing, so no
  `errorId` is minted. Rust core must distinguish thrown (envelope with
  `errorId`) from returned-failure (no `errorId`).

Four channels bypass `handle()` entirely, registered with raw
`ipcMain.handle` in `index.ts`: `log:write` (:245), `log:setLevel` (:269),
`log:getLevel` (:276), `log:openFolder` (:293). They hand-roll the envelope
(`log:setLevel` returns `{success:false, error:'Invalid level'}` on a bad
level; `log:write` returns nothing and silently drops an invalid level).

### 1.2 In-flight tracking, slow-handler warning, freeze watchdog

- Every `handle()` registration records the channel and start time in a
  module-level `Map` (`handle.ts:31`), removed in `finally` (:78-80).
- `inFlightHandlers()` (`handle.ts:34-39`) exports it sorted longest-first.
- Any handler that runs ≥ 250 ms (`SLOW_HANDLER_MS`, `handle.ts:49`) logs a
  warning even on success (`handle.ts:67-70`) — main is single-threaded, so a
  slow handler is a frozen window for everything behind it.
- The window's `unresponsive` handler (`index.ts:58-68`) logs the in-flight
  list and attributes the freeze: in-flight handlers present → "main", none →
  "renderer". A Rust core replacing main must offer an equivalent
  attribution story (which request was executing when the UI hung), because
  the log analysis depends on it.

### 1.3 Event subscriptions and unsubscribe closures

All 14 event subscriptions live in `src/preload/index.ts` and every one
returns an unsubscribe closure (`() => ipcRenderer.removeListener(…)`) — e.g.
`:272-274`, `:284`, `:306`. The renderer relies on this in `useEffect`
cleanups. A Rust-side event channel needs the same per-subscriber teardown.

### 1.4 Structured-clone payload rules

Arguments and returns cross the structured-clone boundary. Rules the port
must respect (or improve deliberately):

- **Map → plain object.** `tags:resolveForGalleries` builds a `Map` and
  converts with `Object.fromEntries` before returning
  (`search-settings.ipc.ts:217-220`); the comment records that a Map does not
  survive the clone in a usable form. The Rust core should return JSON
  objects keyed by gallery id.
- **Binary → base64 string.** `library:getThumbnail`
  (`library.ipc.ts:1723-1725`), `file:read` (:2710-2716), `cbz:readPage`
  (:2870-2873) and `library:previewSource` (:3791-3803) all read a buffer and
  return `base64` (or a `data:image/jpeg;base64,…` URL). No channel ships a
  Buffer/Uint8Array today.
- **No functions, no class instances.** Everything else crossing is plain
  objects, arrays, strings, numbers, booleans, null.
- Events are broadcast with `webContents.send` either to the originating
  window (`library.ipc.ts:1030-1072, :1298, :2058, :2583, :2639, :2663,
  :3060`) or to **all** windows (`download.ipc.ts:12-17`,
  `library.ipc.ts:1611-1617`, `updater.ipc.ts:74-79`). A Rust core must
  decide per event which semantics it reproduces; all-windows is the safer
  default.

---

## 2. Request/response channels — all 130

Columns: preload = `ipcRenderer.invoke` line in `src/preload/index.ts`;
handler = registration line. "Mutates" names what changes: `DB` (rows), `file`
(on-disk), `proc` (main-process state such as module flags and caches), `os`
(filesystem layout moves). ⚑ = Electron-specific, see §6.

### 2.1 `api:*` (12) — nhentai HTTP API (`api.ipc.ts`)

| Channel | preload | handler | Payload → return (`data`) | Mutates | Semantics |
|---|---|---|---|---|---|
| `api:search` | :29 | api.ipc.ts:57 | `(query, {page?, sort?})` → paged gallery list | — | nhentai search; sort ∈ date/popular/popular-today/week/month |
| `api:getLatest` | :31 | :78 | `(page?=1)` → paged gallery list | — | Browse latest |
| `api:getPopular` | :32 | :83 | `()` → gallery list | — | Browse popular |
| `api:getGallery` | :30 | :88 | `(id)` → GalleryDetail | proc | 300-entry / 15-min LRU cache (`api.ipc.ts:13-47`) |
| `api:getCdnConfig` | :33 | :98 | `()` → CDN config object | — | CDN host list for image downloads |
| `api:getConfig` | :34 | :103 | `()` → API config | — | exposed as `api.getApiConfig` — method name ≠ channel |
| `api:setApiKey` | :35 | :108 | `(key\|null)` → none | proc | **Swaps the rate-limiter tier** on the shared client |
| `api:getFavorites` | :37 | :113 | `(page, query?)` → paged favorites | — | Authenticated favorites page |
| `api:getUser` | :38 | :121 | `()` → user object | — | Used for key validation display |
| `api:getRelatedGalleries` | :39 | :126 | `(id)` → gallery list | — | Deliberately not cached (list, not detail) |
| `api:addFavorite` | :40 | :133 | `(galleryId)` → none | proc | Remote favorite; **invalidates the gallery cache** |
| `api:removeFavorite` | :41 | :140 | `(galleryId)` → none | proc | Same invalidation |

### 2.2 `auth:*` (4) — key storage (`auth.ipc.ts`)

| Channel | preload | handler | Payload → return | Mutates | Semantics |
|---|---|---|---|---|---|
| `auth:validateKey` | :45 | auth.ipc.ts:83 | `(key)` → `{username}` | DB, proc | Tests via `GET /user`; persists encrypted via `safeStorage` (`:14-33`); throws `'Invalid API key'` (envelope+errorId) |
| `auth:getAuthStatus` | :46 | :103 | `()` → `{loggedIn, username}` | — | Main-process module state only |
| `auth:setKey` | :47 | :111 | `(key)` → none | proc | Sets client key **without validation** (startup restore) |
| `auth:clearKey` | :48 | :120 | `()` → none | DB, proc | Drops key, reverts limiter to anonymous 30 req/min |

Dead sibling: `auth:getRateLimits` (`auth.ipc.ts:132`) is registered, returns
`{authenticated, buckets}` — and is exposed nowhere. See §4.

### 2.3 `shell:*` (3) — ⚑ Electron-only (`auth.ipc.ts`)

| Channel | preload | handler | Payload → return | Mutates | Semantics |
|---|---|---|---|---|---|
| `shell:openExternal` | :53 | auth.ipc.ts:142 | `(url)` → *undefined* | os | System browser |
| `shell:openPath` | :54 | :146 | `(path)` → *undefined* | os | Open file/folder with default handler |
| `shell:showItemInFolder` | :55 | :150 | `(path)` → *undefined* | os | Reveal in file manager |

### 2.4 `dialog:*` (2) — ⚑ Electron-only (`auth.ipc.ts`)

| Channel | preload | handler | Payload → return | Mutates | Semantics |
|---|---|---|---|---|---|
| `dialog:openFile` | :61 | auth.ipc.ts:156 | `({filters?})` → `path\|null` | — | Native open dialog; default filter PDF |
| `dialog:openDirectory` | :63 | :179 | `(defaultPath?)` → `path\|null` | — | `openDirectory,createDirectory`; starts at the given path |

### 2.5 `download:*` (13) — download queue (`download.ipc.ts`)

| Channel | preload | handler | Payload → return | Mutates | Semantics |
|---|---|---|---|---|---|
| `download:getAll` | :68 | download.ipc.ts:19 | `()` → queue rows | — | |
| `download:getById` | :69 | :24 | `(id)` → row\|null | — | |
| `download:getByStatus` | :70 | :29 | `(status)` → rows | — | |
| `download:getByGalleryId` | :71 | :34 | `(galleryId)` → row\|null | — | |
| `download:addToQueue` | :73 | :39 | `(galleryId, outputFormat?, outputDirectory?)` → `{id, duplicate?}` | DB, proc | Dedupes on `findActiveByGalleryId`; resolves format (arg → setting → pdf); inserts `queued` row; **kicks `processQueue()`** |
| `download:remove` | :74 | :75 | `(id)` → none | DB, proc | Cancels in-flight, deletes row + page rows |
| `download:pause` | :75 | :82 | `(id)` → `{success: bool}` | proc | Envelope `success` **is** the manager's result |
| `download:resume` | :76 | :87 | `(id)` → `{success: bool}` | proc | Same |
| `download:cancel` | :77 | :92 | `(id)` → `{success: bool}` | proc | Same |
| `download:pauseAll` | :78 | :97 | `()` → none | proc | |
| `download:resumeAll` | :79 | :102 | `()` → none | proc | |
| `download:getPages` | :80 | :107 | `(queueId)` → page rows | — | |
| `download:getStatusCounts` | :81 | :112 | `()` → `{active, queued}` | — | Sidebar badge counts |

### 2.6 `library:*` (59 unique; 60 call sites) — the bulk (`library.ipc.ts`)

| Channel | preload | handler | Payload → return | Mutates | Semantics |
|---|---|---|---|---|---|
| `library:getAll` | :86 | library.ipc.ts:390 | `()` → hydrated items | — | Paths hydrated relative→absolute at the boundary (`:368-387`) |
| `library:getById` | :87 | :396 | `(id)` → item\|null | — | |
| `library:getPaginated` | :97 | :461 | `(params)` → `{items, total,…}` | — | LIKE search over 7 columns; filters; sort `added\|title\|artist` |
| `library:getPaginatedGrouped` | :113 | :504 | `(params)` → `{rows:[{kind:'item',item}\|{kind:'series',…}], total, galleries}` | — | Grouping read from the **setting in main**, not the caller; flat mode returns the same shape, every row `kind:'item'` |
| `library:getSeriesMembers` | :124 | :553 | `(seriesId, filters?)` → `number[]` | — | Ids the series card stands for, honouring active filters |
| `library:getSeriesFacts` | :138 | :576 | `(seriesId, filters?)` → facts object | DB | Backfills missing page counts first (≤4 concurrent, ~25 ms/archive); error `'That series no longer exists'` |
| `library:findSeries` | :143 | :638 | `(name)` → series\|null | — | Null when grouping off or name holds ≤1 gallery |
| `library:getByGalleryId` | :144 | :426 | `(galleryId)` → item\|null | — | |
| `library:getAllIds` | :152 | :410 | `(filters?)` → `number[]` | — | "Select all" — respects filters on purpose |
| `library:getGalleryTags` | :154 | :444 | `(galleryId)` → typed tags | — | From cached gallery `raw_tags_json`; `[]` when only flat tags / no row |
| `library:search` | :155 | :957 | `(query)` → items | — | `searchByTitle` (no `file_path` matching) |
| `library:getArtists` | :156 | :963 | `(itemId)` → artist rows | — | |
| `library:getAllArtistNames` | :157 | :968 | `()` → `string[]` | — | |
| `library:getAllSeriesNames` | :158 | :973 | `()` → `string[]` | — | |
| `library:getAllTagNames` | :159 | :978 | `()` → `string[]` | — | Split from `custom_tags` — no tag join table |
| `library:count` | :160 | :983 | `()` → number | — | |
| `library:scan` | :161 | :990 | `(libraryRoot)` → `{scanning:true}` | DB, file, proc | Spawns singleton scanner worker (`:1001-1084`); refuses if scanning; progress via events; regroups series on complete |
| `library:pauseScan` | :162 | :1088 | `()` → none | proc | Worker message |
| `library:resumeScan` | :163 | :1093 | `()` → none | proc | |
| `library:cancelScan` | :164 | :1098 | `()` → none | proc | Retires worker |
| `library:getScanStatus` | :165 | :1113 | `()` → `{scanning, lastScan}` | — | Last row of `library_scan_log` |
| `library:reset` | :166 | :1103 | `()` → none | DB | Wipes `library_item_artist`, `library_item`, `library_scan_log`, `scan_queue` |
| `library:autocompleteArtists` | :168 | :1123 | `(query)` → `string[]` | — | LIKE over distinct values |
| `library:autocompleteSeries` | :169 | :1128 | `(query)` → `string[]` | — | |
| `library:autocompleteTags` | :170 | :1133 | `(query)` → `string[]` | — | |
| `library:assignSeries` | :174 | :1140 | `(entries[{id, seriesIndex?}], seriesName)` → `{updated, errors?}` | DB, file, os, proc | Embeds metadata per item, moves into `<artist>/<series>/`, regroups once, Kavita rescan fire-and-forget |
| `library:delete` | :176 | :1606 | `(id, alsoFromKavita?=false)` → none | DB, proc | Row only, file kept; broadcast `library:itemDeleted`; optional Kavita delete |
| `library:deleteFile` | :177 | :1631 | `(id)` → none | DB, file, proc | Unlinks then deletes row; Kavita delete fire-and-forget |
| `library:deleteMultiple` | :179 | :1658 | `(ids, alsoFromKavita?)` → none | DB, proc | Skips conversion-locked ids silently |
| `library:deleteFileMultiple` | :180 | :1681 | `(ids)` → none | DB, file, proc | Same + unlink |
| `library:getThumbnail` | :181 | :1715 | `(id)` → `data:image/jpeg;base64,…`\|null | — | **Polled per card every 2 s** (see §5.1); null until cover file exists |
| `library:getPageCount` | :183 | :830 | `(id)` → number\|null | DB | Stored value wins; else counts archive (~25 ms) **and backfills the row** |
| `library:setGalleryId` | :186 | :920 | `(itemId, galleryId\|null)` → `{galleryId}` | DB, file, os | Attach/detach nhentai id; renames file marker; moves thumbnail with the path |
| `library:updateMetadata` | :191 | :1735 | `(id, metadata, libraryRoot?)` → `{newPath}` | DB, file, os, proc | Edits DB, re-embeds via cached-gallery merge (`metaForItem` :327-358), moves on artist/series change, regroups on series change, Kavita rescan |
| `library:addCustom` | :193 | :1261 | `(metadata, libraryRoot)` → `{id, filePath, format}` | DB, file, proc | Builds PDF/CBZ from folder or PDF; progress via `library:addCustomProgress`; seeds `[nhentai-00000]` name |
| `library:isPathAccessible` | :194 | :1728 | `(dirPath)` → bool | — | `existsSync` |
| `library:convertAllMetadata` | :196 | :2010 | `(runners?=3)` → `{converted, failed, total, cancelled, errors?(≤20)}` | DB, file, proc | **Returns only when done**; in-memory queue — *not* crash-resumable; writes `convert-<ts>.log`; pool clamped 1–20 |
| `library:cancelConversion` | :197 | :2226 | `()` → none | proc | Sets module flag `conversionCancelled` |
| `library:convertToCbz` | :202 | :2929 | `(ids, dryRun?, {keepOriginal?, resume?}?)` → dry-run `{dryRun:true, items, count}`; run `{converted, failed, total, skipped, keptOriginals, forcedKeeps, cancelled, errors?}` | DB, file, os, proc | DB-backed `conversion_queue`, **resumable** via `resume:true`; pool `min(downloadConcurrency,8)`; `keep_original` stored per row |
| `library:getConversionQueue` | :204 | :3389 | `()` → counts + `{outstanding, errors}` | — | Resume banner |
| `library:clearConversionQueue` | :205 | :3405 | `()` → `{cleared}` | DB, proc | Raw `DELETE FROM conversion_queue`; clears lock sets |
| `library:getDefaultPaths` | :207 | :3551 | `()` → `{thumbnailPath, originalsPath}` | — | Defaults only main can know (userData) |
| `library:getOriginalsInfo` | :208 | :3561 | `()` → `{count, bytes, lossyCount, lossyBytes}` | proc | 60 s cached async walk (`:3439-3482`); single-flight |
| `library:previewSource` | :211 | :3784 | `(sourcePath, 'pdf'\|'images')` → base64 JPEG | — | 360×480 q78 preview for the add-entry form; PDF via `pdftoppm` |
| `library:restoreOriginals` | :213 | :3595 | `()` → `{restored, skipped, failed, bytes}` | DB, file, os | Ordered restore: never overwrite → move PDF → confirm → delete CBZ → update row |
| `library:purgeOriginals` | :215 | :3692 | `(includeLossy?=false)` → `{deleted, bytes, failed, removedDirs}` | file, os | Prunes empty dirs; lossy kept unless asked for |
| `library:cancelConvertToCbz` | :216 | :3381 | `()` → none | proc | Flag `cbzConversionCancelled` |
| `library:getCbzConversionState` | :217 | :3769 | `()` → `{running, activeIds, queuedIds}` | — | Lets the UI re-mark busy rows after a restart |
| `library:syncItem` | :218 | :2460 | `(itemId)` → `{synced:true}`\|error | DB, file, proc | Single-item sync; refuses `'Already syncing'` / `'No nhentai ID'` |
| `library:syncBatch` | :219 | :2528 | `(ids)` → `{succeeded, failed, total: ids.length}` | DB, file, proc | **Also bound as `resumeSync`** (preload :226, `invoke('library:syncBatch', [])`) — see §5.4 |
| `library:isSyncing` | :220 | :2698 | `(itemId)` → bool | — | Module set `syncingItems` |
| `library:getSyncQueue` | :222 | :2505 | `()` → counts + `{outstanding, errors}` | — | Crash-recovery banner |
| `library:clearSyncQueue` | :224 | :2518 | `()` → `{cleared}` | DB | Discards pending work too |
| `library:cancelSync` | :228 | :2522 | `()` → none | proc | Stops **after** the in-flight item — a sync rewrites the archive in place |
| `library:previewSeriesGrouping` | :230 | :651 | `()` → `{groups, galleries}` | — | Computed, not estimated — backs the confirm dialog |
| `library:setSeriesGrouping` | :233 | :666 | `(enabled)` → `{groups, galleries}` | DB, proc | On = `backfillAll()` link; **off = setting only**, links kept |
| `library:renameSeries` | :236 | :697 | `(seriesId, name)` → `{renamed, errors?}` | DB, file, os, proc | DB + re-embed + folder move per member; name-clash checked first; Kavita block disabled in source |
| `library:setSeriesDissolved` | :239 | :809 | `(seriesId, dissolved)` → `{affected}` | DB | Touches no files |
| `library:setSeriesCover` | :242 | :816 | `(seriesId, itemId\|null)` → none | DB | |

Every mutating library channel guards on `isConversionLocked(id)`
(`cbzConverting`/`cbzQueued`, `library.ipc.ts:183-198`) and returns the same
refusal: *"This file is being converted to CBZ."*

### 2.7 `file:*` (1) — ⚑ (`library.ipc.ts`)

| Channel | preload | handler | Payload → return | Mutates | Semantics |
|---|---|---|---|---|---|
| `file:read` | :246 | library.ipc.ts:2710 | `(filePath)` → base64 | — | Whole-file `readFileSync` for the PDF viewer — **arbitrary path, unguarded** (see §6) |

### 2.8 `cbz:*` (2) — reader (`library.ipc.ts`)

| Channel | preload | handler | Payload → return | Mutates | Semantics |
|---|---|---|---|---|---|
| `cbz:getPageCount` | :250 | library.ipc.ts:2877 | `(filePath)` → number | — | Counts image entries (excl. dirs and `ComicInfo.xml`) |
| `cbz:readPage` | :251 | :2720 | `(filePath, pageIndex)` → base64\|error `'Page not found'` | — | Entries sorted by name; two-pass yauzl open |

### 2.9 `log:*` (8) (`index.ts`)

| Channel | preload | handler | Payload → return | Mutates | Semantics |
|---|---|---|---|---|---|
| `log:write` | :437 | index.ts:245 | `(level, scope, msg, fields?)` → *undefined* | proc | Raw handle; invalid level dropped silently; routes through scoped logger |
| `log:getRecords` | :438 | :265 | `()` → ring-buffer records | — | |
| `log:setLevel` | :439 | :269 | `(level)` → none\|`{success:false,error}` | proc | Raw handle; `error\|warn\|info\|debug` |
| `log:getLevel` | :440 | :276 | `()` → level string | — | |
| `log:setRetention` | :441 | :280 | `(days)` → none | proc | Clamped 1–365 |
| `log:getRetention` | :442 | :289 | `()` → days | — | |
| `log:openFolder` | :443 | :293 | `()` → *undefined* | os | ⚑ `shell.openPath(logDir)` |
| `log:exportDiagnostics` | :444 | :297 | `()` → `{path}` | os, proc | ⚑ Writes scrubbed `diagnostics-<ts>.json`, reveals via `shell.showItemInFolder`; scrubs nhentai + Kavita keys |

### 2.10 `app:*` (6) — version + ⚑ updater

| Channel | preload | handler | Payload → return | Mutates | Semantics |
|---|---|---|---|---|---|
| `app:checkForUpdates` | :449 | updater.ipc.ts:126 | `()` → `{version}\|null` | proc | ⚑ electron-updater check; `autoDownload=false` |
| `app:downloadUpdate` | :451 | :142 | `()` → none | proc | ⚑ Explicit user action only |
| `app:installUpdate` | :453 | :135 | `()` → none | proc, os | ⚑ `quitAndInstall(false, true)`; no-op until staged |
| `app:getUpdateStatus` | :455 | :148 | `()` → status\|null | — | Cached last event; null before the first one (late mounters) |
| `app:getVersion` | :456 | index.ts:399 | `()` → version string | — | ⚑ `app.getVersion()` |
| `app:checkToolchain` | :458 | index.ts:237 | `(force?)` → toolchain report | proc | Probes Python/pikepdf + poppler; D3 says 2.x ships zero external tools |

### 2.11 `settings:*` (5) (`settings.ipc.ts`)

| Channel | preload | handler | Payload → return | Mutates | Semantics |
|---|---|---|---|---|---|
| `settings:get` | :463 | settings.ipc.ts:51 | `(key)` → string\|null | — | `kavitaApiKey` transparently decrypted (`:34-48`) |
| `settings:getAll` | :464 | :56 | `()` → `Record<string,string>` | — | Encrypted keys decrypted |
| `settings:set` | :465 | :64 | `(key, value)` → none | DB, proc | Re-applies live settings (`downloadConcurrency` → manager, `releaseChannel` → updater) |
| `settings:setAll` | :466 | :70 | `(Record<string,string>)` → none | DB, proc | Same live-apply per key |
| `settings:delete` | :467 | :80 | `(key)` → none | DB | |

### 2.12 `kavita:*` (4) (`kavita.ipc.ts`) — all take optional `(url, apiKey)` overrides

| Channel | preload | handler | Payload → return | Mutates | Semantics |
|---|---|---|---|---|---|
| `kavita:testConnection` | :474 | kavita.ipc.ts:17 | `(url?, apiKey?)` → `{serverVersion, username}`\|`{success:false,error}` | — | Unsaved form values work; soft failure |
| `kavita:getLibraries` | :476 | :28 | `(url?, apiKey?)` → libraries | — | Throws inside → envelope error |
| `kavita:getItemCount` | :478 | :35 | `(url?, apiKey?)` → number\|null | — | **Never throws**; null = status bar hides the figure |
| `kavita:getSeriesDetail` | :485 | :49 | `(seriesName, title, url?, apiKey?, filePath?)` → detail\|null | — | Name search + best match; null renders nothing |

Scan/delete are deliberately *not* exposed: the file-operation handlers fire
them server-side (`kavita.ipc.ts:4-10`).

### 2.13 `searchSettings:*` (3) + `search:*` (1) (`search-settings.ipc.ts`)

| Channel | preload | handler | Payload → return | Mutates | Semantics |
|---|---|---|---|---|---|
| `searchSettings:get` | :490 | search-settings.ipc.ts:120 | `()` → `SearchSettings` (iface `:89-92`) | — | Stored as plain `app_settings` strings (`SEARCH_SETTING_KEYS` :68-85) |
| `searchSettings:set` | :491 | :124 | `(patch)` → fresh `SearchSettings` | DB | Validates sort against the 5 API-accepted values |
| `searchSettings:buildQuery` | :496 | :199 | `(userQuery)` → `{query, sort}` | — | nhentai query syntax composed **in main** from defaults + blocked list |
| `search:evaluateResults` | :505 | :235 | `(galleries)` → `Record<id, {matches, blacklisted, excluded}>` | proc | Exposed under the `searchSettings` object. Re-applies `exclude` client-side because browse endpoints accept no query (:249-260) |

### 2.14 `blocked:*` (4) (`search-settings.ipc.ts`)

| Channel | preload | handler | Payload → return | Mutates | Semantics |
|---|---|---|---|---|---|
| `blocked:list` | :509 | search-settings.ipc.ts:161 | `()` → rows | — | |
| `blocked:add` | :511 | :171 | `(entries[{type,value,mode}])` → `{added, items}` | DB | Bulk; skips duplicates |
| `blocked:setMode` | :512 | :180 | `(id, mode)` → rows | DB | Returns the fresh list |
| `blocked:remove` | :513 | :185 | `(id)` → rows | DB | Returns the fresh list |

### 2.15 `tags:*` (3) (`search-settings.ipc.ts`)

| Channel | preload | handler | Payload → return | Mutates | Semantics |
|---|---|---|---|---|---|
| `tags:resolveForGalleries` | :519 | search-settings.ipc.ts:211 | `(galleries)` → `Record<galleryId, {type,name}[]>` | proc, DB | Map→plain object at `:217-220`; batched against `tag_cache` + rate-limited endpoint |
| `tags:autocomplete` | :521 | :298 | `(query, type?)` → `{id,type,name,count}[]` | proc | LRU cache 200 entries / 5 min (`:24-59`); nhentai tag search, limit 15 |
| `tags:cacheStats` | :522 | :314 | `()` → `{cached}` | — | `tag_cache` row count |

---

## 3. Main→renderer events (14)

All subscribed in `src/preload/index.ts`; every subscription returns an
unsubscribe closure (§1.3).

| Channel | Preload sub | Payload shape | Emitted at | Consumer component(s) |
|---|---|---|---|---|
| `download:progress` | :256-275 | `{queueId, galleryId, title, status, totalPages, completedPages, percentage, speedKBps, etaSeconds, errorMessage?}` | download.ipc.ts:12-17 (all windows) | DownloadsPage.tsx:137, LibraryPage.tsx:585, SearchPage.tsx:439 |
| `library:scanProgress` | :276-285 | `{current, total, status}` | library.ipc.ts:1034 | LibraryPage.tsx:496, onboarding/StepSummary.tsx:45 |
| `library:scanComplete` | :286-307 | `{total, newItems, removedItems, errors[], removalSkippedReason?}` | library.ipc.ts:1054 | LibraryPage.tsx:500, StepSummary.tsx:49 |
| `library:scanError` | :308-312 | `string` | library.ipc.ts:1064, :1072 | LibraryPage.tsx:514, StepSummary.tsx:54 |
| `library:newItem` | :313-320 | `{id, title, artist}` | library.ipc.ts:1041 | **None** — subscribed in preload, used nowhere in the renderer (§4) |
| `library:newItems` | :321-330 | `{id,title,artist}[]` — batched 25/500 ms in the scanner worker | library.ipc.ts:1030 | LibraryPage.tsx:521 |
| `library:syncProgress` | :331-345 | `{current, total, title, etaSeconds: number\|null}` | library.ipc.ts:2583, :2639 | stores/sync-progress.store.ts:80 |
| `library:syncComplete` | :346-361 | `{succeeded, failed, total, cancelled?}` | library.ipc.ts:2663 | stores/sync-progress.store.ts:97 |
| `library:convertProgress` | :362-376 | `{current, total, converted, failed, logLines[]}` (logLines drained per send) | library.ipc.ts:2058 | settings/SettingsPage.tsx:652 |
| `app:updateStatus` | :385-400 | `{state: 'available'\|'current'\|'downloading'\|'ready'\|'error', version?, percent?, message?, releaseNotes?}` (updater also sends `'checking'`) | updater.ipc.ts:77 (all windows) | Sidebar.tsx:78, SettingsPage.tsx:105, settings/UpdateStatus.tsx:109 |
| `library:addCustomProgress` | :407-416 | `{phase, current, total}` (`total` 0 for non-per-page steps) | library.ipc.ts:1298 | library/CustomEntryForm.tsx:74 |
| `library:convertToCbzProgress` | :417-422 | `CbzConvertProgress` (preload :13-24): `{current, total, converted, failed, skipped?, running?, activeIds?, queuedIds?, logLines?}` | library.ipc.ts:3060 | stores/cbz-conversion.store.ts:145 |
| `library:scanPaused` | :423-427 | none | library.ipc.ts:1057 | LibraryPage.tsx:561 |
| `library:scanCancelled` | :428-432 | none | library.ipc.ts:1061 | LibraryPage.tsx:562 |

---

## 4. Contract gaps

1. **`library:itemDeleted` — emitted 3×, no subscriber.** Sent to all windows
   at `library.ipc.ts:1613`, `:1668`, `:1702` (delete / deleteMultiple /
   deleteFileMultiple) with `{id, galleryId}`. There is no `ipcRenderer.on`
   for it anywhere in the preload — the renderer cannot receive it, and
   nothing can. Port decision: either wire it (it is the natural
   search-result invalidation signal the comment at `:1610` intends) or drop
   it; do not reproduce dead surface faithfully.
2. **`auth:getRateLimits` — registered, unexposed.** `auth.ipc.ts:132`
   returns `{authenticated, buckets}` from the rate limiter snapshot; no
   preload binding. Dead diagnostics channel. Candidate for a real
   diagnostics binding rather than deletion.
3. **`library:syncBatch` bound twice.** Preload `:219` (`syncBatch(ids)`) and
   `:226` (`resumeSync()` → `invoke('library:syncBatch', [])`). Same
   registration at `library.ipc.ts:2528`. A Rust core can keep one operation
   with `ids: Option<Vec<i64>>`; the preload method names are renderer
   furniture, not wire surface.
4. **`library:newItem` subscribed, unconsumed.** Preload exposes
   `onLibraryNewItem` (:313) and main emits it (:1041), but no renderer file
   uses it — `onLibraryNewItems` (batched) superseded it. Harmless today;
   worth knowing when diffing Phase B traffic.
5. All other preload channels have a matching main registration (verified by
   set-diff; main's 131 registrations = 130 exposed + `auth:getRateLimits`).

---

## 5. Semantics worth preserving

1. **`library:getThumbnail` is a polling protocol, not a push one.** It
   returns a base64 `data:image/jpeg;base64,…` URL (`library.ipc.ts:1723-1725`)
   or `null` until the cover file actually exists on disk, so the renderer
   polls it per card every 2 s (`LibraryCard.tsx:68-84`; first poll on mount).
   Consumers: LibraryCard, SeriesCard (`:66`), SeriesDetail (`:129`),
   LibraryDetail (`:207`). Each call is one SQLite row + one file read — the
   cost model that makes 2 s polling acceptable. A Rust core with a custom
   image protocol can do better, but Phase B must keep the null-then-appear
   behaviour or pending-download placeholders never get covers.
2. **`download:addToQueue` inserts + kicks.** Dedupes on
   `findActiveByGalleryId` (returns `{id, duplicate:true}` instead of a second
   row — two rows would race on the same scratch dir and output path,
   `download.ipc.ts:47-53`), resolves format arg → setting → `'pdf'`, inserts
   a `queued` row, then calls `manager.processQueue()` (:70).
3. **`library:convertAllMetadata` returns nothing until done.** The invoke
   resolves only after the whole batch (`library.ipc.ts:2195-2220`); progress
   arrives via `library:convertProgress`. Its work list is an **in-memory
   array** advanced by `queueIndex++` (:2094-2100) — the one long job with no
   crash resumability. Cancellation is a module flag checked per item;
   it writes its own `userData/logs/convert-<ts>.log`.
4. **`syncBatch` doubles as `resumeSync`.** `ids.length > 0` → fresh batch
   (`clearFinished()` then enqueue); empty array → resume whatever is pending
   (`library.ipc.ts:2540-2556`). Claimed one row at a time so a crash strands
   exactly one; paced at 90 % of `endpointLimitPerMinute('gallery', hasKey)`
   with the sleep counting the item's own work (:2564-2658); cancel stops
   after the in-flight item (the worker must never be terminated mid-rewrite);
   a native Notification reports the outcome (:2671-2685).
5. **`kavita:*` take optional `(url, apiKey)` overrides** so the settings pane
   can test *unsaved* form values; falling back to the persisted settings when
   omitted (`kavita.ipc.ts:12-16`). `getItemCount` never throws — null means
   "hide the figure" (:36-38).
6. **`api:setApiKey` swaps the rate-limiter tier.** One call changes every
   endpoint's limit for the process (`api.ipc.ts:108-111`);
   `auth:validateKey` persists only after a successful `GET /user` and rolls
   the tier back on failure (`auth.ipc.ts:83-98`); `restoreAuthFromDb`
   (`:53-74`) re-validates at startup and self-heals a bad stored key.
7. **`library:getPaginatedGrouped` reads the setting in main.** The grid
   cannot be grouped while a batch action a moment later is not — grouping is
   decided at the boundary, and flat mode returns the identical row shape with
   every row `kind:'item'` (`library.ipc.ts:495-543`).
8. **The conversion lock.** `cbzConverting`/`cbzQueued` module sets
   (`:183-198`) refuse delete/assign/updateMetadata/renameSeries/sync with one
   uniform message, because a conversion replaces the file and rewrites
   `file_path` — a concurrent edit would leave the DB pointing at a deleted
   PDF. A Rust core needs the same guard set, backed by
   `library:getCbzConversionState` for UI rehydration.
9. **Delete variants and Kavita.** `delete` keeps the file;
   `deleteFile` unlinks first; both and their batch variants fire-and-forget
   `deleteItemsFromKavita` — optionally, via `alsoFromKavita`, for the
   row-only variant (the file would otherwise be re-added by the next Kavita
   scan, `:1618-1627`).
10. **`updateMetadata`'s gallery merge.** The re-embed is built by
    `metaForItem` (`:327-358`) folding the cached `gallery` row in — parodies,
    categories, characters — because a ComicInfo rewrite rebuilds the file
    from scratch and a hand-built payload "loses" means "deletes from the
    file" (:1849-1853).
11. **`search:evaluateResults` re-applies `exclude`.** `/galleries` and
    `/galleries/popular` accept no query, so browse-view exclusions can only
    be applied to the results after the fact (`:249-263`); the renderer must
    keep calling it even though the search query already negates exclusions.
12. **`restoreOriginals` ordering is the safety property** (`:3572-3604`):
    refuse overwrite → move PDF back → confirm arrival → delete CBZ → update
    row. An interruption at any point leaves a readable copy on disk.

---

## 6. Port decisions required — Electron-specific channels

One-line recommendation here; the decision itself is deferred to
`06-technology-decision.md` and the `08-subsystem-plans/`.

| Channels | Why Electron-specific | Rust-core replacement (recommendation) |
|---|---|---|
| `shell:openExternal` / `openPath` / `showItemInFolder` | `shell` module | `opener` crate (or `xdg-open`/`explorer` equivalents); keep the three-way distinction — reveal-in-folder is a different OS call |
| `dialog:openFile` / `dialog:openDirectory` | `dialog.showOpenDialog` needs a `BrowserWindow` parent | `rfd` (or toolkit-native dialogs); preserve `defaultPath` and `null`-on-cancel |
| `app:checkForUpdates` / `downloadUpdate` / `installUpdate` / `getUpdateStatus` + `app:updateStatus` event | electron-updater + GitHub feed | Toolkit updater (e.g. Tauri updater) or hand-rolled feed check; must keep `autoDownload=false` semantics and the cached-status-`null`-before-first-event behaviour |
| `app:getVersion` | `app.getVersion()` | Compile-time env/`Cargo` version; trivial |
| `file:read` | Unscoped `readFileSync` of any renderer-supplied path, whole file into base64 | Restrict to library-rooted paths and stream via a custom URI protocol; whole-file base64 over IPC is a memory hazard for large archives. **Do not reproduce the unscoped path handling** |
| `cbz:readPage` / `library:getThumbnail` / `previewSource` base64 returns | Structured-clone strings | Same custom protocol can serve images/ranges; keep null-until-exists for thumbnails |
| `auth:validateKey` / `setKey` / `clearKey` (safeStorage) + `settings:*` encryption of `kavitaApiKey` | Electron `safeStorage` → OS keychain, base64 blob in `app_settings`, plaintext passthrough when unavailable (`auth.ipc.ts:14-34`, `settings.ipc.ts:34-48`) | `keyring` crate; must keep the decrypt-if-encrypted fallback so pre-encryption values keep working |
| `log:openFolder` / `log:exportDiagnostics` (reveal step) | `shell.openPath` / `showItemInFolder` | `opener`; diagnostics itself is pure Rust (scrub both stored and decrypted key forms, `index.ts:325-354`) |
| `download:*`, `library:*` file operations (rename/unlink/mkdir) | Node `fs` in main | `std::fs`/`tokio`; semantics (relative paths at rest, `.part` siblings, cross-device copy fallback) tracked in `03-data-model.md` |
| Native `Notification` after a sync batch (`library.ipc.ts:2671-2685`) | Electron `Notification` | Toolkit/OS notification crate; keep the cancelled-run wording |

Non-negotiable regardless of toolkit: the envelope and its `errorId` (§1.1),
event unsubscribe semantics (§1.3), and the slow-handler/freeze attribution
pair (§1.2) — renderer code and log analysis both depend on them.
