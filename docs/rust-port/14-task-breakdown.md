# 14 — Task breakdown (dependency-ordered work packages)

The port as work packages WP-A1…WP-D3, mapped onto the four phases of
[09-migration-phases.md](09-migration-phases.md). Each WP names its corpus
inputs, deliverable, dependencies, size, and the acceptance evidence — which is
always a gate or a test ID from [10-test-plan.md](10-test-plan.md) §7 (the
machine-readable mirror is `CHECKLISTS/tests.md`, same IDs, one line per test:
`ID | level | fixture | command`).

**Size assumption.** 1 agent-day = one focused working session with the
environment of [15-agent-playbook.md](15-agent-playbook.md) already built
(toolchain, harness, fixtures captured, Kavita rules loaded). **S** ≈ 1–2
days, **M** ≈ 3–5, **L** ≈ 6–10, including tests and self-review, excluding
escalation waits (15 §5). Estimates assume the differential harness is usable;
anything that must *build* the harness first is priced into WP-A11.

**Definition of done (binding, every WP).** A WP is done only when:

1. the deliverable is merged on its WP branch (15 §1.4) with its conventional
   commits;
2. every acceptance test of the WP **exists in `CHECKLISTS/tests.md`** with
   ID, level, fixture and command (10-test-plan §8 rule 4 — a WP whose tests
   are not in the checklist is not done, no matter how green its local run);
3. the phase gate that owns it still re-runs green
   (`scripts/port/phase-a-gate.sh` for A; `npm run contract:bridge` for B/C).

**Standing dependency.** Phase A starts only after its entry criteria
(09 §Phase A): spike evidence S1/S3/S4/S6 recorded in 07-metadata-spec §10,
the three golden fixtures copied read-only into the repo with sha256
provenance (R15 mitigation), and a **byte copy** of the production DB
(5261 items) — never the live one.

---

## Phase A — `kopibon-core` headless (gate: `scripts/port/phase-a-gate.sh` exit 0)

