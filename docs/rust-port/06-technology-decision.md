# 06 — Technology decision (GUI toolkit and runtime shape)

The scored tool decision required by D1: Tauri v2, egui, Iced, Slint, Dioxus and
GTK4/relm4 are all scored against criteria derived from this corpus, with no
pre-selection. The decision is **conditional**: the final selection is gated on
spike S2 (§6), which has not yet run. Everything else in this document is
settled by evidence already measured (§2).

Companion documents: [04-parity-ledger.md](04-parity-ledger.md) (UI surface to
reproduce), [05-baselines.md](05-baselines.md) (performance gates),
[01-current-architecture.md](01-current-architecture.md) (process/worker model),
[03-data-model.md](03-data-model.md) (SQLite access patterns),
[07-metadata-spec.md](07-metadata-spec.md) (the contract any toolkit must not
touch), [16-open-questions.md](16-open-questions.md) (Q3 closes with this doc).

---

## 1. What the toolkit decision does and does not decide

The Rust **core** (metadata engine, scanner, download manager, DB layer, nhentai
client, Kavita client) is toolkit-independent by construction: Phase A of the
migration ([09-migration-phases.md](09-migration-phases.md)) builds it as the
`kopibon-core` library with no UI dependency, and the Wave-2 spikes already ran
it headless. This document therefore decides only:

1. the presentation layer (what replaces React 19 + Tailwind 4 + react-virtuoso),
2. the process/event-loop shape the core runs inside (tokio runtime, window
   thread, worker tasks),
3. the packaging/updater story that follows from (1).

The metadata write paths, the filename rules, the queue state machines and the
mass-delete guard are unaffected by every candidate. **Criterion 5 below scores
5 for all candidates on purpose** — it is listed so the record shows it was
checked, not because it discriminates. The spikes that make it a non-question:

- **S1 — XMP byte parity: PASS.** Rust template-engine render plus the two lxml
  normalisations ([07-metadata-spec.md](07-metadata-spec.md) §10.1) is
  byte-identical to the golden packet (1782 B); `lopdf` writes it uncompressed
  and it round-trips exactly; Info dict set; page count preserved. Caveat
  recorded there: lopdf inlines the metadata dict into the catalog (pikepdf used
  an indirect object) — both parse fine.
- **S3 — ZIP parity: PASS.** Hand-rolled STORE-only writer (~180 lines) matches
  every structural field of the golden CBZ (vmb 6.3/Unix, flags 0x0800/0x0808,
  data descriptors, UT extra central-only 9 B, extattr 0x81B40000/0x81A40000).
  The `zip` crate is not used for writes. Nothing here touches the GUI.
- **S4 — lossless PDF extraction: PASS.** lopdf DCTDecode streams byte-identical
  to `pdfimages -all` (16/16). Remaining gap: the `pdftoppm` rasterise fallback
  needs a Rust renderer — **RESOLVED with pdfium-render 0.9.3 (USER DECISION,
  option A; 18-future-work F1 closed).** Fidelity spike (3-page vector PDF):
  3=3 pages, identical 1275×1650 @150 DPI, mean-abs-diff ≈0.18/255; non-V8
  libpdfium.so 7.7 MB unpacked (BSD-3-Clause). Wired as Attempt 2
  (`method: "pdfium"`) plus PDF thumbnails — independent of the toolkit choice
  (it feeds the PDF→CBZ conversion plan, not the UI plan).
- **S5 — safeStorage:** the stored nhentai key is a Chromium `os_crypt` "v11"
  blob, not decryptable from Rust without the OS keyring; recommendation is
  re-enter on import, softened by D4 (side-by-side install). Toolkit-neutral.
- **S6 — rusqlite on the production DB: PASS.** Opens the WAL production copy,
  integrity ok, all 14 tables present, the `COLLATE NOCASE` indexes present, and
  the `UPDATE … RETURNING` claim pattern verified. Mixed timestamp units (ms and
  s) confirmed live. Toolkit-neutral; feeds [03-data-model.md](03-data-model.md)
  §10 directly.

