# Subsystem plan 08 — GUI app shell (`src-tauri/`, Phase B/C)

Execution plan for the application shell that replaces Electron main while
keeping — then replacing — the React renderer. **This plan is Phase B/C**
([09-migration-phases.md](../09-migration-phases.md)): it starts only when the
`kopibon-core` subsystems of plans 01–07 are green. It is written against the
**conditional primary, Tauri v2** ([06-technology-decision.md](../06-technology-decision.md)
§7–§8: selected iff spike S2 passes M1/M2/M6), with the **egui fallback**
sketched in §8 so a trigger amends one section instead of restarting
planning. The renderer surface is frozen by
[04-parity-ledger.md](../04-parity-ledger.md) and the wire surface by
[02-ipc-surface.md](../02-ipc-surface.md) — both are cited, not restated.

---

## 1. What this plan is and is not

- **Phase B keeps the existing React renderer** (~87 files / ~18,000 lines of
  TS/TSX under `src/renderer/`, 06-technology-decision §4) and swaps the host:
  Electron main + preload + `ipcMain` out, the Rust core + Tauri command/event
  layer in. End-to-end testable with real data, UI unchanged.
- **Phase C replaces the renderer screen-by-screen** only if the Tauri reuse
  path is abandoned (§8) — under the primary it *degenerates to re-verifying
  the ledger* (06-technology-decision §5.1: the bridge rewrite is Phase C's
  whole UI cost).
- Non-negotiables inherited from [02-ipc-surface.md](../02-ipc-surface.md) §6:
  the response envelope and its `errorId`, event unsubscribe semantics, and
  the slow-handler/freeze attribution pair.

## 2. Phase B — the channel bridge (all 144)

144 unique channel strings = **130 request/response** (131 invoke sites —
`library:syncBatch` bound twice, `src/preload/index.ts:219, :226`) + **14
main→renderer events**, across 16 namespaces (02-ipc-surface, header). The
port maps them mechanically; nothing is redesigned.

### 2.1 Renderer-side shim

1.x exposes `window.api` via `contextBridge` in the preload
(`src/preload/index.ts`). The port ships a **renderer module `bridge.ts` that
builds the identical `window.api` object from Tauri's `invoke`/`listen`**
(injected as a Tauri initialization script so it exists before app code, or
imported at the top of `main.tsx`). Every renderer call site stays untouched;
the preload file is deleted. The shim preserves:

- the **envelope** `{success, data?, error?, errorId?}` — built Rust-side
  (§2.2), passed through by the shim;
- **unsubscribe closures**: `listen()` already returns one — map
  `onX(handler) → Promise<() => void>` exactly like the preload's
  `removeListener` returns (02-ipc-surface §1.3);
- per-channel method names, including `api.getApiConfig` ≠ `api:getConfig`
  and the syncBatch/resumeSync double binding.

### 2.2 Rust-side command layer

```
src-tauri/src/
├── commands/        // one module per namespace: api, auth, shell, dialog, download,
│                    // library, file, cbz, log, app, settings, kavita,
│                    // search_settings, blocked, tags   (02-ipc-surface §2.1–2.15)
├── envelope.rs      // the handle() port: errorId, slow-handler warning
├── events.rs        // emit helpers; all-windows vs originating-window table
└── main.rs          // setup: data dir, logging, core wiring, single instance
```

- **`envelope.rs` is the port of `handle.ts:53-81`**: every command returns
  the envelope; a caught error logs with a fresh Crockford-base32 `errorId`
  (8 random bytes, `logger.ts:100`) and returns
  `{success:false, error, errorId}`; success passes the handler's value
  through — **each command builds its own `{success:true, data}`**, and the
  soft-fail commands that return `{success:false, error}` *without* an
  `errorId` (e.g. `kavita:testConnection`, `library:getSeriesFacts`) must be
  distinguished from thrown ones. The four raw `log:*` channels keep their
  hand-rolled behaviour (02-ipc-surface §1.1). Port the ≥250 ms slow-handler
  warning and the in-flight registry (`handle.ts:31-70`) — under Tauri the
  "freeze attribution" question becomes "which command was executing when the
  webview hung"; keep the same log shape.
- **Commands are thin**: each registers against the same `kopibon-core`
  services Phase A built. No business logic migrates in Phase B.
