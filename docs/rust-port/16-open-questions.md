# 16 — Open questions

Living document. Each question carries a recommendation and a status. A
question closes only with a decision recorded here (and, where it changes the
corpus, the affected documents amended).

---

## Open

### Q1. Kavita server version
The test server answers at `http://kavita.bragi.internal` with unversioned
`/api/...` routes (the openresty proxy injects the API version segment; direct
`:8080` demands versioned routes and rejects every plain version string).
`/api/Settings/server-info` and `/api/Server/*` probes returned empty under
the plugin key, and the SPA bundle embeds no version constant. Why it matters:
`10-test-plan.md`'s Kavita acceptance suite and the scan-folder / scan-series
endpoint behavior differ across Kavita releases.
**Recommendation:** read the version off the Kavita UI (Settings → Server or
the footer) once and pin it here; also record the exact proxy rewrite so tests
never depend on :8080.
**Status:** open — needs one manual look at the web UI.

### Q2. S4 outcome — native lossless PDF image extraction
If a Rust extractor cannot match `pdfimages -all` losslessly on the golden
fixtures, D3 (zero external tools) conflicts with lossless conversion quality.
Spike S4 settles it; the measured result comes back to the user, not a silent
scope cut (planning plan §3).
**Recommendation:** run S4 before closing Wave 3; if negative, options are
(a) keep poppler as the single allowed external tool, (b) accept JPEG-recompress
quality on the lossless path, (c) block PDF→CBZ for lossless sources.
**Status:** open — gated on S4.

### Q3. GUI toolkit (S2) — RESOLVED (USER DECISION, Phase B kickoff)
Six-way scoring (egui, Iced, Slint, Dioxus, Tauri v2 + web UI, …) was gated on
the baselines and spikes; see `06-technology-decision.md`.
**Status: closed — user selected Tauri v2 + existing frontend (option A)
directly.** S2's role changes: no longer a *selection* gate, it re-runs as
*measurement* on the 2.x build (idle RSS, 10k-grid scroll, thumbnail
transport M5, Japanese rendering — 08-GUI §7 exit 3). The egui→relm4 fallback
ladder (06 §7) stays armed: if measurement on the real build fails M1/M2/M6,
it fires then.

### Q4. XMP byte parity (S1)
Byte-parity for the XMP packet without Python is the highest-value spike; on
failure D2's escape hatch is canonical-XML parity for the packet only.
**Status:** open — gated on S1.

### Q5. Golden-corpus breadth
The three DoujinsTest fixtures cover the download writer paths. The full
capture (planning plan §5) wants all 12 write paths × formats, plus a real
legacy sample carrying the old `Tagged by Doujin Downloader — …` Notes string
and both marker placements. How much of the production library
(`/kavita/doujinstest` sibling `Doujins`, 5287 files) may be copied read-only
for capture, and is there a disposable ~200-item clone for mutation tests?
**Recommendation:** copy a read-only sample into a workspace outside the
Kavita roots; run mutation tests only inside `Doujin-Test` (library id 6,
never scanned, disposable by design).
**Status:** open — needs the user's go-ahead on which items to copy.

### Q6. convertAllMetadata resumability in the port
1.x runs it off an in-memory array — the one long job with no crash resume
(library.ipc.ts:2094-2098; discovery-02 §6). The port could give it the
conversion-queue treatment (DB-backed, resumable) for free.
**Recommendation:** make it DB-backed (P2 deviation, ledger row).
**Status:** open — user call; default to resumable.

### Q7. Dead channels: implement or delete
`library:itemDeleted` (emitted 3×, no subscriber), `auth:getRateLimits`
(registered, unexposed), `library:newItem` (subscribed, unconsumed) — see
02-ipc-surface §4. Port either implements the obvious intent (delete
mirroring for Kavita uses itemDeleted) or drops them.
**Recommendation:** implement `itemDeleted` (Kavita delete mirroring needs a
delete signal anyway); drop the other two.
**Status:** open — default to the recommendation.

## Closed

### Q8. Kavita test environment — RESOLVED
Verified working: `http://kavita.bragi.internal` (port 80), header
`x-api-key` with the plugin key from `plans/kopibon_rust_port/kavita_server.txt`,
unversioned `/api/...`. Library **Doujin-Test (id 6)** → `/kavita/doujinstest`
(= `/mnt/bragi/Kavita/DoujinsTest`), `lastScanned` 0001-01-01 (clean slate),
folder-watching on. Production library `Doujins` (id 5, 5287 files) shares the
server — the test plan must never scan/mutate it. Recorded in
`10-test-plan.md`.

### Q9. Corpus access — PARTIALLY RESOLVED
The three golden fixtures are in place and byte-inspected (ZIP container
flags, ComicInfo.xml, PDF Info + XMP — see `07-metadata-spec.md` §fixtures and
`10-test-plan.md`). Remaining breadth is Q5.

### Q10. macOS — RESOLVED
Permanently out of scope (user-confirmed in the planning round; D-decision).

### Q11. Notes string in the golden fixtures — RESOLVED (no action)
The three fixtures carry `Tagged by Doujin Downloader — nhentai gallery N`
(legacy product name) while the current template emits
`Tagged by Kopibon — …` (resources/metadata-templates/comicinfo.template:15).
Per D7 the writer always emits the current name, so ComicInfo byte-parity
tests against these fixtures must exclude/normalize the Notes line; the
fixtures remain exact targets for every other element. Recorded in
`07-metadata-spec.md` §fixtures and `10-test-plan.md`.