**One live gate remains: S2** (§6). The tool selection is not final until it
passes or fails.

---

## 2. Hard constraints any candidate must satisfy

Derived from the corpus, restated so the scoring below is traceable:

| # | Constraint | Source |
|---|---|---|
| C1 | Reproduce 6 routes under one shell, ~15-item component vocabulary (5-tone `Notice`, `EmptyState`, `LoadingSkeleton` ×3, `ErrorState`, `ProgressBar`/`ProgressStack`, `StatusBadge`, `Button` ×4 roles, `GalleryTile`, `Pagination`, `PathField`, `FormatSelector`, `AutocompleteInput`), and **every keyboard binding verbatim** — including the two unguarded document-level viewers | [04-parity-ledger.md](04-parity-ledger.md) §2–4 |
| C2 | Settings panes with exact defaults; persistence via SQLite; the two `doujin-*` localStorage stores | [04-parity-ledger.md](04-parity-ledger.md) §5 |
| C3 | Idle ≤ 150 MB RSS total; **0 steady-state IPC** with the library grid open; 10k-thumbnail virtualised grid ≤ 16 ms scroll frame, ≤ 400 MB RSS; startup ≤ 1.0 s cold | [05-baselines.md](05-baselines.md) §1, §2, §4 |
| C4 | Japanese titles are primary content: rendering, wrapping and IME in search/tag inputs must be correct (D5 desktop-only, touch-friendly, DPI-aware) | D5; planning plan §4b |
| C5 | Unpacked install ≤ 80 MB; auto-update story on Linux (1.x uses electron-updater over GitHub releases, AppImage/NSIS targets) | [05-baselines.md](05-baselines.md) §1; electron-builder.yml |
| C6 | Zero external tools (D3) — the toolkit adds no Python/poppler-style runtime dep | D3 |
| C7 | GPL-3.0-or-later application; dependency licences audited in `13-licence-audit.md` · C8: 7 worker kinds become in-process tokio tasks/threads; serial sync and singleton scan preserved; atomic `UPDATE…RETURNING` claims for conversion/sync queues ([01-current-architecture.md](01-current-architecture.md) §1.2; [03-data-model.md](03-data-model.md) §6, §10) | D1 context |

---

## 3. Criteria and weights

Scores are 1–5. Weights sum to 100 and encode the corpus's own priorities:
the parity ledger is a *fixed* target ([04-parity-ledger.md](04-parity-ledger.md)
§9: an unlisted deviation is a defect), so UI parity cost dominates. Performance
is second: the targets in [05-baselines.md](05-baselines.md) are the public
reason the port exists at all. Japanese text is weighted above packaging because
it is a *correctness* surface for this library's content, not a nicety.

| # | Criterion | Weight | Why this weight |
|---|---|---|---|
| 1 | UI parity cost (C1, C2) | **25** | Phase C is screen-by-screen against a frozen ledger; a toolkit that forces re-derivation of the component vocabulary and keybindings multiplies the largest UI risk. The existing React renderer is an asset only one candidate can spend. |
| 2 | Performance gates (C3) | **20** | Measured targets with numeric bars; the port's headline claims (RSS, install size, 0 idle IPC) live here. Partly gated on S2. |
| 3 | Japanese text + touch/DPI (C4) | **15** | Content is Japanese-heavy; text shaping is a place native toolkits historically differ most, and it is expensive to discover late. |
| 4 | Packaging/install size + auto-update (C5) | **10** | 362 MB → ≤ 80 MB is a headline goal, but it is a solved problem for most candidates; the updater story on Linux is the fiddly part. |
| 5 | Metadata-critical libs unaffected (C6) | **5** | Proven toolkit-neutral by S1/S3/S4/S6 — scored 5 for all, kept in the matrix for the record. |
| 6 | Worker/async model fit (C8) | **10** | 7 worker kinds → tokio; queue claim semantics; SQLite busy_timeout discipline. Mostly toolkit-independent, but the UI event loop must coexist with a tokio runtime cleanly. |
| 7 | Licence (C7) | **5** | App is already GPL-3.0-or-later, so even copyleft toolkit options are *usable*; weight is low but recorded for `13-licence-audit.md`. |
| 8 | Maturity/maintenance risk 2026 | **10** | D8 freezes 1.x features, so 2.x must live on its toolkit's roadmap for years without a rewrite-for-free escape hatch. |