| WP | Title | Inputs | Deliverable | Depends on | Size | Acceptance |
|---|---|---|---|---|---|---|
| **A1** | Workspace scaffold + toolchain pinning | 11 §2–§3, 13-licence-audit, 09 corpus rule | Cargo workspace `kopibon-core` with module stubs mirroring 08/01 §1; `rust-toolchain.toml` pinning rustc/cargo 1.97 (+clippy, rustfmt) as the single version authority; CI wiring per 11 §3; golden fixtures + prod-DB byte copy committed read-only with provenance manifests | — | S | `cargo test` green on stubs; fixture provenance present (R15); gate script exists and fails cleanly; `clippy`/`rustfmt` wired |
| **A2** | Template engine + mappers + xml-utils (differential fuzz) | **07-metadata-spec §2–§5 (normative)**, 08/01 §2–§4, §8 | `metadata/{template,templates_io,context,mappers,xml_utils,js_number}.rs` — the four regexes verbatim, emptiness rule, section/each semantics, verbatim error strings, JS number semantics, the mapper decision rules of 07 §4 | A1, A11-core | **L** | TA-01 (26/26 seeds byte-exact incl. error strings), TA-02 (fuzz ≥10k/run; nightly 1M soak clean 3× before first gate declaration — 09 exit 2), MA-01 (58 mapper cases on real templates) |
| **A3** | Writers (ComicInfo / PDF-lopdf / hand-rolled ZIP) + clock injection | 07 §1, §9, §10; 08/01 §5–§6 | `metadata/writers/{comicinfo,pdf,zip}.rs` + `apply_metadata` dispatcher; the `Clock` trait threading every volatile field; STORE-only ZIP per the S3 field list; lopdf writer per S1 with the two lxml normalisations | A2 | **L** | WR-01 matrix cells at required levels (ComicInfo byte, Notes line excluded per Q11; XMP packet byte vs the 1782 B golden; Info dict semantic per D6; ZIP byte per S3), WR-02, WR-03 (+ Python `zipfile` CRC) |
| **A4** | Filenames / the three sanitisers | 07 §7–§8, 08/01 §7 | `metadata/filenames.rs`: download sanitiser, custom-entry sanitiser, directory-segment sanitiser — **all three verbatim, never unified** — plus marker machinery, 255-byte basename rule, `temp_sibling_path` | A1 | M | FN-01 incl. 251–255-byte Japanese boundary vectors and code-point-safe truncation; Windows CI run green (R9) |
| **A5** | Database layer + migrator (production-DB differential) | **03-data-model (normative)**, 08/05 | `db/` subtree: migrator (verbatim DDL + PRAGMA-guarded ALTERs + `_migrated_*` sentinels), settings wrapper, `buildLibraryFilter` port, 9 repos, startup maintenance; WAL + read pool + single serialized writer, `busy_timeout=5000` (08/05 §4) | A1, A11-core | **L** | DB-01 (`sqlite_master` unchanged across a Rust open of the production copy; `integrity_check ok`), DB-02 (read parity over the full filter × sort matrix incl. the tag over-match case at 1.x semantics — the 05-DB §6 USER DECISION), queue-claim concurrency, mixed ms/s tolerated |
| **A6** | Scanner port | 03 §2.9, §6.2; 08/02 | `scanner/` subtree: walk rules with `failedDirs`, scan_queue lifecycle, PDF/CBZ extraction, thumbnail scheme, **the triple-guarded removal pass** | A4, A5 (xml decode from A2) | **L** | SC-01 (row-for-row vs live 1.x scan of the golden corpus), SC-02 (all three removal guards with **zero deletions** + happy path — 10 §5; R2) |
| **A7** | nhentai client + rate limiter + tags | 08/04 | `nhentai/` subtree: all endpoints (none dropped), token-bucket limiter with single drain loop, auth tiers, tag resolver behind `TagCacheStore`, search-query port, the separate 3-attempt sync fetch | A1 (A5 for the DB-backed tag half) | M | Limiter/query unit tests against the 08/04 tables; replay-transport HTTP tests; DL-01 unblocked |
| **A8** | Download manager + PDF assembler | 08/03, 07 | `download/` subtree: queue pump (single-scheduler invariant), pipeline steps, CDN rotation/demotion, scratch lifecycle, `worker_pdf.rs` minimal-PDF assembly, `worker_cbz.rs` via `StoreZipWriter` | A3, A4, A5, A7 | **L** | DL-01 (pipeline vs 1.x on the scripted CDN/failure ladder; semantic + byte artefacts); CR-01 download-queue kill points |
| **A9** | Conversion pipeline (PDF→CBZ + `convertAllMetadata` DB-backed) | 08/06, Q6 | `conversion/` subtree: queue pump, the 8 ordered worker steps (order is the safety property), S4 extraction + fallback policy, verify gate, originals walk; `convertAllMetadata` as a **DB-backed `metadata_queue`** — the sanctioned Q6 deviation **with its ledger §9 P2 row landed at this WP's exit** (R7) | A3, A4, A5 | **L** | CV-01 (golden PDF→CBZ + verify gate both ways); CR-01 conversion + metadata-queue kill/resume rows; ledger row present |
| **A10** | Sync | 08/07 §2–§4 | `sync/` subtree: 3-attempt Retry-After fetch, metadata rebuild with DB-sourced series fields, in-place `apply_metadata` rewrite, strictly serial pump, 90 % pacing that counts the item's own work, cooperative cancel | A3, A5, A7 | M | SY-01 (retry/pacing/cancel vs 1.x on a scripted gallery); in-place-rewrite atomicity covered by CR-01 |
| **A11** | Differential harness + golden corpus capture (JS side) | 10 §1–§3, 09 Phase A exit 1 | `tests/differential/harness.mjs` + `db_harness.mjs` (dev tree, never shipped), CURRENT-BUILD capture scripts across the 12 write paths of 07 §6 with provenance manifests, `scripts/port/phase-a-gate.sh` | A1; **the first slice (template op) is a prerequisite of A2** | M | Gate script evaluates all five 09 exit conditions; harness ops cover every op of 10 §3; capture manifests complete (R15) |
| **A12** | Kavita client + acceptance hooks | 08/07 §5–§6, 10 §4 | `kavita/` subtree: request core, endpoint table, path translation, `decryptKey` boundary; acceptance harness with the **library-id guard refusing id 5** and the pre/post count assertions (KV-02) | A5 | M | KV-01 (positives *and* negatives of 10 §4.1–4.4, `--ignored` by default), KV-02 green — one changed id-5 count fails the run (R16) |

Phase ordering within A: **DB first (A5), metadata in parallel (A2→A3), pumps
after** (A8/A9/A10) — 09 §Phase A. The Phase A exit is the five machine-checkable
conditions of 09 (matrix, fuzz, scanner parity, DB parity, pumps); no GUI, nothing
shipped.

### Phase A WP notes (the ones with traps)

- **A2.** The normative source is 07-metadata-spec, not the TS file; the port
  is "the code that satisfies the spec, proved against live 1.x". The two lxml
  normalisations (S1) are implemented as exactly two explicit passes in
  `writers/pdf.rs`, never generalised into a serialiser and never applied to
  ComicInfo (08/01 §4). Error strings with 1-based line numbers are differential
  assertions, not decoration. The nightly 1M soak must be clean three
  consecutive runs *before* the gate is first declared.
