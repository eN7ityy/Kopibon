# 12 — Risk register

Ranked risks for the 1.x → 2.x Rust port. Each entry carries description,
evidence (corpus doc § or `path:line`), an observable early-warning signal,
mitigation, and the owning phase ([09-migration-phases.md](09-migration-phases.md)
A–D). A risk is closed only when its mitigation has landed **and** its
early-warning signal has a standing detector (a test, a CI gate, or a
checklist item); otherwise it stays open even if the mitigation is planned.
Bare doc references (`NN-doc-name §n`) resolve within `docs/rust-port/`;
workflows and runner files are cited as `path:line` from the repo root.

## 1. Scale

Probability and impact are each L/M/H; the tier is their matrix cell.

| Tier | Meaning | Cells |
|---|---|---|
| **P0** | Program-blocking — standing mitigation must exist before the owning phase starts | H×H, H×M |
| **P1** | Phase-threatening — mitigation lands inside the owning phase, tracked at every gate | M×H, M×M, L×H |
| **P2** | Costly but recoverable — mitigation planned, reviewed at phase exits | M×L, L×M |
| **P3** | Accepted noise — recorded, no standing work | L×L |

## 2. Ranked summary

| ID | Tier | P | I | Risk (one line) | Owner |
|---|---|---|---|---|---|
| R1 | **P0** | H | H | Metadata byte-parity regression breaks the contract | A (re-run every phase) |
| R2 | **P0** | M | H | Mass-delete guard fails on a vanished mount → library wiped | A |
| R3 | **P0** | H | M | Mixed timestamp units in existing DBs corrupt imported data | A + D |
| R4 | P1 | M | H | S2 fails the Tauri bars → toolkit flip cost lands mid-plan | Pre-A (S2) → B/C |
| R5 | P1 | H | M | safeStorage nhentai key unrecoverable on import | D |
| R6 | P1 | M | H | PDF rasterise fallback gap after poppler removal | A (conv.) / D (pack.) |
| R8 | P1 | M | H | Template-engine behavioural drift vs 1.x | A |
| R9 | P1 | M | H | Windows path/UTF-16 `OsStr` hazards in filename rules | A (tests), CI (Win) |
| R14 | P1 | M | H | Single self-hosted Linux runner unavailable | D (all CI) |
| R15 | P1 | M | H | Golden-corpus fragility (network mount, Q5 breadth open) | A entry |
| R7 | P1 | M | M | convertAllMetadata resumability regression during port | A |
| R10 | P1 | M | M | Kavita API version drift (Q1 unknown) breaks client/suite | A/B |
| R16 | P1 | L | H | Differential testing touches live systems (id 5, prod DB, real mount) | A/B practice |
| R11 | P2 | M | M | 1.x feature-freeze violations / scope creep during the port | standing |
| R12 | P2 | M | M | Single-maintainer bus factor / corpus drift vs implementation | standing |
| R13 | P2 | H | L | Tag substring over-match "fix" tempting mid-port | A |
| R17 | P2 | L | H | Updater signing-key loss bricks auto-update for installed users | D |
| R18 | P2 | M | L | WebKitGTK fragmentation on user distros | C/D |

## 3. Entries

### R1 — Metadata byte-parity regression (P0)
**Risk.** Any regression in the 12 write paths invalidates libraries written by 2.x; byte parity is the port's core contract.
**Evidence.** 07-metadata-spec §1/§6; 10-test-plan §2–§3; S1/S3/S4 PASS (06 §1).
**Early warning.** Any `differential_matrix` cell diff; a fuzz mismatch shrinking to a fixed vector; a phase-gate re-run turning red after a later-phase commit.
**Mitigation.** Differential harness + golden corpus as the standing Phase A gate (`scripts/port/phase-a-gate.sh`), re-run in CI every later phase (09 standing rules); parity over numbers (05 §5); fixes land in `kopibon-core`, never by redefining parity.