- **Events** (`02-ipc-surface` §3): the 14 channels become `emit`s from the
  core's event sinks. Port the per-event audience table — most were
  originating-window only (`library:scanProgress`, `library:syncProgress`, …),
  while `download:progress`, `library:itemDeleted`, `app:updateStatus` were
  all-windows; §6's rule stands: all-windows is the safer default, but the
  emitting modules must be explicitly listed either way.

### 2.3 The Electron-specific channel groups (02-ipc-surface §6)

| Group | Channels | Tauri v2 replacement |
|---|---|---|
| **shell** | `shell:openExternal` / `openPath` / `showItemInFolder` (`auth.ipc.ts:142-152`) | `tauri-plugin-opener` (or the `opener` crate / `xdg-open`); keep the three-way distinction — reveal-in-folder is a different OS call from open |
| **dialog** | `dialog:openFile` / `openDirectory` (`auth.ipc.ts:156-179`) | `tauri-plugin-dialog`; preserve `defaultPath`, the PDF default filter, and `null`-on-cancel |
| **updater** | `app:checkForUpdates` / `downloadUpdate` / `installUpdate` / `getUpdateStatus` + `app:updateStatus` event (`updater.ipc.ts`) | `tauri-plugin-updater` against the same GitHub-release feed; must keep `autoDownload=false` semantics (explicit user action before download, 02-ipc-surface §2.10) and the cached-status-`null`-before-first-event behaviour; `app:getVersion` → compile-time `env!("CARGO_PKG_VERSION")`; `app:checkToolchain` reports zero external tools (D3) rather than probing Python/poppler |
| **file read** | `file:read` (`library.ipc.ts:2710`), plus the base64 returns of `cbz:readPage` (`:2720`), `library:getThumbnail` (`:1723`), `library:previewSource` (`:3784`) | **Do not reproduce the unscoped path handling** (02-ipc-surface §6): restrict to library-rooted paths and serve images/archives through a Tauri **custom protocol / asset handler** (the S2 M5 measurement decides protocol-vs-base64); keep the null-until-exists thumbnail behaviour or pending placeholders never get covers (§2.6) |

Also Electron-specific: `safeStorage` (→ `keyring` + the AES passthrough of
plan 07 §5.1; S5 says the nhentai key is re-entered on import), native
`Notification` after sync batches (`library.ipc.ts:2671-2685` → notification
plugin/`notify-rust`, keep the cancelled wording), and the `KOPIBON_DATA_DIR`
dance (`src/main/index.ts:101`) — under one process the core's
`resolve_db_dir` (plan 05 §3) takes the Tauri app-data path directly.

### 2.4 Bootstrap parity

`main.rs` reproduces the 1.x boot order: data dir → `initDatabase()` +
migrations + `seedDefaults` → startup maintenance sweep → download
`reconcileInterrupted` before the pump → `restoreAuthFromDb` re-validation →
update check (`src/main/index.ts:101, :189`). Single-instance enforcement and
the deep-link-free window config (size, min-size, dark titlebar) match
1.x's `BrowserWindow` options.

### 2.5 Data-freshness: polls → push (D-poll-to-push, ledger-accepted)

The renderer's nine 2 s polls (`Sidebar.tsx:70`, `StatusBar.tsx:76`,
`LibraryCard.tsx:83`, `GalleryDetail.tsx:127`, `DownloadsPage.tsx:146`,
`SearchPage.tsx:249`, `FavoritesPage.tsx:84`, `LogsPage.tsx:128`, plus the 1 s
rate-limit tick `SearchPage.tsx:231`) are the idle-CPU baseline
[05-baselines.md](../05-baselines.md) §2 measures. Phase B replaces them with
the existing event channels where an event exists (`download:progress`,
`library:newItems`, `library:scanProgress/Complete`, `library:syncProgress/
Complete`, `library:convertToCbzProgress`) and keeps polling only where no
event exists. Rules from [04-parity-ledger.md](../04-parity-ledger.md) §6:

- The **user-visible freshness contract (≈2 s worst-case staleness) is P0**;
  the mechanism is P2 (D-poll-to-push, *accepted*).