---

## 4. Scoring matrix

Score rationale per cell is in §5. "gated" = the score is provisional pending S2.

| Criterion (weight) | Tauri v2 | egui | Iced | Slint | Dioxus | GTK4/relm4 |
|---|---|---|---|---|---|---|
| 1. UI parity (25) | **5** | 1 | 2 | 2 | 3 | 2 |
| 2. Performance (20) | 3 *gated* | 4 *gated* | 3 *gated* | 4 *gated* | 3 *gated* | 3 *gated* |
| 3. Japanese + touch/DPI (15) | 4 | 2 | 3 | 3 | 4 | **5** |
| 4. Packaging + update (10) | 4 | 4 | 4 | 4 | 3 | 2 |
| 5. Metadata libs (5) | 5 | 5 | 5 | 5 | 5 | 5 |
| 6. Worker/async fit (10) | 4 | 5 | 5 | 4 | 4 | 4 |
| 7. Licence (5) | 5 (MIT/Apache) | 5 (MIT/Apache) | 5 (MIT) | 4 (GPL-3.0 OR commercial; GPL option is compatible with this app) | 5 (MIT/Apache) | 5 (GTK LGPL; relm4 MIT) |
| 8. Maturity (10) | 4 | 4 | 3 | 3 | 3 | 5 |
| **Weighted total (÷500)** | **415 (83%)** | **315 (63%)** | **325 (65%)** | **330 (66%)** | **345 (69%)** | **345 (69%)** |

The gap is almost entirely criterion 1, and that is the honest reading of the
corpus: ~87 files / ~18,000 of ~39,000 lines of TS/TSX under `src/renderer/`
(the renderer never touches Node; all capability arrives through the
`window.api` bridge — [01-current-architecture.md](01-current-architecture.md)
§1.1) are directly reusable only by a web-UI host. No native toolkit can avoid
re-deriving the ledger by hand.

---

## 5. Per-candidate strengths and weaknesses

Where a statement about the wider ecosystem is from general knowledge rather
than measured here, it is marked *(unverified here)*.

### 5.1 Tauri v2 (system webview + reused React UI) — 415

**Strengths**

- **Criterion 1 (5/5).** The renderer is portable nearly wholesale: 6 routes,
  the whole component vocabulary, the verbatim keybindings, the 12 zustand
  stores, `react-virtuoso` virtualisation, Tailwind 4 design tokens and the
  `doujin-*` localStorage stores all survive. The port becomes: re-point the
  144-channel `window.api` bridge at Tauri commands/events (the envelope,
  error-shape and event semantics are already specified channel-by-channel in
  [02-ipc-surface.md](02-ipc-surface.md)), then delete Electron plumbing
  (`@electron-toolkit/*`, sandbox flags). Onboarding-as-full-screen-takeover
  (not a route) is exactly as reproducible in a webview. This collapses Phase C
  from "rebuild 6 screens" to "rewire one bridge and re-verify the ledger".
- **Criterion 3 (4/5).** WebKitGTK (Linux) and WebView2 (Windows) render and
  shape Japanese with the platform text stack; IME in `SearchBox` /
  `AutocompleteInput` inputs behaves as on any web app. Fractional-scaling
  issues on WebKitGTK exist but are edge-case *(unverified here)*.
