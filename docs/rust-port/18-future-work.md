# 18 — Future work (deliberately deferred, with triggers)

Everything in this document is *out of the port by decision*, not by omission.
Nothing here blocks any phase of [09-migration-phases.md](09-migration-phases.md);
none of it appears in the [04-parity-ledger.md](04-parity-ledger.md) parity
surface. Each item carries a **trigger**: the concrete condition under which
it is revisited. Between triggers, reopening an item is scope creep. Per the
ledger rule (04 §9), anything here that lands later enters through a P2
deviation row or a new ledger row — never silently.

---

## 1. Not deferred — decided in the port (recorded so it is not re-litigated here)

Items that look like future work but are settled *inside* the port:

- **`library:itemDeleted` and Kavita delete mirroring** — implemented *in* the
  port, not deferred. Per [16-open-questions.md](16-open-questions.md) Q7 and
  [08-subsystem-plans/07-sync-and-kavita.md](08-subsystem-plans/07-sync-and-kavita.md)
  §5.2, the port emits `library:itemDeleted {id, galleryId}` from all three
  delete paths so Phase B's renderer can invalidate search results and a real
  delete signal exists for Kavita mirroring. What stays future-shaped is the
  *full* mirroring product (a user-visible "delete from Kavita when I delete
  locally" toggle with confirmation) — trigger: user ask. The plumbing lands
  now; the product waits.
- **ErrorBoundary** — the port mounts one app-wide: deviation D-error-boundary
  (04 §9, *proposed*). 1.x ships `ErrorBoundary.tsx` unused and blank-screen
  failure is unacceptable. A deviation row, not a backlog item.
- **react-query removal** — already decided, nothing to do: the package is
  mounted and entirely unused in 1.x (04 §8) and does not reappear in 2.x.
  Likewise Q6's default — `convertAllMetadata` becomes DB-backed and resumable
  in the port (08/06; 09 Phase A work items) unless the user overrides.

---

## 2. Deferred items

### F1. PDF rasteriser for the lossy fallback (`pdfium-render` vs `mupdf`)

**What.** 1.x rasterises non-DCTDecode PDF pages with `pdftoppm -jpeg -r 150`
(08/06 §4). D3 (zero external tools) bans poppler in the shipped build; S4
proved the *lossless* DCTDecode path natively (16/16 images byte-identical),
but the *lossy* fallback needs a Rust renderer: `pdfium-render` (dynamic
pdfium binary — bundled size + licence questions) vs `mupdf` (AGPL question
against the GPL-3.0 app). Until it lands the conversion queue row fails loud:
*"lossless conversion requires a rasteriser; source PDF left in place"* —
never a silent quality drop (08/06 §4 USER DECISION).
**Why deferred.** The licence/bundled-size trade-off is a packaging decision
(06 §8); the extractor trait isolates the seam, so the port does not wait on it.
**Trigger.** First real user PDF that hits the lossy path, or the Phase D
packaging review picking the crate. Revisit with the size/licence numbers on
the table.
**Status: RESOLVED — pdfium-render (USER DECISION, option A).** Fidelity spike
measured 2026-09-06 on a 3-page vector/text PDF (Helvetica, Letter, no embedded
images — the S4 count-guard trip case): page count 3=3; dimensions identical
1275×1650 both sides at 150 DPI; mean-abs-diff ≈0.18/255 per channel (JPEG
encoder difference only — the lossy path is never byte-parity). Thumbnail check:
`pdftoppm -scale-to 800` → 619×800; pdfium 150 DPI render resized fit-inside
600×800 matches the scanner scheme. Binary facts: pdfium-render 0.9.3
(MIT OR Apache-2.0), non-V8 `libpdfium.so` 7.7 MB unpacked / 3.5 MB compressed
per platform (pdfium-binaries chromium/8035), BSD-3-Clause + permissive bundled
notices, userspace-only linkage (libpthread/libm/libgcc_s/libc). Wired as
Attempt 2 in `kopibon-core::conversion::extract` (`method: "pdfium"`) and
`generate_pdf_thumbnail` in `scanner/thumbnail.rs`; D-lossy-fallback-deferred
resolved in the ledger.

### F2. FTS5 search

**What.** 1.x search is substring `LIKE` fanned out over the 7 columns
`custom_title, primary_artist, series_name, custom_tags, publisher, language,
description` plus a `CAST(gallery_id AS TEXT) LIKE` — no index, no FTS table
(08/05 §6; [03-data-model.md](03-data-model.md) §9 is the spec ported verbatim).
**Why deferred.** The parity rule (03 §10.9) demands row-set equality for
saved filters during the port; an FTS index changes result semantics and adds
a rebuild/migration path. At the current library scale LIKE is fine.
**Trigger.** Library grows past ~10k items and search latency becomes
measurable, or a user complains about relevance (substring false hits). Then:
FTS5 as an *additive* index, LIKE preserved for saved-filter equality.

### F3. Tag exact-match fix (comma-joined over-match)

**What.** Filter `maid` matches tag `maids` because tags live in one
comma-joined text column. The USER DECISION in
[08-subsystem-plans/05-database-layer.md](08-subsystem-plans/05-database-layer.md)
§6 is: **preserve 1.x behaviour through Phase A** (saved filters and row-set
equality forbid a mid-port semantic change), then revisit **behind a
`tagExactMatch` flag post-cutover**, with a migration to a proper tag table
(split on commas in SQL or a join table) if wanted.
**Trigger.** Post-cutover, at the earliest; only on a user complaint about
over-matching. The flag ships off; nothing in the Phase A build may change
match semantics either way (08/05 §9 risk table).

### F4. Thumbnail cache unification

**What.** Two naming schemes share one directory: scanner thumbnails
`sha1(absolute_path)[0..16].jpg` at 600×800 q82, and download-worker
thumbnails `<galleryId>.jpg` at 300×400
([08-subsystem-plans/02-library-scanner.md](08-subsystem-plans/02-library-scanner.md)
§6; [01-current-architecture.md](01-current-architecture.md) §7). The port
keeps both as-is — the rescan path re-derives the first exactly.
**Why deferred.** Unifying mid-port risks re-scan storms and breaks
rescan-path parity; cache files are disposable artefacts, so this is pure
post-cutover hygiene (one migration: rewrite entries to one scheme/size, then
a single code path).
**Trigger.** First post-cutover maintenance window after the port is stable.
Ship the migration as a subcommand alongside `regenerate-thumbnails`
(04 §7 CLI row).

### F5. Jumplist, global shortcut layer, command palette

**What.** None of the three exists in 1.x: no jumplist, no global shortcuts
(every binding is component-local — 04 §4), no command palette. The port
reproduces the component-local bindings verbatim and adds nothing.
**Why deferred.** Not parity surfaces; adding them mid-port would create
unreviewed deviations against a frozen ledger.
**Trigger.** Explicit user request for a specific capability, one item at a
time, each entering through a ledger row. Never bundled into a "polish" phase.

### F6. Toast / snackbar system

**What.** 1.x has no toast system (grep `toast|snackbar` returns nothing —
04 §3). Feedback is inline "Saved" states, job `lastMessage` summaries,
`Notice`/`NoticeRegion` (5 tones), and OS notifications from main only. The
port keeps exactly this vocabulary.
**Why deferred.** The `Notice` vocabulary is a fixed P0 component row; a toast
layer would overlap it and re-open the component vocabulary during Phase C.
**Trigger.** Post-cutover user complaint about feedback visibility. If built,
it complements — never replaces — `Notice`.

### F7. macOS support

**What.** Build artifacts, code-signing and notarisation for macOS.
**Why permanently out.** Out of scope since 1.x (`electron-builder.yml:101-104`
— no mac target) and confirmed permanently out by the user in the planning
round (Q10, RESOLVED; 04 §8 dropped row). The Rust core is OS-agnostic, so
nothing in the architecture closes the door — but no corpus document plans
for it.
**Trigger.** Only both of: a paid Apple Developer account, *and* sustained
user demand. Reopening is a fresh decision with its own packaging plan
(signing, notarisation, updater), not a checkbox.

### F8. Mobile / touch-only form factors

**What.** iOS/Android or tablet-first UI.
**Why out.** D5 is desktop-only (touch-friendly and DPI-aware *within*
desktop, per 06 C4). No spike, baseline or ledger row considers mobile.
**Trigger.** A new explicit user decision superseding D5 — recorded in
16-open-questions first, corpus amended second. Not scheduled.

### F9. Real SQLite foreign keys

**What.** 1.x sets `PRAGMA foreign_keys = ON` (`connection.ts:81`) but **not
one table declares a foreign key** ([03-data-model.md](03-data-model.md)
§10.7, with the source's own admission at `library.repo.ts:369-373`).
Integrity is convention plus the boot-time orphan sweep and artist cleanup.
Declaring real FKs would change delete/cascade semantics on every existing DB
and require a full migration with backfill.
**Why deferred.** The corpus rule is explicit — 03 §10.7: *"Do not declare
foreign keys on an existing DB as part of the port."* Big migration, low
value while the boot sweep works.
**Trigger.** Orphaned-artist / dangling-row drift recurring *despite* the
sweep in 2.x operation. Then weigh a migration against widening the sweep.

### F10. Sync resume UX improvements

**What.** The port ships the 1.x `ResumeSyncBanner` contract exactly
(outstanding > 0 → offer resume; `resumeSync()` with empty ids continues —
08/07 §5.3, exit criterion §8.2). Improvements — background auto-resume
after crash recovery, per-item error drill-down, scheduled retry of errored
rows — are not in the ledger.
**Why deferred.** The banner contract is a P0 surface; enriching it is
product work on top of a proven queue, not port work.
**Trigger.** User ask after cutover; each improvement enters as its own
ledger/P2 row.

### F11. `convertAllMetadata` dry-run preview

**What.** 1.x user docs claim a "Dry-run preview" in the conversion dialog
(`docs/features/conversion.md:57-60`), but no such feature exists —
`ConvertToCbzDialog.tsx` is a keep/delete radio pair and two buttons
([17-doc-drift.md](17-doc-drift.md) §3); the surface is absent from the
parity ledger. 2.x default: **fix the doc** (remove the claim). The
conversion plan's `{dryRun:true, items, count}` shape (08/06 §4) already
sketches what a real preview would return if one is ever built.
**Why deferred.** Building the preview is new product surface nobody has
asked for.
**Trigger.** A user asks to "preview what would be converted." Then build it
against the existing dry-run shape and add the ledger row. Until then it
must never be documented as current (17 §3's closing rule).

---

## 3. Rules of engagement

1. A trigger fires → open a 16-open-questions entry, amend the ledger and the
   affected subsystem plan, *then* implement. Never the reverse order.
2. Nothing in this list may be pulled into Phase A–D "while we're in there."
   Phase pressure goes to the deviation table (04 §9), not here.
3. F7/F8 are scope decisions owned by the user alone; the implementing agent
   may not accept them as issues, only surface the trigger.
