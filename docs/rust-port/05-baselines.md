# 05 — Baselines and targets

Measured 1.x baselines and the numeric targets 2.x is held to. Measured on the
development machine (Fedora 44, Wayland, rustc/cargo 1.97) against the 1.0.1
artifacts in `dist/` unless noted. Methods are stated so the numbers can be
re-taken; targets are set against the measured value with the mechanism change
that justifies them.

## 1. Footprint

| Metric | 1.x measured | Method | 2.x target |
|---|---|---|---|
| Unpacked install (linux-unpacked) | **362 MB** | `du -sm dist/linux-unpacked` | ≤ **80 MB** |
| `.deb` artifact | **100 MB** (103,978,372 B) | artifact size, 1.0.1 | ≤ **60 MB** |
| `.rpm` artifact | **85 MB** (88,547,297 B) | artifact size, 1.0.1 | ≤ **55 MB** |
| `node_modules` during dev | 870 MB, 501 packages | `du`/count | n/a (Cargo.lock pinning) |
| Runtime external packages | `poppler-utils`, `python3-pikepdf` (rpm/deb `depends:`) | electron-builder.yml:136-144 | **zero** (D3) |
| Peak RSS, main process at startup | **≈260 MB** falling to ≈259 MB, 12.1%→5.1% CPU over 15 s | single run of packaged 1.0.1, isolated temp data dir, Wayland session; app reached the update check then aborted at GPU init (no UI shown) | idle ≤ **150 MB** total (all processes) |

The 362 MB unpacked figure decomposes into the Electron/Chromium runtime
(~200 MB), sharp's libvips prebuilds, pdfjs, and the 43 MB saved locale
exclusion already applied (electron-builder.yml:8-9). A Tauri-class webview
runtime or a native toolkit removes the single largest block.

## 2. Idle cost (the polling baseline)

The 1.x idle-CPU story is the nine 2000 ms polls (discovery-03 §A7), of which
the per-card thumbnail poll dominates:

- `LibraryCard` polls **its own thumbnail** every 2 s and never stops
  (src/renderer/src/components/library/LibraryCard.tsx:72-85).
- A 60-card viewport therefore issues **30 IPC calls/s indefinitely**, each
  returning a base64 data URL of a 600×800 JPEG (scanner scheme,
  library.ipc.ts:200-208) — order 50–150 KB per response, i.e. tens of MB of
  IPC serialization churn per minute at idle.
- The 100 % library of the reference machine (5261 items, `DoujinsTest`-style
  grids scrolled) holds the poll at the same rate for every mounted card.

| Metric | 1.x | 2.x target |
|---|---|---|
| Steady-state IPC calls/s with library grid open, nothing happening | ~30 (60 cards) | **0** (event push; `04-parity-ledger` §6) |
| Timers running at idle | ≥ 9 (2 s) + 1 (1 s) | bounded by visible-job count only |
| Per-card thumbnail fetches | unbounded repeats | exactly **1** per item per session until the file changes |

## 3. Correctness baseline (the suite the port must match)

| Metric | 1.x measured | 2.x target |
|---|---|---|
| Unit test suite | **429 tests / 19 files, ~0.7 s** (`npm test`, vitest, node env, pure units only — discovery-02 §8) | ≥ 429 equivalent cases ported + the metadata differential suite (10-test-plan) |
| Covered layers | pure units only; no Electron, SQLite, or worker coverage | Phase A differential tests cover the write paths; DB layer gets an integration suite |
| Metadata artefacts | 3 golden fixtures byte-inspected (07-metadata-spec §fixtures) | 100 % of field × mutation matrix green at stated parity levels |

## 4. Pipeline baselines (harness-gated)

These need a populated data dir and a running UI; the harness records them
before Phase C (see `CHECKLISTS/baselines.md` for the capture procedure).

| Metric | 1.x method | 2.x target |
|---|---|---|
| Startup to interactive | not capturable headless (GPU init aborts under Wayland; do **not** run the user's instance — use the harness script on a scratch profile) | ≤ **1.0 s** cold, ≤ 0.3 s warm |
| Library scan throughput | scanner worker, mtime+size incremental skip | ≥ 1.x items/s on the same corpus |
| 10k-thumbnail grid frame time | S2 spike (not yet run — gates `06-technology-decision.md`) | ≤ 16 ms scroll, RSS ≤ 400 MB with 10k loaded rows |
| PDF→CBZ conversion throughput | conversion queue pool min(downloadConcurrency, 8) | ≥ 1.x on the 3-file golden corpus; no silent failures (sharp/pikepdf silence is ported as loud errors) |
| Render memory, 200-page CBZ viewer | CbzViewer window ±3 pages (CbzViewer.tsx:74-99) | ≤ 300 MB; PdfViewer's eager all-page render (PdfViewer.tsx:90-109) is **not** the baseline — it is the defect |

## 5. Non-negotiable (correctness over numbers)

Where a target and parity conflict, parity wins. The port does not trade
ComicInfo/XMP/ZIP byte parity, the mass-delete guard, or the 255-byte filename
rule for any performance number in this document.