- **Criterion 4 (4/5).** No bundled Chromium: unpacked payload is binary +
  assets (order 10–30 MB typical *(unverified here)*), and Linux packages
  depend on the system webkit2gtk like 1.x depends on poppler/pikepdf today —
  except D3 removes the poppler/pikepdf half. Tauri v2 ships an updater plugin
  (AppImage + Windows; .deb/.rpm remain package-manager territory — same as
  1.x's electron-updater AppImage/NSIS story).
- **Criterion 7 (5/5)** MIT/Apache; **criterion 8 (4/5)**: stable 2.x line,
  large ecosystem *(unverified here — cite current release state in
  `13-licence-audit.md` / `12-risk-register.md` at implementation time)*.

**Weaknesses**

- **Criterion 2 (3/5, gated).** The webview is the risk the 1.x baselines were
  written to expose: WebKitGTK compositing on Wayland, per-frame cost of a
  10k-cell virtualised grid, and idle RSS of the webview process tree against
  the ≤ 150 MB bar. None is measured yet — this is precisely S2 (§6). The
  0-steady-state-IPC target is achievable (event push per
  [04-parity-ledger.md](04-parity-ledger.md) §6), but the *one-time* thumbnail
  load per item must not go over a base64 `invoke` round-trip if it is large;
  S2 must measure a custom-protocol/asset-handler alternative.
- Criterion 6 (4/5): the UI is a second process-equivalent (webview) talking to
  the Rust core over command IPC — the same shape as today's Electron, so
  batched `newItems` semantics ([01-current-architecture.md](01-current-architecture.md)
  §3b) must be preserved across it; payload-heavy channels need the same
  batching care.
- WebKitGTK version fragmentation across user distros *(unverified here)* —
  a support-matrix item for `11-ci-release-plan.md`.

### 5.2 egui (immediate mode, GPU) — 315

**Strengths:** lightest plausible runtime (single binary, low RSS, fast
startup) — criteria 2/4/6 score well; pure-Rust, MIT/Apache, very actively
maintained. The whole 7-worker → tokio story is trivial in one process (5/5).

**Weaknesses:** **criterion 1 (1/5)** is disqualifying on its own weight: every
route, every tone of `Notice`, every keybinding table row and the entire
Tailwind token set is re-derived in immediate-mode code; there is no
`react-virtuoso` (a virtual grid must be hand-built on `ScrollArea::show_rows`);
settings panes with ~30 exact defaults become bespoke layout code. **Criterion
3 (2/5):** egui's text pipeline has historically lacked complex shaping and
CJK-aware line wrapping *(unverified here for current releases — S2 must test
it explicitly if egui is re-scored)*; Japanese titles wrap by glyph, not by
kinsoku rules. No first-class auto-updater.

### 5.3 Iced (Elm-architecture, wgpu) — 325

**Strengths:** Rust-native, MIT, clean `Command`/`Subscription` model that maps
well onto the event-push design (criterion 6: 5/5); text shaping via
cosmic-text gives credible CJK handling (3/5) *(unverified here)*.

**Weaknesses:** the full rewrite cost with a widget set still catching up for
dense, data-heavy layouts (criterion 1: 2/5); wgpu startup cost and memory vs
the ≤ 150 MB idle bar are unmeasured (3/5, gated); development pace and API
stability below egui's (3/5) *(unverified here)*; no first-class updater.

### 5.4 Slint (declarative DSL) — 330

**Strengths:** declarative markup with a real layout engine and built-in
`ListView` virtualisation (criterion 1: 2/5 — better than egui's, still a full
re-derivation of the vocabulary); lightweight renderers, strong embedded focus
(criterion 2: 4/5, gated); company-backed *(unverified here)*.

**Weaknesses:** **licence (4/5)** — GPL-3.0-or-later OR royalty-free commercial
OR the Slint-specific free licence. Because Kopibon is *already*
GPL-3.0-or-later, the GPL option is compatible and no royalty applies; the cost
is constraint discipline in `13-licence-audit.md`, not money. Criterion 3 (3/5)
and 8 (3/5) are unmeasured/unproven for a desktop app of this shape
*(unverified here)*; desktop track record is thinner than the alternatives'.

### 5.5 Dioxus (React-like RSX on a webview) — 345

**Strengths:** the only non-Tauri candidate that speaks the renderer's native
paradigm — components/hooks map from TSX to RSX with mechanical translation,
CSS carries over (criterion 1: 3/5); webview text stack for Japanese (4/5);
MIT/Apache.

**Weaknesses:** still a line-by-line rewrite of ~18k lines rather than a reuse
(the TSX does not compile as RSX), with no equivalent of `react-virtuoso`'s
maturity to lean on; the webview performance questions are the same as Tauri's
but with a less battle-tested custom-protocol/IPC layer for streaming
thumbnails (criterion 2: 3/5, gated; criterion 4: 3/5 — bundler/updater story
less mature *(unverified here)*); fastest-moving API surface of the six
(maturity 3/5).

### 5.6 GTK4 + relm4 — 345

**Strengths:** Pango is the best CJK text stack available to any candidate
(criterion 3: **5/5** — shaping, kinsoku wrapping, IME by construction);
GTK4 itself is the most mature dependency in the matrix (criterion 8: 5/5);
`GridView`/`ListView` with factories give real virtualisation; LGPL works for a
GPL app (criterion 7: 5/5).

**Weaknesses:** full rewrite (criterion 1: 2/5) with gtk4 CSS that is *not*
Tailwind (tokens re-derived again); **Windows packaging is the deal-shaper**
(criterion 4: 2/5) — bundling the GTK4 dependency tree on Windows is heavy and
fragile *(unverified here)*, pushing unpacked size toward the 80 MB ceiling;
GTK RSS against the 150 MB bar is unmeasured (criterion 2: 3/5, gated).

### 5.7 Why the totals land where they do

Three clusters emerge. The web/RSX cluster (Tauri 415, Dioxus 345) is separated
from the native-toolkit cluster (GTK 345, Slint 330, Iced 325, egui 315) almost
entirely by criterion 1's weight-25 re-derivation tax, worth 75–100 points
between best and worst case. Within the native cluster, ordering is driven by
Japanese text (egui's weakness, GTK's strength) and maturity. Tauri's margin is
real but **conditional by construction**: its weakest criterion is exactly the
one S2 has not measured.

---

## 6. The S2 gate (not yet run — this is the remaining blocker)

S2 measures a 10k-thumbnail virtualised grid in the **top two candidates under
this matrix: Tauri v2 and egui**. If the matrix is re-scored before S2 runs
(e.g. a licensing or maintenance surprise), S2 re-targets whatever is then
first and second. Throwaway code in `/tmp`, per the planning plan §3.

### 6.1 Setup (both candidates, identical inputs)

- 10,000 rows synthesised into a scratch SQLite DB with the
  [03-data-model.md](03-data-model.md) `library_item` shape (or a scrubbed copy
  of the production DB if Q5 corpus access is granted by then).
- 10,000 thumbnail JPEGs at the scanner scheme 600×800 q80 on local disk
  (`sha1(path)[0:16].jpg` naming), plus a subset with 300×400 files to exercise
  the second naming scheme.
- Grid defaults matching `LibraryPage` (`overscan` ≈ 400 px equivalent), dark
  theme, window 1200×800 at the dev machine's scale factor; **Wayland, Fedora
  44** — the same environment as [05-baselines.md](05-baselines.md) §1, so the
  numbers are comparable.
- Card content includes the fixed 20-title Japanese sample (§6.3) — titles
  mixing kana, kanji, Latin, digits and full-width punctuation.
- The D-thumbnail-poll-fix is *designed in* (one fetch per item per session);
  S2 measures the port's intended behaviour, not 1.x's defect.

### 6.2 Measurements and pass bars

| # | Measurement | Method | Pass bar (from [05-baselines.md](05-baselines.md)) |
|---|---|---|---|
| M1 | Scroll frame time | in-app frame callback timestamps during a scripted 30 s alternating fast-fling/jog scroll of the full 10k rows; report p50/p99/max and % frames > 16.6 ms | p99 ≤ **16 ms** sustained; no > 100 ms hitch over the run |
| M2 | RSS with 10k rows loaded | process-tree peak RSS after a full scroll-through (all images touched once), then after 60 s idle | ≤ **400 MB** (M2a); idle ≤ **150 MB** total (M2b) |
| M3 | Startup to first interactive frame | cold (page cache dropped) and warm, 5 runs each | ≤ **1.0 s** cold, ≤ **0.3 s** warm |
| M4 | Steady-state IPC | counters on the thumbnail channel and any poll channel with grid open, nothing happening | **0** steady-state calls (one-time fetches excluded) |
| M5 | Single-item thumbnail fetch cost | median wall time and payload size for one 600×800 fetch, channel-native vs (Tauri only) custom-protocol/asset handler | recorded; informs the subsystem plan — bar is ≤ 5 ms overhead over raw file read |
| M6 | Japanese rendering | render the 20-title sample in cards at 1× and 2× scale; screenshot + human inspection | zero tofu; correct glyph shapes; acceptable wrapping (no mid-cluster breaks); no clipping at 2× |
| M7 | DPI/touch | window scaled 100%/150%/200%; hit-target size check on `Button`/`Pagination`/tag chips at each | usable at 200% with no truncated controls (D5 touch-friendly) |

A candidate **fails the gate** if M1, M2 or M6 fails. M3/M5 failures are
tuneable (deferring decode off the UI thread, custom-protocol switch) and
become required conditions in the subsystem plan rather than gate failures.
S2's raw numbers, method notes and screenshots land in §7 (the decision
record) and in [05-baselines.md](05-baselines.md) §4 (replacing the
"not yet run" row); `16-open-questions.md` Q3 closes with the final selection.

