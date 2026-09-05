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

- [ ] **SC-01** | Scanner row-for-row vs live 1.x scan | semantic (excl. timestamps) | golden + LEGACY | `cargo test --test scanner_differential`
- [ ] **SC-02** | Removal triple guard (3× zero deletions + happy path) | invariant | synth tree + disposable clone | `cargo test --test removal_guard`
- [ ] **DB-01** | Migration zero-surprise on production copy | invariant | prod-DB byte copy | `cargo test --test db_differential migration`
- [ ] **DB-02** | Read parity over filter × sort matrix | semantic | prod-DB byte copy | `cargo test --test db_differential read`
- [ ] **DL-01** | Download pipeline vs 1.x, scripted CDN/failure ladder | semantic + byte artefacts | fixture server | `cargo test --test download_differential`
- [ ] **CV-01** | Golden PDF→CBZ conversion + verify gate both ways | byte | fixture 3 | `cargo test --test conversion`
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
