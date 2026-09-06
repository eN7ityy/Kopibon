# 04 — Parity ledger

Every user-visible surface of 1.x, grouped by the parity level the port must
hit. Phase C (UI replacement) executes screen-by-screen against this ledger;
the exit criterion for a screen is that every row it owns is at its stated
level. Sources: `plans/kopibon_rust_port/discovery-03-ui-build-drift.md`
(§A1–A6), verified against source.

---

## 1. Parity levels

| Level | Meaning | Verification |
|---|---|---|
| **P0 — exact** | Same data, same behavior, same keyboard bindings, same default values. Visual fidelity to the component vocabulary (§3), not pixel-identical rendering. | Checklist per surface in `CHECKLISTS/ui-parity.md` |
| **P1 — semantic** | Same user outcomes; internals and layout may differ where the toolkit forces it (e.g. scrollbars, focus rings, font rasterisation). | Same checklist, relaxed visual items |
| **P2 — reworked** | Consciously changed. Every deviation is listed in §9 with its reason. A deviation not listed here is a defect, not a decision. | Deviation table reviewed by the user |
| **Dropped** | Present in 1.x but deliberately not ported. Listed in §8. | — |

---

## 2. Routes and shell — all P0

Router: `HashRouter` under one `AppShell` (src/renderer/src/App.tsx:91,
src/renderer/src/routes.tsx:1-30).

| Route | Element | Notes |
|---|---|---|
| `/` | redirect to `/library` (replace) | routes.tsx:14 |
| `/search` | SearchPage | :15 |
| `/library` | LibraryPage | :16 |
| `/favorites` | FavoritesGuard → FavoritesPage | :17-24; guard blocks without API key |
| `/downloads` | DownloadsPage | :25 |
| `/settings` | SettingsPage | :26 |

Shell facts that are themselves parity rows:

- Sidebar: 5 nav items, Favorites hidden unless `auth.loggedIn`
  (Sidebar.tsx:30-36, :118); active-download badge polled every 2 s (:60-72);
  update dot on Settings (:77-86); theme cycle light→dark→system (:88-92).
- Status bar: active/queued/in-library/in-Kavita counts polled every 2 s,
  nhentai.net link, app version (StatusBar.tsx:5-116, poll at :40-78).
- Onboarding is **not a route**: `OnboardingWizard` renders *instead of* the
  router until `onboardingCompleted` (App.tsx:88-94). Unreachable by URL,
  cannot be reopened. The port keeps the behavior but may add a Settings
  "run setup again" action — listed in §9 (D-onboarding-reopen).
- No 404/catch-all: unknown hash renders `AppShell` with an empty outlet
  (routes.tsx:1-30). Port keeps this unless §9 says otherwise.

## 3. Component vocabulary — P0 (shapes and tones), P1 (fonts)

The set 05-baselines and the UI spike must reproduce. One shape per component,
tone/variant driven (discovery-03 §A2, §A6):