- **D-thumbnail-poll-fix** (*accepted*): one thumbnail fetch per item per
  session; covers appear within ~2 s via `library:newItems` push. M4's
  0-steady-state-IPC target (06-technology-decision §6.2) is hit by exactly
  this pair.

### 2.6 Window and renderer state

- **12 store modules** under `src/renderer/src/stores/` (11 zustand
  `create()` stores + the shared `ProgressJob` shape in `job-progress.ts`)
  survive untouched under Tauri — they are plain React code.
- **localStorage keys**: `doujin-ui-store` (theme, sidebarCollapsed —
  `ui.store.ts:30`) and `doujin-search-history` (recent max 30 + favorites,
  `search-history.store.ts:82`) must stay key-compatible or be migrated
  (**D-localstorage-keys**, ledger status *open* — needed for side-by-side
  preference import, D4). `onboardingCompleted` flows through SQLite settings
  (`settings.store.ts:190, :219`), not localStorage.
- The dead `sidebarCollapsed` persisted state has no UI control
  (04-parity-ledger §8; **D-sidebar-collapsed**, proposed).

## 3. Phase B dev loop

- **`tauri dev` with `beforeDevCommand: vite` and `devUrl` pointing at the
  Vite server** — the renderer keeps HMR exactly as in `npm run dev` today;
  `build.frontendDist` replaces `dist/` for production bundles.
- **HashRouter compatibility**: `react-router`'s `HashRouter`
  (`src/renderer/src/App.tsx:91`) works unchanged under the `tauri://` (and
  `http://tauri.localhost`) origin — no history-API fallback is needed, which
  is one reason the 1.x router choice pays off. The unknown-hash
  empty-outlet behaviour (04-parity-ledger §2) is preserved as-is.
- Phase B can also run the renderer in a plain browser against a thin
  WebSocket shim for fast iteration, but the contract tests (§6) run against
  the real Tauri commands.
- CSP: set a Tauri CSP that allows the app's own assets and nothing else —
  1.x had `contextIsolation` and no remote content; keep it that way.

## 4. Phase C — screen-by-screen ledger execution

Under the Tauri primary, Phase C is **not a screen rebuild**: the screens are
the same React components; the work is re-verifying every
[04-parity-ledger.md](../04-parity-ledger.md) row against the re-hosted
renderer and landing the remaining accepted deviations:

1. Walk the ledger §2–§5 per route (`/library`, `/search`, `/favorites`,
   `/downloads`, `/settings`, shell) — each row P0/P1 checked against the
   running 2.x build; a behaviour not in the ledger is treated as P0 until
   the ledger is amended (ledger §9 rule).
2. Land the remaining **P2 deviations only via the ledger table**:
   D-onboarding-reopen, D-input-guard, D-error-boundary are *proposed* — none
   may ship without an accepted row (04-parity-ledger §9).
3. **Onboarding-as-router-replacement is preserved**: `OnboardingWizard`
   renders *instead of* the router until `onboardingCompleted`
   (`App.tsx:88-94`) — unreachable by URL, not reopenable; any "run setup
   again" action is the D-onboarding-reopen deviation, not a silent addition.
4. Keyboard bindings (ledger §4) are transcribed verbatim per component;
   the two unguarded document-level viewers stay unguarded unless
   D-input-guard is accepted.
5. If Phase C *is* a rebuild (fallback §8): screen-by-screen order =
   ledger §2 shell → §3 vocabulary → routes one at a time, each screen
   exiting only when every row it owns is at its stated level.

## 5. Packaging note (boundary with the release plan)

Bundler targets, the updater plumbing, icons, and the D3 size win belong to
the packaging/release plan; this plan only fixes the interface: Tauri v2
bundler targets mirroring 1.x (AppImage, .deb, .rpm, NSIS), `beforeBuildCommand`
= the same Vite build, and the ≤ 80 MB unpacked budget from
[05-baselines.md](../05-baselines.md) §1 as the acceptance number.

## 6. Tests