---

## 7. Recommendation

**Tauri v2 is the primary candidate, conditionally — the condition is S2.**

- **Select Tauri v2** iff S2 (§6.2) passes M1, M2 and M6 for the Tauri build on
  the reference environment. Expected: the reused React renderer makes Phase C
  the cheapest and least risky UI migration of the six by a wide margin, and
  the ≥ 50-point margin absorbs tuning work on M3/M5.
- **If Tauri fails S2 on M1/M2 (webview compositing or memory):** fall back to
  **egui**, the best-scoring non-webview candidate for the specific failure
  mode (lightest runtime, strongest Rust-native perf story), accepting its
  criterion-1 rewrite cost and making M6 (Japanese) its mandatory sub-gate
  first — if egui also fails M6, **GTK4/relm4 becomes the fallback** (Pango
  passes Japanese by construction; its Windows-packaging penalty is then
  brought to the user with measured numbers).
- **If Tauri fails S2 on M6 only** (WebKitGTK Japanese/DPI defect): re-run S2
  with a newer WebKitGTK / the WebView2 path before leaving the web cluster;
  Dioxus inherits the same webview, so a webkit-level failure fails it too —
  the fallback ladder is egui → relm4 regardless.
- **If both S2 candidates fail all perf bars**, the ≤ 150 MB / ≤ 16 ms targets
  come back to the user for renegotiation before any toolkit is chosen — a
  targets problem, not a toolkit problem; per
  [05-baselines.md](05-baselines.md) §5 parity still wins over numbers.

