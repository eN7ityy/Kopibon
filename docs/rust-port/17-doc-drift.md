# 17 — Documentation drift (1.x docs vs 1.x source)

The authoritative record of where the shipped user documentation contradicts the
shipped source. Two consumers:

1. **The port must not codify documented-but-false behavior.** Where a doc claims
   a control or capability the source does not have, the source wins; the doc is
   wrong, not the code.
2. **The 2.x docs get written fresh from source.** This file lists what 1.x docs
   missed and fixes the vocabulary (Settings pane names, open paths) they got
   wrong, so 2.x does not inherit it.

Every entry has three parts: what the doc claims (doc cite), what the source does
(source cite), and the disposition 2.x must apply. All `path:line` citations were
re-verified against the working tree at the time of writing; where discovery notes
had drifted, the verified number is used. Dispositions:

- **Fix doc** — source behavior is correct/accepted; documentation is wrong.
- **Fix code** — the doc describes the *intended* product; the code falls short
  and 2.x should decide deliberately (feature-freeze on 1.x means no 1.x change).
- **Keep behavior, change doc** — the divergence is cosmetic or deliberate.

---

## Drift entries

### 1. The onboarding wizard is undocumented, and installation.md's first-run steps are unreachable (C1)

- **Doc:** `docs/getting-started/installation.md:39-50` — "First-run steps" tells a
  brand-new user to set the library path at "Settings → Library" (`:43`), check
  "Settings → Advanced → Required Tools" (`:45`), add an API key at "Settings →
  nhentai" (`:47`) and pick a format at "Settings → Downloads" (`:49`). No doc
  anywhere mentions "onboarding" or "wizard".
- **Source:** `src/renderer/src/App.tsx:88-94` renders `OnboardingWizard`
  *instead of the router* when `onboardingCompleted` is unset, so on first boot
  Settings is unreachable by any means; the wizard
  (`src/renderer/src/components/onboarding/OnboardingWizard.tsx:13-22`) walks the
  user through library path, thumbnails, API key, Kavita and a summary itself.
  The wizard is also unreachable by URL and cannot be reopened once completed
  (no route; see `01-current-architecture.md`).
- **2.x:** **Fix doc** — document the wizard as the first-run experience and move
  the manual Settings walk to a "configuring by hand" section. Decide explicitly
  whether 2.x keeps the wizard un-routable (current behavior) or makes it
  reopenable from Settings.

### 2. The update system and release channel are undocumented (C2)

