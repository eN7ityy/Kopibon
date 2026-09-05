# 09 — Migration phases (the strangler plan)

Four phases, A–D, exactly as framed in planning plan §6
(`plans/kopibon_rust_port/00-planning-plan.md:280-294`): Phase A proves the byte contract
headless, Phase B the wire contract with the existing UI, Phase C the UI surface, Phase D
ships. Each phase states objective, entry criteria, work items (referencing subsystem
plans by number), **machine-checkable exit criteria**, a demo and a rollback; a phase
starts only when the previous gate returns 0. Standing rules, every phase:
**D8 — 1.x is feature-frozen** — no 1.x change unblocks the port; the ledger
([04-parity-ledger.md](04-parity-ledger.md)) is a fixed target and all fix pressure lands
in 2.x via its §9 deviation table. **Corpus rule** — during planning no file outside
`docs/rust-port/` changed: `git diff --stat dev -- . ':!docs/rust-port'` is empty;
implementation is a new tree (`kopibon-core`, `src-tauri/`), never an edit of
`src/main/`. **Parity over numbers** ([05-baselines.md](05-baselines.md) §5): no perf
target buys an exception from the metadata contract. **Regression gate**: the Phase A
matrix and Phase B contract suite re-run in CI at every later phase.

## Phase A — `kopibon-core` as a library + headless CLI

**Objective.** Build the Rust core — metadata engine, filename rules, scanner, nhentai
client, DB layer, download/conversion/sync pumps, Kavita client — headless, nothing
shipped, proved against live 1.x over the golden corpus
([10-test-plan.md](10-test-plan.md) §1–§3).

**Entry criteria.** Spike results recorded in [07-metadata-spec.md](07-metadata-spec.md)
§10 — S1 PASS (XMP byte parity via the two lxml normalisations), S3 PASS (STORE-only
ZIP), S4 PASS (lossless DCTDecode extraction), S6 PASS (production DB opens from
`rusqlite`); the fixtures copied read-only from `/mnt/bragi/Kavita/DoujinsTest/` into
the repo test area with sha256 provenance (01-metadata-engine plan §10); a byte copy of
the production DB (5261 items) for the DB suite — never the live one
([08-subsystem-plans/05-database-layer.md](08-subsystem-plans/05-database-layer.md) §3).

**Work items**, DB first, metadata in parallel, pumps after (references are
`08-subsystem-plans/N`): 08/05 `kopibon-core::db` (migrator, repos, search,
maintenance); 08/01 `kopibon-core::metadata` (template engine, mappers, writers,
filenames); 08/02 `kopibon-core::scanner` (walk, extraction, removal triple guard);
08/04 nhentai client, then 08/03 download manager + workers; 08/06 PDF→CBZ pump,
convertAllMetadata (DB-backed per Q6), originals; 08/07 sync pump + Kavita client;
[10-test-plan.md](10-test-plan.md) §7 — differential harness, golden corpus, fuzz.

**Exit criteria — machine-checkable.** One command gates the phase:
`scripts/port/phase-a-gate.sh`, exit 0 iff all of:

1. **Field × mutation matrix** — `cargo test -p kopibon-core --test
   differential_matrix`: every cell of the 12 write paths (07-metadata-spec §6) × 4
   artefact kinds, diffed by `tests/differential/harness.mjs` (JS spawns real 1.x
   builders from built `dist/`; Rust renders via the `kopibon-core` CLI) at the required
   level per artefact (07 §1) — ComicInfo **byte** (Notes line excluded per Q11),
   `/Keywords` + Info values **semantic**, XMP packet **byte** (1782 B golden), ZIP
   container **byte** on every structural field, page extraction **byte** for DCTDecode.
   Pass rule: zero diffs at the required level; *equal error strings* where JS throws;
   every emitted CBZ CRC-validated by Python `zipfile`. Fixtures: the three golden
   files of 07 §11 plus the CURRENT-BUILD captures (10-test-plan §1.2).