| Test | Asserts |
|---|---|
| **Command-surface contract tests** | generated from 02-ipc-surface §2: for each of the 130 request/response channels, invoke through the shim and assert the envelope shape (success paths, thrown-error paths *with* errorId, soft-fail paths *without*, the `download:pause/resume/cancel` bare-`{success:bool}` variant, the four raw `log:*` channels) — a channel without a command fails the suite |
| **Event-surface contract tests** | the 14 events fire with payload shapes equal to 02-ipc-surface §3 on scripted runs; every subscription's unlisten actually stops delivery |
| errorId discipline | thrown command → fresh Crockford base32 errorId, log line carries it; same error twice → different ids |
| Slow-handler warning | a stubbed ≥250 ms command logs the warning; in-flight registry reports it while running |
| Freshness/push | with the library grid open and nothing happening, steady-state IPC = 0 (M4); covers appear ≤ 2 s after `library:newItems`; job progress streams during downloads/scan/sync/converts |
| Boot parity | fresh data dir → wizard; completed dir → routes; DB migrations + maintenance run before the window shows data |
| Poll replacement | each of the nine 2 s polls is either gone (event exists) or explicitly retained with a reason in the test comment |
| **UI smoke (optional)** | Playwright-style smoke over the webview (tauri-driver/WebDriver or CDP where available): library grid renders 5261-item copy scroll-through, settings save/reload, search → detail → viewer happy paths — gated on the packaging plan producing a runnable bundle |

## 7. Exit criteria

1. **Phase B exit:** the existing renderer runs unmodified against the Rust
   core; the 144-channel contract suite is green; a full real-data session
   (search, download, scan, convert, sync, settings) behaves as on 1.x with
   events as the only freshness mechanism; slow-handler/errorId logging
   parity verified.
2. **Phase C exit:** every [04-parity-ledger.md](../04-parity-ledger.md) row
   at its stated level for the shipped UI; deviation table contains no
   unreviewed rows; D-poll-to-push and D-thumbnail-poll-fix verified by the
   0-steady-state-IPC measurement.
3. Baseline targets re-measured on the 2.x build: idle RSS ≤ 150 MB, cold
   start ≤ 1.0 s, 10k grid per S2 bars (06-technology-decision §6.2).
4. localStorage/settings import from a 1.x profile verified (D4) or
   D-localstorage-keys resolved the other way with a ledger row.

## 8. egui fallback sketch (only if Tauri fails S2)

If the fallback ladder fires (06-technology-decision §7), §2's Rust layer
survives intact — commands/events/envelope are toolkit-independent; what
changes:

- §2.1/§3 vanish: no webview, no shim, no Vite. The command layer is called
  in-process from egui windows; the contract tests re-target direct calls
  with the same envelope assertions.
- Phase C becomes the **full ledger rebuild** in immediate-mode code at
  criterion-1 cost (06-technology-decision §5.2): the component vocabulary
  (ledger §3), verbatim keybindings (§4), settings defaults (§5) and the
  virtualised grid (hand-built over `ScrollArea::show_rows`) are re-derived;
  M6 (Japanese) is the mandatory sub-gate *before* any screen work starts
  (fallback ladder: egui → GTK4/relm4).
- The 2 s-poll question dissolves (no IPC boundary), but the freshness
  contract and D-thumbnail-poll-fix survive as direct-subscription rules.
- Window/state: zustand stores are replaced by egui models keyed 1:1 by store
  name; `doujin-*` localStorage keys become a small JSON file in the data dir
  with the same shapes, so D-localstorage-keys is decided identically.

## 9. Risks

| Risk | Mitigation |
|---|---|
| S2 fails the webview bars | §8 fallback sketch; the Rust command layer is deliberately toolkit-independent so only §2.1/§3 are discarded |
| 144-channel drift while Phase A evolves the core | contract tests are generated from 02-ipc-surface §2 and run in CI against `kopibon-core`; a core change that breaks a payload shape fails before the renderer does |
| Envelope subtleties (soft-fail vs thrown, bare-`success` channels, `undefined` returns) | each variant has its own contract test (§6); no generic wrapper that erases the distinction |
| Thumbnail transport perf (base64 over invoke) | decided by S2 M5; custom protocol is the default plan and `file:read` is *not* ported unscoped either way |
| WebKitGTK fragmentation on user distros | support-matrix item for the packaging plan; version floor documented and tested |
| Onboarding lockout bugs during Phase C | wizard render-order is a contract test (fresh dir → wizard, no route access) |
| Scope creep into "UI improvements" during the bridge rewrite | Phase B changes zero renderer files beyond the shim import; anything user-visible goes through the ledger §9 deviation process |
