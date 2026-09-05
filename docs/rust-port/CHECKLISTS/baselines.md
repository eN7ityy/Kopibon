# CHECKLISTS — Baseline capture procedure

Implements [../05-baselines.md](../05-baselines.md) §4 (harness-gated pipeline baselines). Capture runs
**before Phase C** on 1.x and is **re-measured on the 2.x build** at Phase C exit ([../09-migration-phases.md](../09-migration-phases.md) Phase C exit 3).

## Hard rule — isolation (non-negotiable)

- [ ] **Never run against the user's personal instance, the production library (Kavita id 5), the live production DB, or the real `/mnt/bragi/Kavita/DoujinsTest/` mount as a write target** ([../15-agent-playbook.md](../15-agent-playbook.md) §4.4, §2.4; [../10-test-plan.md](../10-test-plan.md) §8 rule 2 — hard stop, full stop)
- [ ] Scratch profiles only: launch with the `KOPIBON_DATA_DIR` override (`src/main/index.ts:101`) pointing at an isolated temp data dir
- [ ] Library target is the **disposable clone** (Q5) or a synthesised tree — never the real mount
- [ ] Where a 1.x baseline itself says "not capturable headless" (startup), capture via the harness script on the scratch profile — 05 §4 row 1

## Pre-flight

- [ ] Capture script(s) live in `scripts/port/` (dev-tree only, never shipped — 09 corpus rule); each run prints method, environment and raw numbers
- [ ] Scratch data dir freshly created per run; wiped after results are recorded; no run reuses a profile that touched anything real

## Environment (record with every run — 05 preamble)

- [ ] Fedora 44, Wayland session, rustc/cargo per `rust-toolchain.toml` (1.97, pinned at Phase A start)
- [ ] 1.x side: the 1.0.1 artifacts in `dist/`; 2.x side: the equivalent packaged build
- [ ] Data dir = isolated scratch profile per run; note machine, CPU, and any background load in the results file

## Capture steps (per metric — method mirrors the 1.x column, 05 §4)

- [ ] **Startup to interactive** — launch packaged build on scratch profile; time to interactive UI (1.x GPU-init abort under Wayland is why the harness script, not a headless measurement, is used). Target 2.x: ≤ 1.0 s cold, ≤ 0.3 s warm
- [ ] **Library scan throughput** — run the scanner worker over the clone corpus with mtime+size incremental skip; record items/s. Target 2.x: ≥ 1.x items/s on the same corpus
- [ ] **10k-thumbnail grid frame time** — S2 spike (gates [../06-technology-decision.md](../06-technology-decision.md)); scroll a 10k-row grid, record frame time + RSS. Target: ≤ 16 ms scroll, RSS ≤ 400 MB with 10k loaded rows
- [ ] **Conversion throughput** — PDF→CBZ over the 3-file golden corpus via the conversion queue pool (pool = min(downloadConcurrency, 8)); record throughput + zero silent failures. Target: ≥ 1.x; silence ported as loud errors
- [ ] **Viewer memory** — open a 200-page CBZ in the viewer (CbzViewer window ±3 pages); record RSS. Target 2.x: ≤ 300 MB. PdfViewer's eager all-page render is **not** the baseline — it is the defect (05 §4)

## Recording and gate use

- [ ] Results recorded (method + raw numbers + environment) alongside 05 §4's table before Phase C starts; re-measured on the 2.x build for Phase C exit: idle RSS ≤ 150 MB, cold start ≤ 1.0 s, 0 steady-state IPC, 1 thumbnail fetch per item per session
- [ ] Idle-cost context captured if needed for comparison (05 §2): ~30 IPC calls/s at idle for 60 cards, ≥ 10 timers — the thing D-poll-to-push removes
- [ ] Parity over numbers ([../05-baselines.md](../05-baselines.md) §5): no perf result buys an exception from the metadata contract, the mass-delete guard, or the 255-byte filename rule
