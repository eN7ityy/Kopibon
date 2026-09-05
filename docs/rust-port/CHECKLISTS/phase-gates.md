# CHECKLISTS — Phase gates

Per [../09-migration-phases.md](../09-migration-phases.md). A phase starts only when the previous gate returns 0.
**Gate chain:** A — `scripts/port/phase-a-gate.sh` exit 0 — blocks B–D; B — `npm run contract:bridge` 144/144 — blocks C–D;
C — [CHECKLISTS/ui-parity.md](ui-parity.md) fully signed — blocks D; D's gates block cutover.

Standing rules, every phase: D8 (1.x feature-frozen; never edit `src/main/`); corpus rule (`git diff --stat dev -- . ':!docs/rust-port'` empty during planning); parity over numbers ([../05-baselines.md](../05-baselines.md) §5); Phase A matrix + Phase B contract suite re-run in CI at every later phase.

## Phase A — `kopibon-core` library + headless CLI

**Entry**
- [ ] Spikes recorded in [../07-metadata-spec.md](../07-metadata-spec.md) §10: S1 PASS (XMP byte parity), S3 PASS (STORE-only ZIP), S4 PASS (DCTDecode extraction), S6 PASS (prod DB opens from `rusqlite`)
- [ ] Three golden fixtures copied read-only into repo test area with sha256 provenance (network-mount risk)
- [ ] Byte copy of the production DB (5261 items) available — never the live one

**Exit — gate `bash scripts/port/phase-a-gate.sh` (exit 0 iff all):**
- [ ] 1. Field × mutation matrix green (12 write paths × 4 artefacts, required level per artefact, equal error strings, CBZ CRC-validated)
- [ ] 2. Fuzz: 26/26 seeds + ≥10k generated/run; nightly 1M soak clean ×3 before first gate declaration
- [ ] 3. Scanner parity: row-for-row vs live 1.x scan; removal triple guard, zero deletions
- [ ] 4. DB parity: `sqlite_master` unchanged; read parity matrix; atomic claims under concurrency
- [ ] 5. Pumps: download/conversion/sync differentials green, incl. crash recovery ([../10-test-plan.md](../10-test-plan.md) §6)

Demo: headless CLI end-to-end against fixture server, no GUI. Rollback: nothing ships; 1.x untouched.

## Phase B — existing UI on the Rust core (Tauri re-host)

**Entry**
- [ ] Phase A gate exit 0
- [ ] Host decision recorded (sidecar/FFI rejected; re-host per [../06-technology-decision.md](../06-technology-decision.md) §7; egui ladder if S2 fails)
- [ ] Scratch data dir + golden-corpus library staging ready (production DB only via byte copy)

**Exit — machine-checkable ([../08-subsystem-plans/08-gui-app-shell.md](../08-subsystem-plans/08-gui-app-shell.md) §7):**
- [ ] 1. `npm run contract:bridge` — 144/144 (envelope shapes per variant + 14 event payloads + unlisten)
- [ ] 2. `cargo test --test freshness` — steady-state IPC = 0 with grid open; covers ≤ 2 s after `library:newItems`
- [ ] 3. Scripted full real-data session (search→download→scan→convert→sync→settings→viewer) equals 1.x, events the only freshness mechanism
- [ ] 4. Log parity: fresh Crockford-base32 errorId per thrown command, distinct on repeat, ≥250 ms slow-handler warning

Demo: side-by-side recording vs 1.x + idle CPU at 05 §2 target. Rollback: 1.x still ships; shim/command layer only is at risk.

## Phase C — UI verified screen-by-screen against the ledger

**Entry**
- [ ] Phase B gate green (contract suite 144/144)
- [ ] Ledger [../04-parity-ledger.md](../04-parity-ledger.md) §9 deviation dispositions agreed with user (proposed rows landed only with sign-off; D-localstorage-keys / D-sidebar-collapsed resolved either way)

**Exit — machine-checkable:**
- [ ] 1. [CHECKLISTS/ui-parity.md](ui-parity.md): every row signed at its level, zero unchecked; every P2 row has a reviewed ledger entry
- [ ] 2. `npm run contract:bridge` green **and** `bash scripts/port/phase-a-gate.sh` still exit 0
- [ ] 3. Baselines re-measured on the 2.x build: idle RSS ≤ 150 MB, cold start ≤ 1.0 s, 0 steady-state IPC, 1 thumbnail fetch per item per session
- [ ] 4. Boot-parity tests: fresh dir → wizard instead of router; completed dir → routes; no route access during onboarding

Demo: 2.x driven through the full parity checklist live, 1.x beside it. Rollback: failing surface keeps 2.x in Phase B state.

## Phase D — packaging, updater, import, cutover

**Entry**
- [ ] Phase A + B + C gates all green
- [ ] Updater signing keys + secrets in place ([CHECKLISTS/release.md](release.md))

**Exit — machine-checkable:**
- [ ] 1. `cargo test --test import_matrix` green: scripted 1.x profile → every row present and equal; `integrity_check ok`; re-run idempotent
- [ ] 2. Non-destructive proof: sha256 over the 1.x data dir + keychain probe unchanged before/after import — asserted, not assumed
- [ ] 3. Mixed-units test: DB seeded with both ms and s rows reads/sorts/displays correctly, no row rewritten
- [ ] 4. Packaged artifacts within 05 §1 budgets; updater end-to-end green on a staged feed (explicit user action before download)
- [ ] 5. Full Phase A + B + C gate set re-run on the **packaged** build
- [ ] 6. `upgrade.md` written (import, divergence handling, key re-entry); 1.x coexistence holds — no electron-updater manifests emitted

Demo: clean machine — 1.x installed/populated, 2.x beside it, import run, both apps used alternately; 1.x profile byte-identical at the end. Rollback: delete 2.x data dir + uninstall — by construction 1.x never touched (D4).