### Decision conditions (checklist at S2 completion)

1. S2 run per §6.1 on the current top two; raw numbers recorded in §7 here and
   `05-baselines.md` §4. *(pending)*
2. M1/M2/M6 verdict per candidate recorded. *(pending)*
3. If Tauri passes: `04-parity-ledger.md` Phase C notes the renderer-reuse
   scope (bridge rewrite, not screen rewrite); `08-subsystem-plans/` GUI plan
   is written against Tauri commands/events per §8. *(pending)*
4. If fallback triggers: this document is amended with the re-scored matrix and
   the user is informed before Wave 3 closes (Q3). *(superseded — see below)*
5. **USER DECISION (Phase B kickoff, 16-open-questions Q3 RESOLVED): Tauri v2
   selected directly; conditions 1–4 above no longer gate the choice.** S2
   re-runs as measurement on the 2.x build (08-GUI §7 exit 3: idle RSS, 10k
   grid, M5 thumbnail transport, Japanese); the egui → relm4 ladder stays
   armed on measured M1/M2/M6 failure.

---

## 8. Consequences for the subsystem plans (`08-subsystem-plans/`)

The subsystem plans are written against the **conditional primary** with the
fallback noted, so a fallback trigger amends one section each rather than
rewriting them:

- **Metadata engine plan** — unchanged by toolkit. Byte-parity via the
  [07-metadata-spec.md](07-metadata-spec.md) renderer + lopdf writer (S1), the
  hand-rolled ZIP writer (S3), template resolution/caching, `DOUJIN_TEMPLATE_DIR`
  handling. No GUI dependency whatsoever (Phase A ships headless).