2. **Fuzz** — template seed corpus 26/26 + generated cases ≥10k per run, output *and*
   error strings equal; nightly 1M soak clean three consecutive runs before the gate is
   first declared (01 plan §8).
3. **Scanner parity** — `cargo test --test scanner_differential`: row-for-row DB
   equality vs a live 1.x scan of the golden corpus; all three removal-guard tests with
   zero deletions (02 plan §11–§12).
4. **DB parity** — `cargo test --test db_differential`: `sqlite_master` unchanged across
   a Rust open of the production copy; read parity over the filter/sort matrix; atomic
   claims green under concurrency (05 plan §8–§9).
5. **Pumps** — download/conversion/sync differential suites green (03/06/07 plan exits),
   including crash recovery ([10-test-plan.md](10-test-plan.md) §6).

**Demo.** One headless CLI run against a fixture nhentai server: search → download →
file on disk with byte-parity ComicInfo/ZIP or XMP → scan into a DB equal to 1.x's rows
→ sync rewrite → Kavita-path assertions. No GUI. **Rollback.** Nothing ships; 1.x is
frozen and untouched (D8); the port tree and dev-only harness revert with zero user
impact. Any matrix-cell failure blocks Phase B — the fix lands in `kopibon-core`, never
by re-defining parity.

## Phase B — the existing UI against the Rust core

**Objective.** The unchanged React renderer (~87 files, ~18,000 lines of TS/TSX) runs
end-to-end against the Rust core with real data, UI unchanged
([08-subsystem-plans/08-gui-app-shell.md](08-subsystem-plans/08-gui-app-shell.md) §1).

**The host decision — sidecar vs FFI vs re-host.** Three mechanisms were live:

| Option | Shape | Verdict |
|---|---|---|
| Sidecar | Electron main spawns `kopibon-core` as a child process over stdio/localhost | Rejected: keeps the Electron main process the port exists to retire; duplicates the envelope/errorId implementation in two languages; adds process-lifecycle crash states |
| FFI | `kopibon-core` as a `cdylib`/napi-rs module loaded by Electron main | Rejected: same retirement problem plus an unsafe boundary around the whole core; async core tasks behind a JS event loop is the worst of both runtimes |
| **Re-host (chosen)** | Renderer under **Tauri v2**; a bridge shim builds the identical `window.api` from Tauri `invoke`/`listen`; the 144 channels re-expressed once, Rust-side | Per [06-technology-decision.md](06-technology-decision.md) §7 (conditional primary, S2-gated) and 08-GUI §2: one process, no protocol duplication, `HashRouter` unchanged, the preload file simply deleted |

**Work items** (08-GUI plan): renderer shim `bridge.ts` (§2.1); Rust command layer —
one module per namespace, `envelope.rs` port of `handle.ts` with errorId and the
≥250 ms slow-handler warning, `events.rs` with the per-event audience table (§2.2); the
Electron-specific groups — shell/dialog plugins, updater with `autoDownload=false`,
scoped asset protocol replacing unscoped `file:read`, `safeStorage` → `keyring`,
notifications (§2.3); bootstrap parity in boot order (§2.4); polls→push under the
freshness contract (§2.5; ledger D-poll-to-push, D-thumbnail-poll-fix). Phase B runs
against a **scratch data dir + the golden-corpus library**; the production DB is touched
only through its byte copy in the DB suite. On S2 failure the egui ladder fires (06 §7,
08-GUI §8) and only the shim is discarded.

