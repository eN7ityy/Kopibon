# 00 — Executive summary

The one screen anyone joining the port needs. Everything here is stated in
full detail elsewhere; each section names where.

## 1. What this is

Kopibon is a GPL-3.0 Electron/TypeScript desktop app (Linux + Windows) that
downloads nhentai galleries, converts them to CBZ/PDF with embedded
`ComicInfo.xml` metadata, indexes them in a local SQLite library, and mirrors
deletes/metadata to a self-hosted Kavita server. The port re-implements it in
native Rust (`kopibon-core` + a new presentation layer), replacing Electron,
poppler and pikepdf while reproducing every user-visible behaviour — because
the metadata it writes is a contract with existing libraries and Kavita
([01-current-architecture.md](01-current-architecture.md),
[06-technology-decision.md](06-technology-decision.md)).

## 2. The binding constraint: metadata byte parity

The port lives or dies on writing metadata identical to what 1.x writes
([07-metadata-spec.md](07-metadata-spec.md) is *the contract*):

| Artefact | Parity level | Settled by |
|---|---|---|
| `ComicInfo.xml` (bytes, as written into CBZ) | **byte-identical** | template renderer + mappers (07 §2–4) |
| `/Keywords` + Info dict values | **semantic** (values identical; string encoding may differ) | D6 — port drops pikepdf's `Producer 10.8.0`, emits `/Trapped /False` as a proper name |
| PDF XMP packet bytes | **byte-identical** | S1 PASS: Rust template render + two lxml normalisations + lopdf uncompressed — 1782/1782 bytes round-tripped |
| ZIP container | **byte-identical on every structural field** | S3 PASS: hand-rolled STORE-only writer (07 §10.2) |
| Whole-PDF bytes | NOT a target — pikepdf rewrites the file; only artefact-level parity | — |
| Page image extraction (PDF→CBZ) | **byte-identical** for DCTDecode sources | S4 PASS: 16/16 images vs `pdfimages -all` |

Parity beats performance everywhere: no perf target buys an exception from
this table (05 §5).

## 3. Locked decisions D1–D8 (`plans/kopibon_rust_port/00-planning-plan.md`)

| # | Decision |
|---|---|
| D1 | GUI toolkits scored fairly — no pre-selection (06 §3–§5) |
| D2 | Byte parity for ComicInfo / `/Keywords` / ZIP; XMP gated on spike S1 (passed — byte level holds) |
| D3 | Zero external tools — no poppler, no pikepdf in the shipped build |
| D4 | Side-by-side install — 1.x and 2.x coexist; cutover is an import, not an overwrite |
| D5 | Desktop only (touch-friendly, DPI-aware); no mobile |
| D6 | Correct PDF values — Info dict = semantic parity, not byte parity |
| D7 | Legacy `Notes` string is read but never rewritten; the writer always emits the current template |
| D8 | 1.x is feature-frozen — the ledger is a fixed target; all fix pressure lands in 2.x via deviations |

## 4. What the spikes proved (06 §1)

- **S1 — XMP byte parity: PASS.** Rust template engine + the two lxml
  normalisations + lopdf uncompressed write = 1782/1782 bytes vs the golden packet.
- **S3 — ZIP parity: PASS.** ~180-line STORE-only writer matches every
  structural field of the golden CBZ; the `zip` crate is not used for writes.
- **S4 — lossless PDF extraction: PASS.** lopdf DCTDecode streams
  byte-identical to `pdfimages -all` (16/16). Remainder: the lossy
  `pdftoppm`-fallback rasteriser (pdfium-render/mupdf — 18-future-work F1).
- **S6 — rusqlite on the production DB: PASS.** WAL copy opens, integrity ok,
  14 tables, `COLLATE NOCASE` indexes, `UPDATE…RETURNING` claims verified.
- **S5 — safeStorage: resolved as key re-entry.** The nhentai key is a
  Chromium `os_crypt` v11 blob, not decryptable from Rust; users re-enter it
  on import (softened by D4). The Kavita key is app-level AES and migrates.
- **S2 — GUI performance gate: PENDING.** The only open gate. It measures a
  10k-thumbnail virtualised grid in the top two toolkit candidates (Tauri v2
  415, then Dioxus/GTK at 345; egui is the fallback) — bars M1/M2/M6 from
  05 §4. The Tauri recommendation in 06 §7 is conditional on it.

## 5. Migration shape (09-migration-phases.md)

- **Phase A** — `kopibon-core` as a library + headless CLI, differentially
  tested against live 1.x (metadata field×mutation matrix, scanner/DB parity,
  fuzz); one gate script, exit 0.
- **Phase B** — the existing Electron UI re-pointed at the Rust core over the
  144-channel IPC contract ([02-ipc-surface.md](02-ipc-surface.md)).
- **Phase C** — UI replaced screen-by-screen against the parity ledger
  ([04-parity-ledger.md](04-parity-ledger.md)); a screen is done when every
  row it owns is at its level.
- **Phase D** — packaging (≤ 80 MB unpacked vs 362 MB), updater, 1.x→2.x
  import, cutover.

## 6. Verified test environment (16-open-questions Q8; 08/07 §6)

Kavita at `http://kavita.bragi.internal` (port 80, unversioned `/api/...`,
auth = plugin key in `x-api-key`); library **Doujin-Test (id 6)** is the
sandbox (`/mnt/bragi/Kavita/DoujinsTest`, clean slate, three golden fixtures)
— production library **Doujins (id 5, 5287 files)** shares the server and is
never scanned, mutated or deleted; every suite asserts that.

## 7. How to use this corpus

Reading order is the table in [README.md](README.md): 00 → 01–05 (system,
IPC, data, parity, baselines) → 06–07 (tool decision, the metadata contract)
→ 08 subsystem plans → 09–14 (phases, tests, CI, risks, licences, tasks).
**Implementers start at [15-agent-playbook.md](15-agent-playbook.md)** — it
is the entry point that sequences Phase A against the subsystem plans and
task breakdown. Operational checklists (UI parity, gates, release) live in
`CHECKLISTS/`; cross-doc contradictions in 1.x docs are catalogued in
[17-doc-drift.md](17-doc-drift.md), deferred items with triggers in
[18-future-work.md](18-future-work.md).

## 8. Accepted deviations and what still needs review (04 §9)

| ID | Deviation | Status |
|---|---|---|
| D-poll-to-push | Replace the nine 2 s polls with event push; freshness contract (≈2 s) unchanged | **accepted** |
| D-thumbnail-poll-fix | Stop per-card thumbnail polling once found (1.x defect) | **accepted** |
| D-onboarding-reopen | Settings action to re-run the setup wizard | proposed — needs user review |
| D-input-guard | Guard CbzViewer/PdfViewer keys against typing-in-input | proposed — needs user review |
| D-error-boundary | Mount the (1.x-unused) ErrorBoundary app-wide | proposed — needs user review |
| D-sidebar-collapsed | Drop the dead persisted sidebar state | proposed — needs user review |
| D-localstorage-keys | Keep vs migrate `doujin-*` localStorage keys (side-by-side pref import) | open — user call |

A deviation not listed there is a defect, not a decision.

## 9. Status

Planning corpus **complete** (00–18 + eight subsystem plans). Spikes
S1/S3/S4/S5/S6 **done** and recorded (06 §1; 07 §10). **S2 outstanding** —
the single gate before the toolkit decision closes (Q3). Implementation **not
started**: no `kopibon-core`/`src-tauri` tree exists yet, and no file outside
`docs/rust-port/` is modified during planning.