### R2 — Mass-delete guard failure on a vanished mount (P0)
**Risk.** If the removal pass treats a post-failure empty mountpoint as a real empty library, one scan deletes every row (and its Kavita mirror) — the highest-consequence non-metadata test in the port.
**Evidence.** 10-test-plan §5 (triple guard, zero deletions asserted); `library-scanner.worker.ts:972-1044`; 02-scanner plan §8, §13 (walkdir per-level error reporting is the flagged risk).
**Early warning.** Rust scan not surfacing a per-directory error where 1.x recorded `failedDirs`; any removal-guard test deleting > 0 rows.
**Mitigation.** All three guard tests (`removal_guard`, SC-02) on a synthesised tree and a golden-corpus clone; nested-depth `chmod 000` mandatory; if walkdir cannot report per-dir failures, manual recursion is the fix — never a weaker guard (10 §5).

### R3 — Mixed timestamp units corrupt imported data (P0)
**Risk.** Real DBs hold milliseconds (`Date.now()` defaults, `seedDefaults`, the `sync_queue` claim/finish path) beside `unixepoch()` seconds in the same `*_at` columns; a port assuming one unit mis-sorts, mis-prunes or rewrites old rows.
**Evidence.** 03-data-model §6.4, §10 rule 5 ("tolerate both units; do not 'fix' old rows"); S6 confirmed the mix live (06 §1).
**Early warning.** Any timestamp cast/newtype in review without unit detection; import-matrix sort-order diffs on seeded ms/s rows.
**Mitigation.** `Timestamp` newtype tolerates both on read; new rows write seconds; no row rewritten — 09 §Phase D exit 3 seeds both units and asserts no rewrite; DB parity suite on the byte copy.

### R4 — S2 fails the Tauri bars → toolkit flip cost (P1)
**Risk.** An S2 failure on M1/M2 (compositing/memory) or M6 (Japanese) triggers the fallback ladder (egui → GTK4/relm4) and re-opens the full ledger-rebuild cost after planning priced Tauri's renderer reuse.
**Evidence.** 06-technology-decision §6–§7 (bars, ladder); 05 §4 (S2 row still "not yet run").
**Early warning.** S2 slipping past Wave 3; any partial M1/M2/M6 failure in the first S2 run.
**Mitigation.** Core stays toolkit-independent by construction (a flip discards only the shim + command layer, 09 §Phase B rollback); 08-GUI §8 carries the egui fallback sketch; targets renegotiated with the user if all candidates fail the perf bars (06 §7).

### R5 — safeStorage key loss on import (P1)
**Risk.** The nhentai API key is an Electron `safeStorage` (Chromium `os_crypt` "v11") blob not decryptable from Rust; the 1.x→2.x import cannot carry it.
**Evidence.** S5 (06 §1); 09 §Phase D work item (2); D4 side-by-side softens (1.x keeps its key either way).
**Early warning.** Any path claiming to decrypt or migrate the blob; the import matrix forgetting the "absent nhentai key" expectation.
**Mitigation.** First-run re-entry prompt ("the re-entry prompt appears once" is a demo assertion, 09); non-destructive import with sha256 proof (09 exit 2); `upgrade.md` documents re-entry; the Kavita key imports cleanly via verbatim `decryptKey` (app-level AES).

### R6 — PDF rasterise fallback gap after poppler removal (P1)
**Risk.** D3 removes poppler; the lossless DCTDecode path is proven (S4 16/16) but the `pdftoppm` rasterise fallback for non-DCTDecode pages has no Rust replacement — those PDFs convert lossy or fail.
**Evidence.** S4 caveat (06 §1, §8 — pdfium-render/mupdf named options); Q2 options (16-open-questions).
**Early warning.** Golden-corpus/production pages the conversion differential cannot reproduce losslessly; a bundled rasteriser pushing the ≤ 80 MB budget (05 §1).
**Mitigation.** Decide pdfium-render vs mupdf at the packaging plan, sized against the budget (06 §8); if unresolvable, Q2's options go back to the user — never a silent quality cut; CV-01 keeps the lossless path honest.

### R7 — convertAllMetadata resumability regression (P1)
**Risk.** 1.x runs it off an in-memory array (non-resumable, Q6); the port's default is a DB-backed resumable `metadata_queue` — a deliberate deviation that must not silently regress to 1.x behaviour or to neither (queue rows without resume).
**Evidence.** Q6 (16-open-questions); 06-conversion-pipeline plan §5 (decision + "a ledger P2 row is required"); 10 §6 kill-test row.
**Early warning.** `metadata_job.rs` landing without its ledger §9 row; CR-01 missing a kill point for this queue.
**Mitigation.** Ship the deviation with its ledger row at Phase A exit (06-conversion §exit 4); SIGKILL mid-run resume test mandatory; the test documents that 1.x would have restarted from scratch.

