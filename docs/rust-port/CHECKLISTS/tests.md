# CHECKLISTS — Test inventory (machine-readable mirror)

Mirrors [../10-test-plan.md](../10-test-plan.md) §7 exactly — same IDs, one line per test:
`ID | suite | level | fixture | command | phase` (10 §8 rule 4: regenerable from that table; the corpus
checker asserts ID/level/fixture/command for every row; a WP without its rows is not done — [../14-task-breakdown.md](../14-task-breakdown.md)).

Levels ([../10-test-plan.md](../10-test-plan.md) §2, authority [../07-metadata-spec.md](../07-metadata-spec.md) §1):
**byte** = same byte sequence; **canonical** = parsed field→value map (D2 escape hatch — no artefact sits here today); **semantic** = values equal after decoding. Whole-PDF bytes are **not** a target (07 §1).

Standing rules ([../10-test-plan.md](../10-test-plan.md) §8): no wall clock (volatile fields injected per 07 §9); never production library id 5, live production DB, the 1.x install, or the real DoujinsTest mount as write target; fixtures carry sha256 provenance and are committed read-only; failing-behaviour changes go through ledger §9 ([../04-parity-ledger.md](../04-parity-ledger.md)) — never a silently relaxed assertion.

Phases: A = [../09-migration-phases.md](../09-migration-phases.md) Phase A exits 1–5; gate `scripts/port/phase-a-gate.sh` re-runs in CI at every later phase.

## Metadata / template differential (Phase A)

- [x] **TA-01** | Template differential (26 seeds) | byte + error strings | inline seeds | `cargo test --test template_differential`
- [x] **TA-02** | Template fuzz (10k/run; nightly 1M soak clean ×3 before gate) | byte | generated | `cargo test --test template_fuzz -- --ignored`
- [x] **MA-01** | Mapper differential (58 cases, real templates) | byte | CURRENT-BUILD contexts | `cargo test --test mapper_differential`
- [x] **WR-01** | Field × mutation matrix (12 write paths × 4 artefacts) | per §2 (ComicInfo byte w/ Notes excluded per Q11; XMP packet byte; Info+`/Keywords` semantic; ZIP structural byte; DCTDecode pages byte) | golden 1–3 + CURRENT-BUILD | `cargo test --test differential_matrix`
- [x] **WR-02** | XMP packet round-trip (S1, 1782 B) | byte | fixture 3 | `cargo test --test pdf_writer -- xmp`
- [x] **WR-03** | ZIP structural checklist (S3) + Python zipfile CRC | byte | fixture 1 rebuild | `cargo test --test zip_writer` && `python3 tests/zip/validate.py out.cbz`
- [x] **FN-01** | Sanitiser triplet + 251–255-byte Japanese boundary | byte | filename vectors | `cargo test --test filenames`

## Scanner / DB / pumps (Phase A)