- **Doc:** the only mentions are `docs/getting-started/installation.md:64` ("the
  AppImage is the release channel that can update itself") and
  `plans/release-pipeline.md:23` ("Beta testers on the Beta release channel
  auto-update onto it") — neither says where the channel is chosen or that an
  updater UI exists.
- **Source:** `src/renderer/src/components/settings/ReleaseChannel.tsx:14-49` is a
  stable/beta selector that persists immediately (`:20`);
  `src/renderer/src/components/settings/UpdateStatus.tsx:92-213` is a full updater
  UI (check, download, install, sanitised release notes, `:26-30`); the update
  dot shows on Settings (`src/renderer/src/components/settings/SettingsPage.tsx:103-119`)
  and in the sidebar (`src/renderer/src/components/layout/Sidebar.tsx:77-86`).
  `.github/workflows/test.yml:4-8` calls the channel "a user-facing Settings >
  Advanced choice" — known internally, never documented for users.
- **2.x:** **Fix doc** — document release channels, where to switch them, what
  beta means for update delivery, and the updater UI in Settings → Advanced.

### 3. The conversion "dry-run preview" does not exist (C3)

- **Doc:** `docs/features/conversion.md:57-60` — a "Dry-run preview" heading
  claiming "The conversion dialog can preview what would be converted before
  touching any files."
- **Source:** `src/renderer/src/components/library/ConvertToCbzDialog.tsx:20-134`
  is the entire dialog: a keep/delete radio pair (`:25-27`), a delete
  acknowledgement, and two buttons. Its props (`:4-9`) are `count`, `onCancel`,
  `onConfirm(keepOriginal)` — no preview surface, no dry-run mode, no data on
  which files beyond a count.
- **2.x:** **Fix doc** (remove the claim) — or, if a preview is genuinely wanted,
  **fix code**; either way the port must not treat the preview as an existing
  parity surface. It is not in `04-parity-ledger.md`.

### 4. The CBZ conversion queue cannot be paused (C4)

- **Doc:** `docs/features/conversion.md:65-66` — "the queue can be paused and
  cancelled between files."
- **Source:** the conversion job exposes only cancel:
  `src/renderer/src/stores/job-progress.ts:69-85` wires `onCancel` to
  `window.api.library.cancelConvertToCbz()` (`:82`). The preload API has
  `pause`/`resume` only for downloads (`src/preload/index.ts:75-79`) and the
  library scan (`:162-163`); no `pauseConvertToCbz` exists anywhere.
- **2.x:** **Fix doc** (say "cancellable") or **fix code** (add pause/resume to
  the conversion queue) — pick one deliberately; do not carry the claim.

### 5. Library search does not cover filenames, and `language`/`description` are searched but undocumented (C5)

- **Doc:** `docs/features/library.md:46-47` — search is "full-text across title,
  artist, series, tags, filename, nhentai ID and publisher"; `README.md:41`
  repeats "filename".
- **Source:** `src/main/db/repositories/library.repo.ts:54-72` — the real LIKE
  column list is `customTitle`, `primaryArtist`, `seriesName`, `customTags`,
  `publisher`, `language`, `description` (`:54-62`) plus `galleryId` cast to text
  (`:71`). `filePath` is **not** searched (filenames cannot be found); conversely
  `language` and `description` **are** searched and no doc mentions them.
- **2.x:** **Fix doc** — the searchable-field list must be transcribed from the
  Rust query, not from this sentence. If 2.x search gains filename coverage or
  FTS, that is a new feature, not a doc fix.

### 6. The gallery viewer opens from the detail panel's Read button, not a cover click — and the docs contradict each other (C6)

- **Doc:** `docs/features/readers.md:11-12` — "The online viewer opens when you
  click a gallery's cover in Search or Favorites."
- **Source:** `src/renderer/src/components/search/GalleryCard.tsx:60` — a card
  click calls `onClick(gallery.id)`, which opens the **detail panel**; the viewer
  opens from that panel's cover/Read button
  (`src/renderer/src/components/gallery/GalleryDetail.tsx:242`, Read label `:258`,
  `GalleryViewer` mounted at `:564-568`). `docs/features/nhentai-integration.md:31`
  gets it right ("**Read** (opens the gallery viewer)"), so the two docs disagree.
- **2.x:** **Fix doc** — one canonical open path: card → detail panel → Read.
  Verify against the 2.x implementation before writing.

### 7. The PDF viewer's keyboard section is missing (C7)

- **Doc:** `docs/features/readers.md:23-31` documents the PDF viewer with no
  keyboard mention, while the CBZ viewer gets a key list at `:40-41`.
- **Source:** `src/renderer/src/components/library/PdfViewer.tsx:207-246` has the
  same document-level handler as `src/renderer/src/components/library/CbzViewer.tsx:147-186`:
  `Escape` close, `PageDown`/`ArrowDown`/`j` +80vh, `PageUp`/`ArrowUp`/`k` −80vh,
  `Home`, `End`. Neither handler guards against focus in an input field.
- **2.x:** **Fix doc** — both viewers get a keyboard map (see "Rules" below), and
  2.x should decide whether the missing input guard is preserved verbatim.

### 8. "Batched, memory-friendly" PDF rendering is eager full-size rendering (C8)

- **Doc:** `README.md:70` — "Built-in PDF viewer with batched, memory-friendly
  rendering"; `docs/features/readers.md:26-28` — "renders pages in batches".
- **Source:** `src/renderer/src/components/library/PdfViewer.tsx:90-109` loops over
  **every** page, rendering each into a full-size canvas (`:95-103`), yielding to
  the event loop every 5th page only (`:107-108`). The codebase itself says so:
  `src/renderer/src/components/library/CbzViewer.tsx:5-7` — "the PDF viewer's eager
  full-resolution rendering of every page". The related claim that memory is
  released on close (`docs/features/readers.md:29-31`) **is** accurate
  (`PdfViewer.tsx:117`).
- **2.x:** **Keep behavior, change doc** (call it "rendered up-front on open, with
  a progress indicator; freed on close") — or make 2.x rendering genuinely lazy
  and keep the doc. Decide against the `05-baselines.md` RSS numbers; either way
  the 1.x wording is false and must not be inherited.

### 9. `_migration_staging/` has documented reserved status and no visible owner (C9)

- **Doc:** `docs/reference/library-layout.md:43` lists `_migration_staging/` as
  "Internal migration scratch space" among folders with reserved names.
- **Source:** the scanner does skip it (`src/main/workers/library-scanner.worker.ts:606-607`),
  but the only migration tooling in the repo, `tools/migrate-paths.mjs`, never
  creates such a directory; no code writes into it.
- **2.x:** **Investigate, then fix doc** — confirm whether it is a leftover from an
  unshipped migration or created externally before the port reserves the name.
  Keep the scanner skip (harmless, cheap); the doc's "internal migration"
  provenance is unverified — name the producer or drop the entry.

### 10. react-query is shipped, mounted and entirely unused (C10)

- **Doc:** no doc mentions react-query (correctly so); note the contrast —
  `docs/features/nhentai-integration.md:18` documents the *real* freshness
  mechanism accurately ("Results are refreshed every couple of seconds").
- **Source:** `package.json:35` pins `@tanstack/react-query ^5.62.0`;
  `src/renderer/src/App.tsx:2` imports it, `:11-18` configures a client
  (`staleTime: 30_000, retry: 2`), `:87` mounts the provider — and there is not
  one `useQuery`/`useMutation`/`invalidateQueries` call in `src/`. All freshness
  is nine hand-rolled 2000 ms `setInterval`s (see `01-current-architecture.md`).
- **2.x:** **Fix code** — drop the dependency and the provider from the port;
  specify the replacement for the polling (event push from the Rust core), not a
  react-query equivalent.

### 11. `ErrorBoundary` is implemented, never mounted, documented nowhere (C11)

- **Doc:** no doc mentions error handling in the renderer at all.
- **Source:** `src/renderer/src/components/shared/ErrorBoundary.tsx:20-97` is a
  complete boundary with main-process logger wiring (`:37`) and is never imported
  by anything. Uncaught render errors therefore fall through to the global
  `window.onerror` capture (`src/renderer/src/main.tsx:33-48`, rejections `:50-59`),
  which logs an `E-XXXXXXXX` id and leaves a **blank screen**.
- **2.x:** **Fix code** (mount an error boundary in the Rust/GUI shell — a blank
  screen is not an acceptable failure mode) and **fix doc** (state what the user
  sees when a view fails, and the error-id logging).

### 12. Settings pane names do not match the docs' navigation paths (C12)

- **Doc:** docs consistently navigate to panes that do not exist:
  "Settings → Downloads" (`docs/getting-started/installation.md:49`;
  `docs/features/downloading.md:12, :27, :40, :79`; `docs/features/conversion.md:32, :45`),
  "Settings → Downloads → Originals cleanup" (`docs/features/conversion.md:38`),
  and "Settings → Library" (`docs/features/library.md:63`).
- **Source:** `src/renderer/src/components/settings/SettingsPage.tsx:39-56` defines
  exactly five panes: `library`, `nhentai`, `kavita`, `advanced`, `danger`.
  "Downloads" is a **section heading inside the Library pane** (`:321-324`), and
  the Originals cleanup control sits there too (`:392`).
- **2.x:** **Keep behavior, change doc** — write navigation paths from the 2.x
  pane registry. If 2.x renames panes, every doc path is regenerated from that
  registry, not hand-typed.

### 13. Log level / tail / retention are undocumented and process-lifetime only (C13)

- **Doc:** no doc mentions the Logs panel or any log control; a user lowering
  retention to reclaim disk has no way to learn the change is discarded on close.
- **Source:** `src/renderer/src/components/settings/LogsPage.tsx:56-58` states it
  in so many words — level, tail lines and retention "are process-lifetime only
  and start back at the default the next time Settings is opened". Defaults:
  tail 10 of options 10–2000 (`:60-61`), retention 14 days (`:75`), auto-refresh
  on, 2 s (`:82`, `:128`). Only auto-refresh is session state; nothing persists.
- **2.x:** **Fix doc** (document the panel and the non-persistence loudly) and
  **fix code** (persistence is the obvious expectation; make it a deliberate
  decision, not an accident of the rewrite).

### 14. The calibre XMP block is presented as unconditional; it is emitted only for series (from `00-planning-plan.md` §1)

- **Doc:** `docs/reference/metadata-formats.md:39-56` — the PDF XMP field table
  lists `calibre:series`, `calibreSI:series_index`, `calibre:timestamp`,
  `calibre:title_sort`, `calibre:author_sort` (`:52-56`) as ordinary rows; only
  the `calibre:series` row notes a condition ("Only written when a series name is
  set"). A reader concludes each row is an independent emission rule.
- **Source:** `resources/metadata-templates/pdf-xmp.template:48-58` — the **entire
  `<rdf:Description>` block** carrying all five calibre fields is wrapped in
  `{{#seriesName}}…{{/seriesName}}` and vanishes wholesale when there is no series
  name; additionally `{{seriesIndex?}}` (`:52`) drops the `calibreSI:series_index`
  line when the index is empty. So `calibre:timestamp`, `calibre:title_sort` and
  `calibre:author_sort` are **never** written for a one-shot, even when their
  source values exist — the doc's per-row framing cannot express this.
- **2.x:** **Fix doc** — document the block as a unit with its single condition,
  and carry the same framing into `07-metadata-spec.md` (the field × mutation
  matrix rows for these five fields are all gated on series membership, not on
  their own values).

### 15. Verified accurate — no drift (C14; recorded so future audits do not redo it)

These doc claims were checked against source and found exact. If one of them is
edited, re-verify it; otherwise they can be cited as-is:

| Claim | Doc | Source | Status |
|---|---|---|---|
| nhentai rate-limit table (all eight endpoints, anon/auth) | `docs/getting-started/nhentai-api-key.md:54-64` | `src/main/services/rate-limiter.ts:155-168` | exact, incl. flat popular/favorites limits |
| CDN demotion after 3 consecutive non-404 failures; single success re-promotes | `docs/features/downloading.md:88-91` | `src/main/services/download-manager.ts:127-128, :834-849` | exact |
| PDF compression defaults (compression on, quality 80, Dynamic, black bg) | `docs/features/downloading.md:30-36` | `src/renderer/src/stores/settings.store.ts:98-101` | exact |
| Concurrency 1–8, default 3 | `docs/features/downloading.md:40-42` | `src/renderer/src/components/settings/SettingsPage.tsx:332-334` (clamp `min`/`max`; default in `settings.store.ts`) | exact |
| Four-tool toolchain probe, startup + Re-check | `docs/reference/external-tools.md:57-59` | `src/main/services/toolchain.ts:117-147` | exact (pikepdf, pdfinfo, pdfimages, pdftoppm) |
| Scan pause / resume / cancel from the toolbar | `docs/features/library.md:13` | `src/renderer/src/components/library/LibraryPage.tsx:614-616, :923-948` | exact |
| Release pipeline (test branch → beta pre-release; tag → draft stable) | `plans/release-pipeline.md` | `.github/workflows/test.yml`, `release.yml` | exact at summary level |
| `_originals/_lossy/` counted separately and never purged | `docs/features/conversion.md:35-37` | `src/renderer/src/components/settings/OriginalsCleanup.tsx:25-27` | exact |
| Kavita setup flow and button labels (Test Connection, Find Libraries) | `docs/features/kavita-integration.md:16-24` | `src/renderer/src/components/settings/KavitaSettings.tsx:185, :230, :281` | exact |
| Search results refresh every couple of seconds | `docs/features/nhentai-integration.md:18` | `src/renderer/src/components/search/SearchPage.tsx:249` (2000 ms) | exact |
| PDF viewer releases all canvas memory on close | `docs/features/readers.md:29-31` | `src/renderer/src/components/library/PdfViewer.tsx:117` | exact |

### 16. Prose defects (C15 — not drift, but wrong as written)

Not claims about behavior; listed so 2.x does not copy the sentences. All the
same full-stop-instead-of-comma pattern unless noted:

- `docs/features/kavita-integration.md:3-4` — "This app does not need it / The app
  works without it": missing terminator and duplicated clause.
- `docs/features/readers.md:40-41` — "…arrow keys or **J**/**K**. with
  **Home**/**End** to jump."
- `docs/features/conversion.md:39-40` — "…**restore** originals back into the
  library. which moves the PDFs back…".
- `docs/features/sync.md:19-20` — "…ComicInfo for a CBZ. using the API data…";
  same at `:46-47`.
- `docs/features/kavita-integration.md:22-23` — "…first scanned folder. this
  matters when…".
- `docs/features/conversion.md:70-71` — "…as separate fields. and this app
  writes…".
- `README.md:88-89` — a live `<!-- TODO: replace the two search screenshots … -->`
  comment shipped in the rendered README.

Disposition for all: **fix doc**; carry no sentence forward.

---

## Rules for 2.x documentation (normative)

1. **Write from source, with cites.** Every 2.x doc is written with the
   implementing component open; each feature claim carries a `path:line` cite to
   the 2.x source in the doc's review metadata, checked the same way this file's
   citations were checked. A claim that cannot be cited does not ship.
2. **No doc claims a control that does not exist.** Before any "Settings → X" or
   "the app can Y" sentence, verify the pane/section/button/handler exists in the
   2.x source (entries 3, 4, 12 are the cautionary tales). Navigation paths come
   from the pane registry; searchable fields come from the query; keyboard maps
   come from the key handlers.
3. **Never document an intended feature as a current one.** If 2.x gains dry-run
   preview or conversion pause, they are documented when implemented, in the
   release notes of the build that ships them.
4. **Internal contradictions are release blockers.** Two docs describing the same
   interaction differently (entry 6) is a doc bug with the same severity as a
   functional one: one canonical description per interaction, linked, not restated.
5. **State persistence semantics explicitly** (entry 13): for every control, the
   doc says whether it persists, and if not, says so in the same sentence.
6. **Prose passes the C15 checklist** — no sentence-fragment-as-clause patterns,
   no shipped TODO comments.

**Features the 2.x docs MUST cover that 1.x docs missed** (from entries 1–2, 7,
11, 13 — this is the minimum coverage set for the 2.x doc pass):

- **The onboarding wizard** — steps, what each saves, that it runs instead of the
  main UI on first boot, and whether it can be reopened.
- **The updater and release channel** — where the channel selector lives, what
  beta delivers, the update-status UI, and which package formats auto-update.
- **The Logs panel** — level, tail size, retention, auto-refresh, export, and the
  persistence semantics of each control.
- **Keyboard maps for both file viewers** — PDF and CBZ (`Escape`,
  `PageDown`/`ArrowDown`/`j`, `PageUp`/`ArrowUp`/`k`, `Home`, `End`), plus the
  online viewer's keys, transcribed from the 2.x handlers including any new
  input-field guard.