**Exit criteria — machine-checkable** (08-GUI §7, criterion 1). (1) `npm run
contract:bridge` — the contract suite generated from
[02-ipc-surface.md](02-ipc-surface.md) §2/§3: 130 request/response channels (131 invoke
sites) with envelope-shape assertions per variant (thrown-with-errorId,
soft-fail-without, bare-`success`, raw `log:*`) and the 14 events with payload shapes
and working unlisten — **144/144 green**. (2) `cargo test --test freshness`:
steady-state IPC = 0 with the library grid open (M4, 06 §6.2); covers appear ≤2 s after
`library:newItems`. (3) A scripted full real-data session (search → download → scan →
convert → sync → settings → viewer) completes with events as the only freshness
mechanism and behaviour equal to 1.x. (4) Log parity: fresh Crockford-base32 errorId
per thrown command, different ids for repeat errors, slow-handler warning at ≥250 ms.

**Demo.** Side-by-side recording: 1.x and the Rust-hosted build executing the same
script against the same library, indistinguishable except by title bar — plus idle CPU
at the 05-baselines §2 target. **Rollback.** 1.x is still the shipped app (D8); the
Tauri build is a dev artefact in its own data dir. Abandoning Phase B costs the shim and
command layer only — every Phase A subsystem is a library and survives into any later
host decision.

## Phase C — UI replaced screen-by-screen against the parity ledger

**Objective.** Every user-visible surface at its stated
[04-parity-ledger.md](04-parity-ledger.md) level, and remaining accepted deviations
landed through the ledger table. Under the Tauri primary, Phase C is **not a screen
rebuild** — the screens are the same React components; the work is re-verifying every
ledger row against the re-hosted renderer and closing deviations (08-GUI §4). Under the
egui fallback it is the full ledger rebuild in immediate-mode code (08-GUI §8), screen
order = ledger §2 shell → §3 vocabulary → routes, each screen exiting when every row it
owns is at its level.

**Work items.** (1) Walk ledger §2–§5 per route (`/library`, `/search`, `/favorites`,
`/downloads`, `/settings`, shell): routes P0; component vocabulary P0 shapes / P1 fonts;
keyboard bindings verbatim (§4) — the two unguarded document-level viewers stay
unguarded unless D-input-guard is accepted; settings defaults P0 (§5); freshness
contract P0, mechanism P2. (2) **Deviation rules** (ledger §9, binding): a deviation
becomes *accepted* only with a ledger §9 row and a note in the executive summary; any
1.x behaviour not in the ledger is treated as P0 until the ledger is amended — silently
changing it is a defect, not a decision. Phase C lands only proposed rows with user
sign-off (D-onboarding-reopen, D-input-guard, D-error-boundary) and resolves
D-localstorage-keys / D-sidebar-collapsed either way. (3) Non-UI surfaces (ledger §7):
filename rules, folder layout, CLI subcommands, `DOUJIN_TEMPLATE_DIR` seeding, log
files, mass-delete guard.

**Exit criteria — machine-checkable.** (1) `CHECKLISTS/ui-parity.md`: every row signed
at its stated level, zero unchecked rows; every P2 row has a reviewed ledger entry.
(2) `npm run contract:bridge` still green and `scripts/port/phase-a-gate.sh` still
exits 0. (3) Baselines re-measured on the 2.x build (08-GUI §7, criterion 3): idle RSS
≤150 MB, cold start ≤1.0 s, 0 steady-state IPC, 1 thumbnail fetch per item per session.
(4) Boot-parity tests: fresh dir → wizard instead of router; completed dir → routes; no
route access during onboarding (08-GUI §6).

**Demo.** The 2.x build driven through the full parity checklist live, with 1.x beside
it for comparison. **Rollback.** Same as Phase B — 1.x ships until cutover (Phase D); a
screen that fails its rows keeps 2.x in Phase B state for that surface, which is
functionally the same app.

## Phase D — packaging, updater, 1.x→2.x import, cutover

**Objective.** Ship 2.x as a side-by-side install (D4), import a 1.x profile without
touching it, cut over.