### R8 — Template-engine behavioural drift (P1)
**Risk.** The engine feeds every write path; subtle drift (whitespace, optional lines, sections, error strings) passes casual tests and breaks byte parity in the field.
**Evidence.** 07-metadata-spec §2; fuzz regime seeded with 26 template + 58 mapper cases, ≥10k generated cases per CI run, nightly 1M soak (10-test-plan §3; 01-metadata plan §8).
**Early warning.** CI fuzz count dropping below 10k; error-string equality dropped from a differential assertion; a shrunk vector "fixed" by weakening the seed.
**Mitigation.** TA-01/TA-02/MA-01 as hard Phase A gates including error strings (1-based line numbers are load-bearing, 07 §2); nightly soak clean three consecutive runs before the gate is first declared (09 §Phase A exit 2).

### R9 — Windows path/UTF-16 OsStr hazards in filename rules (P1)
**Risk.** JS strings are UTF-16, Rust `String` is UTF-8 and Windows paths are UTF-16 `OsStr`; the 255-byte rule and the sanitiser triplet can truncate mid-code-point or mismeasure on Windows.
**Evidence.** 07-metadata-spec §7 (the named Rust hazard); FN-01 boundary vectors (251–255 bytes, Japanese titles).
**Early warning.** Windows CI failing only filename tests; any `to_string_lossy()` in filename code under review.
**Mitigation.** FN-01 runs on the Windows runner (the reason 1.x ran `npm test` there: platform-only failures, `test.yml:123-127`); code-point-safe truncation asserted; no lossy conversions in the filename path.

### R10 — Kavita API version drift (P1)
**Risk.** The server version is unknown (Q1); endpoint behaviour differs across Kavita releases and the proxy injects the version segment (direct `:8080` rejects unversioned routes) — client and suite could be built on assumed behaviour.
**Evidence.** 16-open-questions Q1 (open); 07-sync-and-kavita plan §6 and its risk table ("version drift changes endpoint behaviour").
**Early warning.** The suite declared normative before Q1 closes; any test hitting `:8080`; a Kavita upgrade on `kavita.bragi.internal` between runs.
**Mitigation.** Pin the version in 16/Q1 and 07 §6 before the suite is normative; the endpoint table cites exact routes so a diff is mechanical; KV-01/KV-02 re-runnable; never depend on `:8080`.

### R11 — 1.x feature-freeze violations / scope creep (P2)
**Risk.** D8 freezes 1.x: any 1.x change made to unblock the port invalidates the differential baseline and the frozen-target ledger; "fix code" doc-drift dispositions tempt 1.x edits.
**Evidence.** 09 standing rules (D8); 17-doc-drift header ("feature-freeze on 1.x means no 1.x change").
**Early warning.** Any non-docs commit on 1.x branches during the port; a PR touching `src/main/` instead of the port tree.
**Mitigation.** Implementation lives in `kopibon-core`/`src-tauri/`, never an edit of `src/main/` (corpus rule); branch enforcement keeps direction (11 §1); discovered behaviour changes go through ledger §9, not 1.x.

### R12 — Single-maintainer bus factor / corpus drift (P2)
**Risk.** One maintainer means context loss between sessions; the corpus can drift from the implementation it describes, producing confident-but-wrong porting decisions.
**Evidence.** 16's lifecycle rules; 17's re-verification note; 10 §7 rule 4 (`CHECKLISTS/tests.md` regenerable, checker-verified).
**Early warning.** A doc cite failing re-verification during implementation; checklists not regenerating; decision conditions left pending past their phase (06 §7 checklist).
**Mitigation.** Line-specific citations so drift is detectable; machine-checkable phase gates; checklists mirror specs and are checker-enforced; uncertain facts marked, not invented (06 §9); decisions amended at the moment of decision.

### R13 — Tag substring over-match fix tempting mid-port (P2)
**Risk.** Filter `maid` matching tag `maids` is accepted 1.x behaviour (substring LIKE over a comma-joined column); "fixing" it mid-port changes saved-filter row sets and breaks Phase A parity. The fix is explicitly post-cutover and flag-gated.
**Evidence.** USER DECISION, 05-database-layer plan §6 ("nothing in the Phase A build may silently change match semantics"); 03-data-model §9, §10.9.
**Early warning.** Any PR adding a tag join table, comma-split in SQL, or FTS during Phases A–C.
**Mitigation.** Preserve verbatim in Phase A (DB-02 asserts identical rows, over-match included); revisit behind a `tagExactMatch` flag with a migration, post-cutover only.

