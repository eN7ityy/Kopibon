# CHECKLISTS — UI parity walk

Per [../04-parity-ledger.md](../04-parity-ledger.md). **§9 deviation rule: any behaviour observed in 1.x that is not
in this ledger is treated as P0 until the ledger is amended — a deviation not listed in ledger §9 is a defect,
not a decision.** Deviations become *accepted* only with a §9 row + a note in [../00-executive-summary.md](../00-executive-summary.md) §Decisions.
Phase C exit = every box ticked at its stated level, zero unchecked rows ([../09-migration-phases.md](../09-migration-phases.md) Phase C exit 1); this walk is test UI-01.

## Shell and routes (ledger §2 — all P0)

- [ ] `/` redirects (replace) to `/library`; routes `/search`, `/library`, `/favorites`, `/downloads`, `/settings` present under one `HashRouter` + `AppShell`
- [ ] `/favorites` guard blocks without API key
- [ ] Sidebar: 5 nav items; Favorites hidden unless `auth.loggedIn`; active-download badge polled every 2 s; update dot on Settings; theme cycle light→dark→system
- [ ] Status bar: active/queued/in-library/in-Kavita counts (2 s poll), nhentai.net link, app version
- [ ] Onboarding not a route: renders *instead of* the router until `onboardingCompleted`; unreachable by URL, not reopenable (reopen action only via §9 D-onboarding-reopen)
- [ ] No 404/catch-all: unknown hash renders `AppShell` with empty outlet

## Keyboard bindings (ledger §4 — P0, verbatim)

- [ ] GalleryViewer reading: `←`/`a` prev, `→`/`d` next, `Esc` → grid, `Home`, `End`; guard skips INPUT/TEXTAREA/SELECT
- [ ] GalleryViewer grid: `Esc` closes panel; same guard
- [ ] CbzViewer: `Esc`, `PageDown`/`↓`/`j` +80vh, `PageUp`/`↑`/`k` −80vh, `Home`, `End`; **no input guard** (document-level) unless D-input-guard accepted
- [ ] PdfViewer: identical set to CbzViewer; **no input guard**
- [ ] GalleryDetail: `Esc` closes slide-over
- [ ] SearchBox: `Esc` close, `↑`/`↓` wrap, `Enter` select-or-submit
- [ ] AutocompleteInput: `Backspace`-on-empty removes chip; `Esc`/`Enter`/`↑`/`↓` as state requires
- [ ] Pagination: `Enter` commit, `Esc` revert
- [ ] LibraryPage inline edit: `Enter` persist, `Esc` cancel
- [ ] LibraryDetail tag input: `Enter` add, `Backspace`-on-empty removes last; attach id: `Enter` attaches
- [ ] SeriesDetail rename: `Enter` rename, `Esc` cancel; `Enter`/`Space` on focusable row
- [ ] SearchSettings: `Enter` commits numeric field; chip input like LibraryDetail

## Component vocabulary + feedback (ledger §3 — P0 shapes/tones, P1 fonts)

- [ ] One shape per component, tone/variant driven: `Notice`+`NoticeRegion` (5 tones), `EmptyState`, `LoadingSkeleton` (`card`×12/`line`×3/`detail`), `ErrorState` (+retry), `ProgressBar`/`ProgressStack`, `StatusBadge`, `Button` (4 roles), `GalleryTile` (cover/format badge/meta), `Pagination`, `PathField`, `FormatSelector`, `AutocompleteInput`
- [ ] Feedback — no toast system exists: inline "Saved" states cleared after 2 s / 1.5 s / 3 s; job `lastMessage` summaries cleared after 6000 ms; OS notifications only from main, gated on `showNotifications !== 'false'`
- [ ] Design tokens from the Tailwind 4 config + `assets/styles.css` (input, not re-derivation)

## Settings defaults (ledger §5 — P0 behavior + defaults)

- [ ] Library pane (explicit Save): path `''`; thumbnail cache `''`→resolved default; concurrency `3` (1–8); format `cbz`; keep-originals `true`; originals path → `<library>/_originals`; download notifications `true`; compression `true`; quality `80` (1–95); page size `Dynamic`; black background `true`; **series grouping toggle applies immediately, not on Save**
- [ ] nhentai pane (saves immediately): API key unset; search defaults `null` except sort `date`; dim-blacklist `false`; remember searches `false`; blocked values 7 types × exclude/dim, default empty
- [ ] Kavita pane (Save): enabled `false`; URL `http://localhost:5000`; key `''`; library id `''`; root falls back to libraryPath
- [ ] Advanced pane (no Save): channel `stable` (persisted on change); convert runners `3` (1–20); log level `info`; log tail `10` (10…2000) **not persisted**; retention `14` days **not persisted**; auto-refresh `true`
- [ ] Danger zone: reset gated on typing exactly `DELETE ALL`
- [ ] Persistence via SQLite IPC; `doujin-ui-store` + `doujin-search-history` (recent max 30, favorites) localStorage keys kept or migrated per D-localstorage-keys

## Data freshness (ledger §6)

- [ ] Freshness contract P0: ≈2 s worst-case staleness for all nine 1.x poll surfaces; mechanism P2 (push where an event exists; covers appear ≤2 s after `library:newItems`)

## Non-UI surfaces (ledger §7)

- [ ] Filename rules incl. `[nhentai-N]` marker + 255-byte limit (P0); folder layout `<artist>/…`, series subdir, `_originals/`, `_lossy/`; reserved names `_Unsorted`, `_migration_staging`, `_originals`
- [ ] CLI tools as subcommands (P1); `DOUJIN_TEMPLATE_DIR` seeding never overwrites (P0); log files + rotation + retention (P0); mass-delete guard (P0); ComicInfo/XMP/Keywords/ZIP byte output per [../07-metadata-spec.md](../07-metadata-spec.md)

## Sign-off

- [ ] Every P2 row encountered has a reviewed ledger §9 entry (D-poll-to-push, D-thumbnail-poll-fix accepted; others only with user sign-off)
- [ ] `npm run contract:bridge` green and `scripts/port/phase-a-gate.sh` exit 0 still hold (Phase C exit 2)