- **A3.** The `zip` crate is not used for writes (S3); the hand-rolled
  STORE-only writer is the deliverable, with the S3 structural-field list as
  the test contract and Python `zipfile` as the external validator. Volatile
  fields (`MetadataDate`, `dc:date` now-fallback, `calibre:timestamp`,
  `/CreationDate`, `/ModDate`, ZIP DOS/UT stamps) all go through `Clock` or
  explicit mtime parameters (07 §9) — that is what makes the corpus freezable.
  D6's sanctioned deviations (`Producer = "Kopibon 2.x"`, `/Trapped /False` as
  a proper name) are pre-accepted; the Info dict is semantic by decision.
- **A5.** The migrator is a line-for-line port of `runMigrations()`
  (`connection.ts:146-405`) — SQL strings copied, never re-derived from
  `schema.ts` (which is decorative and wrong, 03 §3). The zero-surprise test
  on the already-migrated production copy is the precondition for every other
  subsystem's differential work, which is why A5 is first.
- **A8/A9/A10 (the pumps).** Port-decided invariants: single download
  scheduler (no `UPDATE…RETURNING` — 08/03 §3), conversion/sync keep their
  `RETURNING` claims, the sync pump stays strictly serial at 90 % pacing, and
  the conversion worker's 8-step order is the safety property (08/06 §3).
  A9's `metadata_queue` is the one deliberate deviation — it ships **with**
  its ledger §9 row (R7), and the crash test documents that 1.x would have
  restarted from scratch.
- **A11.** Not a tail WP: its first slice (the template op) is a prerequisite
  of A2, and capture of CURRENT-BUILD fixtures across the 12 write paths
  (10 §1.2) has to complete before the matrix can run at all. The harness and
  capture scripts are dev-tree, never shipped, and are the only sanctioned
  JS-side code (09 corpus rule).

---

## Phase B — the existing UI against the Rust core (gate: `npm run contract:bridge` 144/144)

| WP | Title | Inputs | Deliverable | Depends on | Size | Acceptance |
|---|---|---|---|---|---|---|
| **B1** | Phase B bridge — the host decision executed | 06 §6–§7, 08-GUI §1–§2.1, 02-ipc-surface | S2 run against Tauri v2 and recorded per the 06 §7 decision conditions (on failure: the egui ladder fires and **this goes back to the user**, 15 §5); Tauri scaffold; renderer `bridge.ts` building the identical `window.api` from `invoke`/`listen`; preload file deleted | Phase A gate | **L** | S2 bars M1/M2/M6 met or the flip escalated; shim preserves envelope shapes, error passthrough and working unlisten closures (08-GUI §2.1) |
| **B2** | Rust command layer (envelope + events + 130 channels) | 02-ipc-surface §1–§4, 08-GUI §2.2 | `commands/` one module per namespace, `envelope.rs` (Crockford-base32 `errorId`, ≥250 ms slow-handler warning, soft-fail-without-errorId distinction, raw `log:*`), `events.rs` with the per-event audience table | B1 | M | BR-01: `npm run contract:bridge` **144/144** (130 request/response + 14 events; envelope shape per variant); log-parity exit 4 of 09 §Phase B |
| **B3** | Electron-specific groups + bootstrap + freshness | 02 §5–§6, 08-GUI §2.3–§2.5 | shell/dialog plugins, `tauri-plugin-updater` with `autoDownload=false`, scoped asset protocol replacing unscoped `file:read`, `safeStorage`→`keyring`, notifications; boot-order parity; the nine 2 s polls → event push under the freshness contract (D-poll-to-push, D-thumbnail-poll-fix) | B2 | M | `cargo test --test freshness` (steady-state IPC = 0 with the grid open; covers ≤2 s after `library:newItems`); the scripted full real-data session of 09 §Phase B exit 3; boot parity (§2.4) |

Phase B runs against a **scratch data dir + the golden-corpus library**; the
production DB is touched only through its byte copy (09 §Phase B).

---

## Phase C — parity re-verification / rebuild (gate: `CHECKLISTS/ui-parity.md` fully signed)

Under the Tauri primary Phase C is **not a rebuild** — the screens are the same
React components and each WP re-verifies every ledger row it owns against the
re-hosted renderer. Under the egui fallback the same WPs become the full
ledger rebuild in immediate-mode code, screen order = ledger §2 → §3 → routes
(08-GUI §8, §4). Every WP's acceptance: all `CHECKLISTS/ui-parity.md` rows it
owns signed at their stated level, zero unchecked; `npm run contract:bridge`
and `scripts/port/phase-a-gate.sh` still green.