| Component | Variants | Call sites (count) | Cite |
|---|---|---|---|
| `Notice` + `NoticeRegion` | 5 tones, one shape, icon follows tone | 14 | shared/Notice.tsx:31-70 |
| `EmptyState` | 1 | 4 | shared/EmptyState.tsx:13 |
| `LoadingSkeleton` | 3 variants: `card` ×12, `line` ×3, `detail` | — | shared/LoadingSkeleton.tsx:8 |
| `ErrorState` | 1 + retry callback | 3 | shared/ErrorState.tsx:9 |
| `ProgressBar` / `ProgressStack` | 1 / stacked | — | shared/ProgressBar.tsx:41, :129 |
| `StatusBadge` | status-driven | — | shared/StatusBadge.tsx:72 |
| `Button` | 4 roles | — | shared/Button.tsx:51 |
| `GalleryTile` | `TileCover`, `TileFormatBadge`, `TileMeta` | — | shared/GalleryTile.tsx:68,127,167 |
| `Pagination` | page input + wrap-around keys | — | shared/Pagination.tsx:78-89 |
| `PathField`, `FormatSelector`, `AutocompleteInput` | 1 each | — | shared/* |

Ephemeral feedback (no toast system exists — grep `toast|snackbar` returns
nothing): inline "Saved" states cleared after 2 s / 1.5 s / 3 s
(SettingsPage.tsx:91, :150; SearchSettings.tsx:126); job `lastMessage`
summaries cleared after 6000 ms (sync-progress.store.ts:31); OS notifications
only from main, gated on `showNotifications !== 'false'`
(download-manager.ts:744-745; library.ipc.ts:2674).

Design tokens (colors, radii, spacing, dark theme) come from the Tailwind 4
config + `assets/styles.css`; they are an input to the UI spike, not a
re-derivation.

## 4. Keyboard bindings — P0, transcribed verbatim

No application-level shortcut layer exists; every binding is local to a
component (discovery-03 §A4). The port reproduces these exactly, including the
missing input-field guards (kept at P0 with a §9 deviation proposal):

| Component | Keys | Guard | Cite |
|---|---|---|---|
| GalleryViewer (reading) | `←`/`a` prev, `→`/`d` next, `Esc` → grid, `Home`, `End` | skips INPUT/TEXTAREA/SELECT | GalleryViewer.tsx:113-156 |
| GalleryViewer (grid) | `Esc` closes panel | same | :147-150 |
| CbzViewer | `Esc`, `PageDown`/`↓`/`j` +80vh, `PageUp`/`↑`/`k` −80vh, `Home`, `End` | **none** (document-level) | CbzViewer.tsx:147-186 |
| PdfViewer | identical set to CbzViewer | **none** | PdfViewer.tsx:207-246 |
| GalleryDetail | `Esc` closes slide-over | — | GalleryDetail.tsx:133-138 |
| SearchBox | `Esc` close, `↑`/`↓` wrap, `Enter` select-or-submit | — | SearchBox.tsx:232-255 |
| AutocompleteInput | `Backspace`-on-empty removes chip; `Esc`/`Enter`/`↑`/`↓` as state requires | — | AutocompleteInput.tsx:139-199 |
| Pagination | `Enter` commit, `Esc` revert | — | Pagination.tsx:78-89 |
| LibraryPage inline edit | `Enter` persist, `Esc` cancel | — | LibraryPage.tsx:263-265 |
| LibraryDetail tag input | `Enter` add, `Backspace`-on-empty removes last | — | LibraryDetail.tsx:239-240, wired :769 |
| LibraryDetail attach id | `Enter` attaches | — | LibraryDetail.tsx:910-911 |
| SeriesDetail rename | `Enter` rename, `Esc` cancel; `Enter`/`Space` on focusable row | — | SeriesDetail.tsx:381-383, :725-726 |
| SearchSettings | `Enter` commits numeric field; chip input like LibraryDetail | — | SearchSettings.tsx:424-425, :671-675 |

## 5. Settings surfaces — P0 (behavior + defaults)

Defaults below are the parity target; full source cites in discovery-03 §A5.

**Library pane** (SettingsPage.tsx:224-255, :322-461; explicit Save button):
library path `''`; thumbnail cache `''`→resolved default; concurrency `3`
(1–8); output format `cbz`; keep-originals `true`; originals path `''` →
`<library>/_originals`; download notifications `true`; compression `true`;
quality `80` (1–95); page size `Dynamic`; black background `true`. Series
grouping toggle applies **immediately**, not on Save (SeriesGrouping.tsx:24).

**nhentai pane** (SettingsPage.tsx:258-318 + SearchSettings.tsx; saves
immediately): API key unset; search defaults all `null` except sort `date`
(whitelist search-settings.ipc.ts:87); dim-blacklist `false`; remember
searches `false`; blocked values 7 types × exclude/dim, default empty.

**Kavita pane** (KavitaSettings.tsx; Save button): enabled `false`; URL
`http://localhost:5000`; key `''`; library id `''`; root falls back to
libraryPath (settings.store.ts:107-111, load :182-189).

**Advanced pane** (SettingsPage.tsx:471-500; no Save): channel `stable`
(persisted on change, ReleaseChannel.tsx:20); convert runners `3` (1–20,
:725); log level `info`; log tail `10` (10…2000) — **not persisted**;
retention `14` days — **not persisted** (LogsPage.tsx:56-58); auto-refresh
`true`.

**Danger zone**: reset gated on typing exactly `DELETE ALL`
(SettingsPage.tsx:142, :531-533).

Persistence: settings go through SQLite IPC (settings.store.ts:90-225);
`doujin-ui-store` (theme + sidebarCollapsed) and `doujin-search-history`
(recent max 30, favorites) live in localStorage (ui.store.ts:17-37,
search-history.store.ts:46-85). The port must keep localStorage-compatible
keys or migrate them — §9 (D-localstorage-keys).

## 6. Data-freshness behavior — P0 (what the user sees), P2 (how)

All freshness is nine hand-rolled 2 s polls (one 1 s rate-limit tick), none of
them stopping on success (discovery-03 §A7). The port replaces polling with
push over the existing event channels where an event exists
(`download:progress`, `library:newItem(s)`, `library:scanProgress`,
`library:syncProgress`, job events) and keeps polling only where no event
exists. The user-visible freshness contract (≈2 s worst-case staleness) is the
P0 row; the mechanism is P2. `05-baselines.md` measures the 1.x idle cost this
replaces.

`LibraryCard` additionally never stops polling its own thumbnail
(LibraryCard.tsx:72-85) — that is a defect the port fixes loudly (sanctioned
fix category, planning plan §4); the ledger records the *user-visible*
behavior (covers appear within ~2 s of an item being added) as P0.

## 7. Non-UI surfaces the user touches

| Surface | Parity | Cite |
|---|---|---|
| Filename rules incl. `[nhentai-N]` marker and 255-byte limit | P0 (byte rules) | gallery-filename.ts:14-54; 07-metadata-spec §7 |
| Folder layout `<artist>/…`, series subdir, `_originals/`, `_lossy/` | P0 | discovery-01 §6 |
| Reserved folder names `_Unsorted`, `_migration_staging`, `_originals` | P0 | library-scanner.worker.ts:606-607 |
| CLI tools (rewrite-comicinfo, regenerate-thumbnails, migrate-paths) | P1 (reimplemented as subcommands) | tools/*.mjs |
| `DOUJIN_TEMPLATE_DIR`, user template seeding (never overwrites) | P0 | templates.ts:42-162 |
| Log files + rotation + retention | P0 | logger.ts:11, :413-433 |
| Mass-delete guard (removal pass skipped when dir unreadable / count collapse) | P0 — highest-consequence non-metadata test | 10-test-plan.md |
| ComicInfo/XMP/Keywords/ZIP byte output | P0 per 07-metadata-spec | — |

## 8. Dropped

| Item | Reason |
|---|---|
| macOS artifacts | Out of scope since 1.x (electron-builder.yml:101-104); D-decision stands |
| `@tanstack/react-query` | Mounted and entirely unused (App.tsx:11-18, :87; zero hook calls) |
| `ErrorBoundary.tsx` | Implemented, never imported. Port mounts a real one — recorded as a §9 deviation, not a parity row |
| `auth:getRateLimits`, `library:itemDeleted`, `library:newItem` (subscribed, unconsumed) | Dead channels; see 02-ipc-surface §4 for the port decision |
| `sidebarCollapsed` persisted state | No UI control to set it (ui.store.ts:25-26). Dropped unless §9 revives it with a control |

## 9. Deviations (P2) — must stay empty of unreviewed rows

| ID | Deviation | Reason | Status |
|---|---|---|---|
| D-onboarding-reopen | Settings action to re-run setup | 1.x cannot reopen the wizard; pure improvement | proposed |
| D-input-guard | Add input-field guard to CbzViewer/PdfViewer handlers | 1.x bug: keystrokes while typing in an input scroll the viewer | proposed |
| D-poll-to-push | Replace 2 s polls with event push | Better idle CPU; freshness contract unchanged | accepted |
| D-thumbnail-poll-fix | Stop per-card thumbnail polling once found | Sanctioned loud-failure/efficiency fix | accepted |
| D-error-boundary | Mount an error boundary app-wide | 1.x ships one unused; blank-screen failure is unacceptable | proposed |
| D-localstorage-keys | Keep or migrate `doujin-*` localStorage keys | Only matters for side-by-side import of prefs | open |
| D-sidebar-collapsed | Drop the dead persisted state | No UI control exists to set it | proposed |
| D-metadata-queue | `convertAllMetadata` becomes crash-resumable via a new `metadata_queue` table (additive `CREATE TABLE IF NOT EXISTS` in the migrator) | Q6 port decision, 06-subsystem-plans §5: 1.x ran the job off an in-memory array and lost its place on crash; the table is the one deliberate schema touch on existing DBs (DB-01 whitelists it) | accepted (Q6 default) |
| D-lossy-fallback-deferred | The lossy `pdftoppm` fallback raises a loud per-item error ("lossy fallback requires a rasteriser; source PDF left in place") until a rasteriser is chosen | USER DECISION of 06 §4: D3 bans poppler; pdfium/mupdf choice deferred to the packaging plan; the safety property (lossy conversion can never destroy the only full-quality copy) holds by construction | accepted |

Rules: a deviation becomes *accepted* only with a row here and a note in
`00-executive-summary.md` §Decisions. During Phase C, any behavior observed in
1.x that is not in this ledger is treated as P0 until the ledger is amended.