- [x] **SC-01** | Scanner row-for-row vs the REAL worker (worker_thread via scan_harness.mjs): walk rules (dotfiles/reserved/noise), extraction parity (docinfo+Keywords, XMP nested+flat incl. the bag-regex cross-element capture, ComicInfo entities/Series==Title/legacy Volume), queue lifecycle, thumbnail sha1 scheme, removal happy path, second-scan incremental (0 new items, no churn) | semantic (excl. timestamps; PDF thumbnails at the plan §6 poppler-less baseline pending Q-S4) | synth tree (scanner_fixture.rs) | `cargo test --test scanner_differential`
- [x] **SC-02** | Removal triple guard vs the REAL worker: guard 1 (chmod-000 dir, unseen row survives), guard 2 (log 100 → discovered 3), guard 3 (3 ghosts of 6 rows) — each zero deletions, reason strings equal; happy path (1 of 10 deleted, artists included) in SC-01 scan 3 | invariant | synth tree | `cargo test --test removal_guard`
- [x] **DB-01** | Migration zero-surprise on production copy | invariant | prod-DB byte copy | `cargo test --test db_differential migration`
- [x] **DB-02** | Read parity over filter × sort matrix | semantic | prod-DB byte copy | `cargo test --test db_differential read`
- [x] **DB-03** | Grouped view parity (findPaginatedGrouped/hydrateRows/seriesFacts/matchingMemberIds) against the REAL repos, filter × sort × minMembers on the 5261-item copy | semantic | prod-DB byte copy | `cargo test --test db_grouped_differential db03`
- [x] **DB-04** | Group lifecycle (backfillAll/resolveFor): case-variant spellings, ungroupable names, dissolved/manual groups, wrong-link repair; row-for-row post-state | semantic | synthetic lifecycle fixture ×2 | `cargo test --test db_grouped_differential db04`
- [x] **DB-05** | Startup-maintenance sweep, counters + post-state row-for-row (grouping on/off × retention branch) | semantic | synthetic debris fixture ×2 | `cargo test --test db_grouped_differential db05`
- [x] **DB-06** | `Intl.Collator(numeric, base)` sign parity (ICU4X vs V8) — 3000 seeded pairs + fixed corners; helper parity (gaps/facts/cover/sort) | semantic | seeded fuzz vs live module | `cargo test --test series_grouping_differential`
- [x] **NC-01** | search-query.ts port: the real test file's cases + 150-case differential fuzz vs the live module (build/negate/hasField/dim matching) | semantic | seeded fuzz | `cargo test --test nhentai_query`
- [x] **NC-02** | Rate limiter: refill arithmetic, sanitize fallbacks, ENDPOINT_LIMITS table, anon↔auth swap, token-bucket pacing (25 scripted searches never pass the bucket), both UAs, both 429 retry models (client retry-once w/ Retry-After cap; sync 3-attempt w/ backoff ladder) | invariant | fake clock + replay transport | `cargo test --test nhentai_client`
- [x] **NC-03** | Endpoint request parity (method/path/query/headers/body) + typed response round-trips + URL builders + CDN 1h cache | semantic | replay transport | `cargo test --test nhentai_client`
- [x] **NC-04** | Tag resolver: cache-first, 100-id batches capped at 3/call, stop-on-failure keep-what-resolved, id dedup, id-0 poison guard, sqlite store round-trip | semantic | replay + sqlite | `cargo test --test nhentai_client`
- [x] **DL-01** | Download pipeline on a real local fixture server (state-machine + fixture tests per plan 03 §9 — 1.x's DownloadManager is Electron-bound): full CBZ + PDF runs (placeholder lifecycle, page count from the file, superseded removal after the new file exists, thumbnail scheme, events, page-rows dropped), page failure ladder w/ 1s·2^n backoff → failed + placeholder removed, claim order priority DESC/queuedAt ASC, findActiveByGalleryId ignores history, cancel/pause/resume, concurrency clamp 1–8, reconcile-interrupted idempotent, CDN demotion/re-promotion, PDF page-count via Root→Pages→Count, XMP warn-only | semantic | fixture server + scripted API | `cargo test --test download_pipeline`
- [x] **CV-01** | Conversion pipeline: golden 3-page conversion (8 ordered steps, verify gate, both-columns cover update, page recount, original archived), verify gate both ways (sequential names, ComicInfo-not-first, empty title, valid archive), count guard → loud lossy-failure with source untouched (D-lossy-fallback-deferred), keep_original=false deletes lossless source, archive collision uniquifies -1, stale queue rows complete cleanly, cancel leaves pending rows, metadata job resumable (D-metadata-queue: marker move leading-prefix-only, errors cap), originals walk/restore/purge incl. _lossy strip + never-overwrite | semantic | synthetic image-PDF fixtures | `cargo test --test conversion`
- [ ] **SY-01** | Sync retry/pacing/cancel vs 1.x on scripted gallery | semantic | fixture server | `cargo test --test sync_differential`
- [ ] **KV-01** | Kavita endpoints + scan-trigger positives/negatives (10 §4.1–4.4; port 80, `x-api-key`, library id 6 only) | invariant | Doujin-Test (id 6) | `cargo test --test kavita_acceptance -- --ignored`
- [ ] **KV-02** | Production-library protection (id 5 counts asserted before/after every test) | invariant | server | embedded in `kavita_acceptance` harness pre/post hook
- [ ] **CR-01** | SIGKILL mid-batch, all four queues (10 §6; run twice, idempotent) | invariant | clone + scratch dirs | `cargo test --test crash_recovery -- --test-threads=1`

## Bridge / UI / import (Phase B / C / D)

- [ ] **BR-01** | 144-channel contract suite (130 request/response + 14 events) | invariant | — | `npm run contract:bridge` — Phase B gate; re-run in CI from Phase B onward (11 §3)
- [ ] **UI-01** | Ledger rows per route ([../04-parity-ledger.md](../04-parity-ledger.md) §2–§5 checklist sign-off) | P0/P1 per row | golden library | [CHECKLISTS/ui-parity.md](ui-parity.md) walk + `npm run contract:bridge` — Phase C
- [ ] **IM-01** | Import matrix + non-destructive sha256 (09 §Phase D) | invariant | scripted 1.x profile | `cargo test --test import_matrix` — Phase D

## Sign-off

- [ ] Every row above checked for the current WP before it is "done" ([../15-agent-playbook.md](../15-agent-playbook.md) §4)
- [ ] No test added/renamed here without a matching row in [../10-test-plan.md](../10-test-plan.md) §7 (and vice versa)
- [ ] `cargo test --workspace` covers every non-`--ignored` ID ([../15-agent-playbook.md](../15-agent-playbook.md) §4)
