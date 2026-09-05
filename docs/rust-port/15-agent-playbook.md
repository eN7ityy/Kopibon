# 15 — Agent playbook (how to run the port)

Operational instructions for the implementing agent executing the work packages
of [14-task-breakdown.md](14-task-breakdown.md). The corpus is the authority;
this document tells you how to move through it without violating it.

---

## 1. Ground rules

**1.1 Read the contract before the code.** Before touching any module, read
[07-metadata-spec.md](07-metadata-spec.md) (the metadata contract) and
[03-data-model.md](03-data-model.md) (the DB contract) end to end, plus the
subsystem plan for the WP you are executing (08-subsystem-plans/01–08). The
subsystem plans deliberately cite the specs instead of restating them — you
need both open.

**1.2 Never "improve" a preserved quirk.** These are load-bearing 1.x
behaviour, recorded with citations; "fixing" any of them breaks differential
parity and is a defect, not a decision:

| Quirk | Why it must survive | Cite |
|---|---|---|
| `galleryId` 0 asymmetry: absent from template context (`\|\| ''`) but present in `/Keywords` (`!= null`) → `nhentai:0` is emitted | Byte parity of the keyword line | `src/main/services/metadata/mappers.ts:136-138` vs `:272`; 07-metadata-spec §4 |
| **Three distinct sanitisers** (download `_`-substitute/180/suffix; custom-entry delete/120/prefix; directory-segment/leading-dot/`'Unknown'`) | Filename parity; they are never unified | 07-metadata-spec §7; 08/01 §7 |
| Mixed timestamp units (ms from `Date.now()` paths beside `unixepoch()` seconds) | Old rows are never rewritten; new writes are seconds; reads tolerate both via the `Timestamp` newtype | 03-data-model §10.5; 05-DB plan §7 |
| Tag substring over-match (`maid` matches `maids`) | USER DECISION, 05-DB §6: preserve verbatim in Phase A; post-cutover flag-gated only | 05-database-layer plan §6; R13 |
| Template-engine corners (error strings with 1-based line numbers, inline sections without `each`, the whole-line drop rule) | Error strings are differential assertions; users' edited templates hit corners the shipped ones don't | 07-metadata-spec §2; 08/01 §4, §10 |
| Legacy `Notes` strings read, never rewritten unprompted (D7) | Scanner tolerance contract | 07-metadata-spec §8 |

**1.3 Deviations need a ledger row.** Any deliberate divergence from 1.x
behaviour — including the two sanctioned loud-failure fixes (sharp thumbnails,
pikepdf empty-metadata) and the Q6 `metadata_queue` — gets a row in
[04-parity-ledger.md](04-parity-ledger.md) §9 **before or with** the code that
implements it, and proposed rows go back to the user first (§5 below). A
deviation without a row is a defect (04 §9 rules).

**1.4 Commit discipline.** Conventional commits (`feat(db): …`,
`fix(metadata): …`, `test(scanner): …`, `docs(rust-port): …`). One WP per PR
branch — branch name `wp-a5-database` etc., cut from the port tree. **Tests
before refactor:** a refactor PR may not touch behaviour; if a diff shows up,
stop and treat it as a parity regression (R1). The implementation tree is
`kopibon-core/` + `src-tauri/`; **never edit `src/main/`** (D8 feature freeze;
the only sanctioned JS-side code is the dev-tree harness and capture scripts
under `tests/differential/` and `scripts/port/`, which are never shipped — 09
corpus rule, 10 §3).

## 2. Environment setup

**2.1 Toolchain.** `rustup` resolves everything through `rust-toolchain.toml`
at the repo root — channel **1.97** plus clippy/rustfmt, the single version
authority (11-ci-release-plan §2.1). Do not install a different toolchain
"just to get moving"; version bumps are ordinary reviewed PRs.

**2.2 Layout.** One cargo workspace; `kopibon-core` is the library + a headless
CLI binary that exposes the harness ops; module subtrees per 08/01 §1 and
08/05 §1. Tests live in `kopibon-core/tests/` with the IDs of 10-test-plan §7
(`template_differential`, `differential_matrix`, `scanner_differential`,
`db_differential`, …). Dev-tree JS never ships.