| WP | Surface | Ledger anchor | Size |
|---|---|---|---|
| **C1** | Shell: `AppShell`, sidebar (5 items, Favorites guard, badge, update dot, theme cycle), status bar | 04 §2 | S (verify) / M (rebuild) |
| **C2** | `/library` — LibraryPage incl. virtualised grid, inline edit keys, detail slide-over | 04 §2, §4 | M / L |
| **C3** | `/search` — SearchPage, SearchBox keys, rate-limit tick | 04 §2, §4, §6 | S / M |
| **C4** | `/favorites` — FavoritesGuard + FavoritesPage | 04 §2 | S / S |
| **C5** | `/downloads` — DownloadsPage | 04 §2 | S / M |
| **C6** | Settings — Library + Advanced + Danger panes (defaults P0 per 04 §5; `DELETE ALL` gate; series-grouping applies immediately) | 04 §5 | S / M |
| **C7** | Settings — nhentai pane + SearchSettings + blocked values (7 types × exclude/dim) | 04 §5 | S / M |
| **C8** | Settings — Kavita pane (defaults, root fallback) | 04 §5 | S / S |
| **C9** | Onboarding wizard — renders **instead of the router**, unreachable by URL; boot-parity tests (fresh dir → wizard; completed dir → routes; no route access during onboarding) | 04 §2; 08-GUI §6 | S / M |
| **C10** | Cross-cutting: keyboard bindings verbatim (04 §4 — the two unguarded viewers stay unguarded unless D-input-guard is accepted); non-UI surfaces (04 §7: filename rules, folder layout, CLI subcommands, `DOUJIN_TEMPLATE_DIR` seeding, log files, mass-delete guard); deviation closure — land the proposed §9 rows **with user sign-off** and resolve D-localstorage-keys / D-sidebar-collapsed either way | 04 §4, §7, §9 | M / L |

Phase C exit: 09 §Phase C — checklist fully signed, every P2 row reviewed in
ledger §9, baselines re-measured on the 2.x build (idle RSS ≤150 MB, cold start
≤1.0 s, 0 steady-state IPC, 1 thumbnail fetch/item/session).

---

## Phase D — ship (gates: `import_matrix`, updater e2e, full gate set on the packaged build)