- **Database / data-layer plan** — rusqlite per [03-data-model.md](03-data-model.md)
  §10 (S6 evidence). Under every candidate the DB lives in the Rust core behind
  a single connection-per-thread policy with `busy_timeout`; under Tauri the
  UI never touches SQLite directly (commands only), matching today's
  renderer-never-touches-Node rule.
- **Scanner / conversion / sync plans** — the 7 worker kinds become tokio tasks
  (scan singleton, serial sync) with the message protocols of
  [01-current-architecture.md](01-current-architecture.md) §1.2 preserved
  verbatim as internal channel contracts. Under Tauri these surface as
  batched events (preserving the 25-item/500 ms `newItems` batching); under
  native toolkits as direct subscriptions. The `pdftoppm`-fallback rasteriser
  gap (S4 remainder) is **closed with pdfium-render** (F1 resolved, §1) —
  vendored per-platform in the packaging plan.
- **nhentai client plan** — toolkit-independent (reqwest port of `api-client.ts`
  + rate limiter). S5 consequence lands in the upgrade/import plan: the
  safeStorage key is re-entered on first import (D4 side-by-side softens).
- **GUI plan** — written against Tauri v2: bridge rewrite mapping all 144
  channels to commands/events with the envelope and errorId semantics of
  [02-ipc-surface.md](02-ipc-surface.md) §1; thumbnail transport decided by S2
  M5 (custom protocol vs base64 invoke); the P2 deviations D-poll-to-push and
  D-thumbnail-poll-fix are *the mechanism* for hitting M4. Contains the
  egui/relm4 fallback sketch so a trigger does not restart planning.
- **Packaging / updater / release plan** — Tauri bundler targets mirroring
  1.x (AppImage, .deb, .rpm, NSIS) with the D3 gain (no poppler/pikepdf deps)
  and the size budget of [05-baselines.md](05-baselines.md) §1; updater plugin
  on AppImage/Windows, package-manager channels on deb/rpm as today. The
  rasteriser crate choice (pdfium-render vs mupdf) is a packaging decision as
  much as a code one (bundled binary size) — decided there, not here.
- **Test plan** ([10-test-plan.md](10-test-plan.md) interface) — UI-level tests
  differ per toolkit; the metadata differential suite, the mass-delete guard
  test and the Kavita acceptance suite are toolkit-independent and run in Phase
  A regardless of this decision.

---

## 9. Facts this document relies on but has not verified

Recorded per the corpus rule that uncertain facts are marked, not invented:

- Current release/maintenance state of each framework as of late 2026
  (criterion 8 scores are qualitative; refresh with a version audit when
  `13-licence-audit.md` is written).
- egui/Iced/Slint current CJK text capabilities (criterion-3 scores reflect
  limitations known to date; S2 re-tests whichever becomes the fallback).
- Unpacked-size/memory figures for comparable Tauri/GTK builds; WebKitGTK
  fractional-scaling and version-fragmentation behaviour on user distros.

Everything else — the spike results (§1), the renderer size (§4), the parity
surface, the baselines — is measured or source-cited in this corpus.