**2.3 The differential harness.** JS side `tests/differential/harness.mjs`
imports the **real built 1.x modules from `dist/`** and runs one op per
invocation (10 §3, 08/01 §8):

```sh
node tests/differential/harness.mjs buildComicInfoXml context.json
cargo test -p kopibon-core --test differential_matrix   # the runner spawns both sides
bash scripts/port/phase-a-gate.sh                       # the Phase A gate (09)
```

The runner compares bytes at each artefact's required level and compares
**error strings** where JS throws. Sibling harness: `db_harness.mjs`
(better-sqlite3 vs rusqlite on the production-DB **byte copy**).

**2.4 Capturing fixtures from 1.x without running the user's personal
instance.** Two safe mechanisms, in order of preference:

1. **Headless builders via node only.** Most capture targets are pure
   functions of a context + templates (`buildComicInfoXml`, `buildXmpXml`,
   `buildDocInfo`, `generateCbz`, …). Run them directly from `dist/` with node
   — no Electron launch, no app data touched. Provenance manifest per artefact:
   sha256, 1.x version, template set, injected volatile values (10 §1.2).
2. **Scratch-profile runs.** For paths that need the app shell (queue flows,
   downloads), launch 1.x with a scratch data dir via the `KOPIBON_DATA_DIR`
   override (`src/main/index.ts:101`) and point the library at the **disposable
   clone** (Q5), never the real mount, never the production DB, never library
   id 5. `npm test` (the 1.x baseline suite) runs as-is — it is also the
   Windows-only filename-failure detector (R9, `test.yml:123-127`).

Fixtures and the three golden files are committed read-only with sha256
provenance before Phase A starts (09 entry; R15).

## 3. Kavita test environment rules

Binding facts from 10-test-plan §4 and 08/07 §6:

- **Server:** `http://kavita.bragi.internal` (port 80, unversioned `/api/...` —
  the proxy injects the version segment; **never `:8080`**). Auth header
  `x-api-key` with the plugin key from
  `plans/kopibon_rust_port/kavita_server.txt`. Do not paste the key into new
  files; read it from there.
- **Test library: `Doujin-Test`, id 6** → `/mnt/bragi/Kavita/DoujinsTest`.
  All mutation tests run inside id 6 only.
- **Production library: `Doujins`, id 5 (5287 files) — untouchable.** Never
  scanned, mutated or deleted. Every mutating helper takes a library id and
  **refuses id 5**; the harness asserts id 5's counts
  (`/api/Stats/server/stats` → `chapterCount`, per-library series via
  `/api/Library/libraries`) **before and after every test** — one changed
  count fails the whole run (KV-02; R16).
- Server version is unknown (Q1): read it off the UI once and pin it in
  16-open-questions and 08/07 §6 before the acceptance suite is declared
  normative (R10).

## 4. Verification commands the corpus expects

| Command | Proves | Source |
|---|---|---|
| `cargo test --workspace` | every test ID of 10 §7 that is not `--ignored` | 10 §7 |
| `cargo test --test differential_matrix` | the field × mutation matrix — the Phase A gate core | 09 Phase A exit 1 |
| `bash scripts/port/phase-a-gate.sh` | all five Phase A exits; **re-runs at every later phase** | 09 standing rules |
| `npm test` (1.x tree) | the 1.x baseline still green; Windows-only filename failures surface | R9, `test.yml:123-127` |
| `npm run contract:bridge` | 144/144 channels (Phase B/C gate) | 09 Phase B exit 1 |
| `cargo test --test freshness` | steady-state IPC = 0 (Phase B) | 09 Phase B exit 2 |
| `cargo test --test import_matrix` | non-destructive import (Phase D) | 09 Phase D exit 1–3 |
| `python3 tests/zip/validate.py <out.cbz>` | CRC validation of every emitted CBZ | 08/01 §8; WR-03 |
| citation walker (corpus checker) | every `file:line` cite in the docs resolves — file exists, line count holds | 00-planning-plan §8 |
| `git diff --stat dev -- . ':!docs/rust-port'` (planning) / scope check per PR | nothing outside the port tree touched | 09 corpus rule |