| WP | Title | Inputs | Deliverable | Depends on | Size | Acceptance |
|---|---|---|---|---|---|---|
| **D1** | Packaging + updater | 11 (whole), 09 §Phase D(1), 08-GUI §2.3 | Tauri bundler targets mirroring 1.x (AppImage, .deb, .rpm, NSIS), `beforeBuildCommand` = the same Vite build, updater against the same GitHub feed with `autoDownload=false` and cached-status-`null`-before-first-event, `app:checkToolchain` reporting **zero** external tools (D3), signing keys generated at entry with recovery note (R17) | C-exit | M | Packaged artefacts within 05 §1 budgets (≤80 MB unpacked vs 1.x's 362 MB); updater e2e green against a staged feed; `CHECKLISTS/release.md` items signed |
| **D2** | 1.x→2.x import | 09 §Phase D(2), 03 §7.3, §10.1, §10.5 | Copy-forward of `db.sqlite` (+WAL) with sentinels verbatim; mixed timestamp units tolerated, **no row rewritten**; Kavita key imports via verbatim `decryptKey`; nhentai key → first-run re-entry prompt; prefs per D-localstorage-keys; library files never copied | A5, B3 | M | IM-01 `cargo test --test import_matrix` (all rows present and equal, `integrity_check ok`, idempotent re-run); **non-destructive sha256 proof** over the 1.x data dir + keychain probe before/after; mixed ms/s seeded rows read/sort correctly with no rewrite |
| **D3** | Cutover + notice generation | 09 §Phase D(3), 11 §5–§6, 13-licence-audit | 2.x released on existing channels; `upgrade.md` (import, divergence handling, key re-entry); regenerated `THIRD-PARTY-NOTICES.md` wired into the Linux build (fixing the `build:linux` skip, 00-planning-plan §1); 1.x stays frozen and installable side-by-side; retirement is a download-page change after the stabilisation window | D1, D2 | S | Full Phase A + B + C gate set re-run **on the packaged build** (09 §D exit 5); notices regenerated by CI, not by hand |

---

## Critical path and the "what blocks what" graph

**The critical spine is A2 → A3 → A11 → the Phase A gate → B1.** The template
engine feeds every writer (A3); the writers feed the 12-path matrix which is
the gate; the gate blocks everything downstream. A5 (DB) is co-critical: the
scanner, all three pumps and the Kavita hooks sit on it. A11's *first slice*
(harness template op) blocks A2, so it starts with A1.

```
A1 ─┬─► A11(core) ─► A2 ═► A3 ═════════════════════════════ CRITICAL SPINE
    │                 │      │                             \
    │                 │      └──────────┐                   ▼
    │                 │                 ▼            [PHASE A GATE]
    │                 │        (matrix cells WR-01..03)  │  phase-a-gate.sh = 0
    │                 │                                  │
    └─► A4 ───────────┼─► (A6, A8, A9 consume filenames) │
    │                 │                                  │
    └─► A5 ══┬─► A6 ──┼──────────────────────────────────┤
             ├─► A7 ─► A8 ──────────────────────────────┤
             ├─► A9 ◄─────────────┘                     ├─► B1 ═► B2 ═► B3 ═► C1..C10 ═► D1 ─► D2 ─► D3
             ├─► A10 ◄─ A7                              │        contract:bridge   ui-parity    import_matrix,
             └─► A12 ───────────────────────────────────┘        144/144          signed       updater, notices
                                                                   ▲
                                                        A11(full: all ops, fuzz, gate script)
```

Reading rules: `═` marks the critical spine; an arrow `X ─► Y` means Y may not
start before X is **done** (definition of done above); A6/A8/A9/A10 converge on
the gate together — none may slip past it. Parallelism is real: A4, A5 and the
A7-line can proceed while A2/A3 grind, but any of them failing its acceptance
still blocks the gate.

## Size rollup (agent-days, per the assumption above)

| Phase | WPs | S | M | L | Rough total |
|---|---|---|---|---|---|
| A | A1–A12 | 1 × S | 4 × M | 7 × L | ~65–90 |
| B | B1–B3 | — | 2 × M | 1 × L | ~12–20 |
| C | C1–C10 (verify path) | 4 × S | 5 × M | 1 × L | ~25–35 |
| D | D1–D3 | 1 × S | 2 × M | — | ~7–12 |

The C column prices the **Tauri-primary re-verification path**; the egui
fallback roughly doubles it (full ledger rebuild, 08-GUI §8) — the reason R4's
S2 outcome is priced as a plan-level risk, and why the core stays
toolkit-independent by construction. The totals exclude escalation waits (15 §5)
and the Phase A entry prerequisites (fixture capture is inside A11).

## Risk-to-WP map (from 12-risk-register.md §2)

Every register risk has a standing detector inside at least one WP; reviewed at
every phase gate (12 §4).

| Risk | Owning WP(s) | Standing detector |
|---|---|---|
| R1 metadata parity | A2, A3, A11 (re-run every phase) | `differential_matrix` cells; gate re-runs |
| R2 mass-delete guard | A6 | SC-02 zero-deletion asserts |
| R3 mixed timestamp units | A5, D2 | Timestamp-newtype boundary tests; IM-01 sort-order rows |
| R4 S2 / toolkit flip | B1 | S2 decision-conditions checklist (06 §7) |
| R5 safeStorage key | D2 | import-matrix "absent nhentai key" row; re-entry prompt demo |
| R6 rasterise gap | A9, D1 | CV-01 lossless path; ≤80 MB budget check |
| R7 metadata-queue deviation | A9 | ledger row + CR-01 kill/resume |
| R8 engine drift | A2 | TA-01/TA-02 error-string asserts; soak counters |
| R9 Windows OsStr hazards | A4, A1 (CI) | FN-01 on the Windows runner |
| R10 Kavita version drift | A12 | Q1 pinned before KV-01 normative; endpoint table diff |
| R11 freeze violations | all | PR scope check (`src/main/` untouched) |
| R12 corpus drift | A1, A11 | citation walker; checklist regenerator |
| R13 tag over-match | A5 | DB-02 includes the `maid`/`maids` case at 1.x semantics |
| R14 runner availability | D1 | `CHECKLISTS/release.md` runner runbook |
| R15 corpus fragility | A1, A11 | provenance manifests; repo copies committed |
| R16 live-system blast radius | A12, all | KV-02 id-5 pre/post counts; §8 rule 2 guards |
| R17 updater keys | D1 | test-signed artefact verified (release checklist item d) |
| R18 WebKitGTK floor | B1, D1 | support-matrix item at packaging; beta-channel feed |

## Fix-pressure rule

Any failing cell lands its fix in `kopibon-core` — never by redefining parity,
weakening an assertion, or editing 1.x (D8; 09 standing rules; R1/R11). A
behaviour change discovered by a failing test goes through ledger §9
(04-parity-ledger) or it is a defect.