**Work items.** (1) **Packaging and updater** — owned by
[11-ci-release-plan.md](11-ci-release-plan.md) (boundary fixed in 08-GUI §5): Tauri
bundler targets mirroring 1.x (AppImage, .deb, .rpm, NSIS), `beforeBuildCommand` = the
same Vite build, `tauri-plugin-updater` against the same GitHub feed keeping
`autoDownload=false` and the cached-status-`null`-before-first-event behaviour,
`app:checkToolchain` reporting **zero** external tools (D3), ≤80 MB unpacked budget
(05 §1; 1.x measured 362 MB).

(2) **1.x→2.x import (D4, side-by-side).** New appId + new data dir; on first run 2.x
imports from the 1.x profile and **leaves 1.x untouched**:

- **DB copy-forward:** checkpoint and copy `db.sqlite` (+WAL) into the 2.x data dir,
  open with the Rust migrator — zero schema surprises on an already-migrated DB;
  `_migrated_*` sentinels preserved verbatim
  ([03-data-model.md](03-data-model.md) §7.3, §10.1). **Mixed timestamp units** travel
  with the copy: real DBs hold milliseconds (Drizzle module-load defaults,
  `seedDefaults`, the `sync_queue` claim/finish path) beside `unixepoch()` seconds —
  the port writes seconds, tolerates ms on read via the `Timestamp` newtype, and
  **never rewrites old rows** (03 §10.5, §6.4; 05-DB plan §7).
- **safeStorage re-entry (S5):** the nhentai API key is Electron `safeStorage`/
  OS-keychain material and is **not recoverable** from Rust — first run prompts
  re-entry. The Kavita key is app-level AES: port `decryptKey` verbatim and it imports
  cleanly (07-sync plan §5.1, 05-DB plan §5). S5 is softened by D4: 1.x keeps its key
  either way.
- **Preferences:** `doujin-ui-store` + `doujin-search-history` localStorage keys
  imported or migrated per D-localstorage-keys; `onboardingCompleted` flows through the
  copied settings (08-GUI §2.6). **Library files are not copied** — settings point 2.x
  at the same library root, thumbnails and originals; only DB + prefs move. Import is
  one-way and non-destructive: sha256 of the 1.x data dir and keychain entries
  identical before and after.

(3) **Cutover.** 2.x released on the existing channels; 1.x stays feature-frozen (D8)
and installable side-by-side; `upgrade.md` documents import, divergence handling and
key re-entry. After a stabilisation window 1.x retires — migration already happened at
first 2.x run, so retirement is a download-page change, not a migration.

**Exit criteria — machine-checkable.** (1) `cargo test --test import_matrix`: a
scripted 1.x profile (populated DB, encrypted Kavita key, localStorage blobs, absent
nhentai key) → import → every `library_item`/`gallery`/`series`/queue/settings row
present and equal; `integrity_check ok`; re-run → idempotent. (2) **Non-destructive
proof:** sha256 over the 1.x data dir + a keychain probe unchanged before/after the
import run — asserted, not assumed. (3) Mixed-units test: a DB seeded with both ms and s
rows reads, sorts and displays correctly after import; no row rewritten (03 §10.5).
(4) Packaged artifacts within 05 §1 budgets; updater end-to-end green against a staged
release feed (explicit user action before download). (5) Full Phase A + B + C gate set
re-run on the packaged build.

**Demo.** On a clean machine: install 1.x, populate, install 2.x beside it, run the
import, use both apps alternately against the same library; the 1.x profile is
byte-identical at the end and the re-entry prompt appears once. **Rollback.** By
construction: delete the 2.x data dir and uninstall 2.x; 1.x never had a byte touched
(D4 + exit criterion 2). Library files are shared but only ever mutated through the
byte-parity writers both builds use — a 2.x-written file is a legal 1.x file (Phase A
matrix).

**Gate chain.** A — `scripts/port/phase-a-gate.sh` exit 0 — blocks B–D; B —
`npm run contract:bridge` 144/144 — blocks C–D; C — `CHECKLISTS/ui-parity.md` fully
signed — blocks D; D's gates block cutover.