Also keep `CHECKLISTS/tests.md` regenerable from 10 §7 (10 §8 rule 4) — the
checker asserts ID/level/fixture/command for every row. A WP without its
checklist rows is not done (14, definition of done).

## 5. Escalation policy — stop work and ask the user

Hard stops; do not pick a default and move on:

1. **S4 / rasteriser fallback choice.** If a non-DCTDecode page cannot convert
   losslessly without poppler (D3), the pdfium-render vs mupdf vs Q2-options
   decision is the user's — never a silent quality cut (R6; 06 §8).
2. **Toolkit flip.** Any S2 bar failure that triggers the egui ladder (06 §7),
   and any target renegotiation if all candidates fail the perf bars.
3. **Any parity trade-off.** Every proposed ledger §9 row (including
   D-onboarding-reopen, D-input-guard, D-error-boundary at Phase C, and
   resolving D-localstorage-keys / D-sidebar-collapsed) needs user sign-off;
   any relaxed differential assertion is an escalation, not a fix (04 §9; 10 §8
   rule 5).
4. **Anything touching the production material.** Library id 5, the live
   production DB, or the real `/mnt/bragi/Kavita/DoujinsTest/` mount as a
   write target: hard stop, full stop (10 §8 rule 2; R16).
5. **Golden-corpus breadth (Q5)** — what the CURRENT-BUILD captures and the
   disposable clone may draw from — before capture scripts run wide.
6. **Do not re-ask what is already decided:** tag over-match stays verbatim in
   Phase A (05-DB §6 USER DECISION); Info-dict semantic parity per D6; zero
   external tools per D3; macOS stays out (Q10).

## 6. Worked example — "port the template engine" (WP-A2 slice, per 08-subsystem-plans/01)

1. **Read first:** 07-metadata-spec §2 (the formal spec — grammar, emptiness
   rule, section/each semantics, newline handling), 08/01 §1–§4 (module
   boundaries, crates, port notes), then the source
   `src/main/services/metadata/template-engine.ts` (162 lines) and its test
   file (the 26 seed cases).
2. **Port** into `kopibon-core/src/metadata/template.rs`: the four regexes
   verbatim (`template-engine.ts:36-46`); the emptiness rule (`0`/`'0'`
   present, `true` → `"true"`, `[]` empty); the any-optional-empty whole-line
   drop; block sections anchored alone-on-line vs the inline `SECTION` form
   with **no `each` support** (hand-rolled backreference scan, not
   fancy-regex — 08/01 §2); `findClose` with the **verbatim** error strings and
   1-based line numbers; CRLF→LF then one trailing `\n` stripped. No escaping
   in the engine — that lives in `xml_utils::escape` in the mapper.
3. **Number semantics:** build `js_number.rs` for `Number::toString` /
   `toFixed(2)` per ECMAScript (Rust's `format!` rounds half-to-even — they
   differ); test against JS-generated vectors incl. `1e21`, `2.675`, `1.005`
   (08/01 §4, §10).
4. **Expose the op** in the headless CLI and add it to
   `tests/differential/harness.mjs`; run
   `cargo test --test template_differential` (TA-01): 26/26 seeds byte-exact
   **including error strings**.
5. **Fuzz (TA-02):** seed = the 26 cases; generator over random nesting, `?`
   markers, context shapes (`0`, `'0'`, `true`, `[]`, comma/newline arrays),
   CRLF/trailing-newline variants; ≥10k cases per CI run, every mismatch
   shrunk to a fixed vector; the nightly 1M soak must be clean **three
   consecutive runs** before the gate is first declared (09 exit 2).
6. **Mappers next** in the same WP: `mappers.rs` rule-for-rule per 07 §4 (the
   table of truth, incl. the `galleryId` 0 asymmetry of §1.2) and MA-01: the
   58 mapper cases of `mappers.test.ts` against the real template files
   (10 §3).
7. **Close out:** CI grep asserts no `SystemTime::now()` under `metadata/`
   outside `Clock` impls (08/01 §9 exit 5); add TA-01/TA-02/MA-01 rows to
   `CHECKLISTS/tests.md`; PR branch `wp-a2-template-engine`, conventional
   commits, phase-a-gate.sh still failing only on not-yet-built WPs. Only now
   is the WP-A2 slice "done" per 14's definition of done.