### R14 — Self-hosted runner availability (P1)
**Risk.** Every Linux release build depends on the one `doujin-builder-01` container on a single home-lab Docker host ("There is one self-hosted runner", `test.yml:19-21`); runner down = no releases.
**Evidence.** `ci/runner/*` (compose, runbook); `test.yml:22-24` (jobs queue rather than parallelise).
**Early warning.** Queued runs with no runner online; registration 401/403/404 in the entrypoint log; disk pressure (10 GB budget, ci/runner/README).
**Mitigation.** Keep the runbook current (PAT scopes, triage table, rebuild command); token-per-start + `restart: unless-stopped` make recovery a `docker compose up`; PR CI runs on `ubuntu-latest` so code gates never depend on the runner (11 §4); D8 means an outage costs no release train.

### R15 — Golden-corpus fragility (P1)
**Risk.** The three golden fixtures live on a network mount (`/mnt/bragi/Kavita/DoujinsTest/`); Q5 breadth (CURRENT-BUILD captures for all 12 write paths, legacy samples, disposable clone) is open. A mount loss or unresolved Q5 starves the differential suite.
**Evidence.** 10-test-plan §1.3 ("network-mount risk"; copy read-only into the repo with sha256 provenance); 16 Q5.
**Early warning.** Phase A entry approaching with fixtures still only on the mount; provenance manifests missing for any captured artefact.
**Mitigation.** Copy read-only into the repo test area with sha256 provenance before Phase A starts (09 §Phase A entry); close Q5 with the user's go-ahead; a drifted fixture is a corpus bug, not a test to chase (10 §8 rule 3).

### R16 — Testing blast radius on live systems (P1)
**Risk.** The differential and acceptance suites run near production material: library id 5 (5287 files) shares the Kavita server; the live production DB and real mount exist. One wrong library id or write target destroys user data.
**Evidence.** 10-test-plan §4 (KV-02 id-5 counts before/after every test), §8 rule 2 (forbidden targets); 07-sync-and-kavita plan §6 ("MUST NEVER be scanned, mutated or deleted").
**Early warning.** Any harness helper without a library-id guard; any test referencing the real mount as a write target; id-5 counts differing once.
**Mitigation.** Every mutating helper takes a library id and refuses 5; pre/post count assertions fail the whole run; the production DB is touched only through its byte copy (09 §Phase B).

### R17 — Updater signing-key loss (P2)
**Risk.** `tauri-plugin-updater` verifies signatures against the embedded public key; losing the private key (or password) means every installed 2.x updater rejects all future releases until a new public key ships out-of-band.
**Evidence.** 11-ci-release-plan §6 (keys adopted per 08-GUI §2.3, 09 §Phase D).
**Early warning.** Secrets in only one place; no test-signed artifact ever verified against the public key; password unrecorded.
**Mitigation.** Generate at Phase D entry; private key + password in GitHub secrets with a recovery note; CHECKLISTS/release.md item (d): test-signed artifact verified.

### R18 — WebKitGTK fragmentation on user distros (P2)
**Risk.** Under the Tauri primary, Linux rendering depends on the system webkit2gtk; version/fractional-scaling variance across user distros is an unmeasured support surface.
**Evidence.** 06-technology-decision §5.1, §9 (unverified items); 08-gui-app-shell §10 ("support-matrix item for the packaging plan").
**Early warning.** Beta-channel rendering/scaling reports on specific distros; S2 M6/M7 anomalies attributable to the WebKitGTK version.
**Mitigation.** Document a WebKitGTK version floor in the support matrix at Phase D; the beta channel (existing ReleaseChannel mechanism) is the early-exposure feed; a webkit-level failure re-runs S2 on newer WebKitGTK before leaving the web cluster (06 §7).

## 4. Standing review

The register is reviewed at every phase gate: tiers re-scored, mitigations verified against their
early-warning detectors, closed risks moved out with the evidence. New risks enter with the same
five fields — no entry without a citation.
