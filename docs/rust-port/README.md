# Kopibon → Rust port — planning corpus

The document set a separate implementation agent executes from. Branch:
`rust_conversion`. No file outside this directory is modified by the corpus.

## Reading order

| # | Document | What it is |
|---|---|---|
| 00 | [00-executive-summary.md](00-executive-summary.md) | One-screen brief for anyone joining the port |
| 01 | [01-current-architecture.md](01-current-architecture.md) | The 1.x system as it is: processes, workers, data flow |
| 02 | [02-ipc-surface.md](02-ipc-surface.md) | All 144 IPC channels with payloads and semantics |
| 03 | [03-data-model.md](03-data-model.md) | Real DDL, schema drift, queue state machines, non-DB state |
| 04 | [04-parity-ledger.md](04-parity-ledger.md) | Every user-visible surface, grouped by parity level |
| 05 | [05-baselines.md](05-baselines.md) | Measured 1.x baselines and the numeric targets 2.x must beat |
| 06 | [06-technology-decision.md](06-technology-decision.md) | GUI toolkit matrix, scored against the spikes |
| 07 | [07-metadata-spec.md](07-metadata-spec.md) | **The contract.** Template engine, field matrix, parity levels |
| 08 | [08-subsystem-plans/](08-subsystem-plans/) | One plan per subsystem (8 documents) |
| 09 | [09-migration-phases.md](09-migration-phases.md) | Strangler phases A–D with entry/exit criteria |
| 10 | [10-test-plan.md](10-test-plan.md) | Golden corpus, diff levels, Kavita acceptance |
| 11 | [11-ci-release-plan.md](11-ci-release-plan.md) | Build, CI, release channels for 2.x |
| 12 | [12-risk-register.md](12-risk-register.md) | Ranked risks with owners and mitigations |
| 13 | [13-licence-audit.md](13-licence-audit.md) | Rust dependency licence audit vs GPL-3.0 |
| 14 | [14-task-breakdown.md](14-task-breakdown.md) | Work items, dependencies, estimates |
| 15 | [15-agent-playbook.md](15-agent-playbook.md) | How an implementing agent should run Phase A |
| 16 | [16-open-questions.md](16-open-questions.md) | Unresolved questions with recommendations |
| 17 | [17-doc-drift.md](17-doc-drift.md) | Where 1.x docs contradict 1.x source |
| 18 | [18-future-work.md](18-future-work.md) | Deliberately deferred, with triggers to revisit |

`CHECKLISTS/` holds 7 operational checklists referenced by the documents.

## Input material

Discovery notes live in `plans/kopibon_rust_port/` and are input, not output:
`00-planning-plan.md` (decisions D1–D8, spike backlog, acceptance criteria),
`discovery-01-metadata.md`, `discovery-02-backend.md`,
`discovery-03-ui-build-drift.md`. Where this corpus and a discovery note
disagree, this corpus wins.

## Locked decisions

D1 toolkits scored fairly · D2 byte parity for ComicInfo/`/Keywords`/ZIP, XMP
gated on spike S1 · D3 zero external tools · D4 side-by-side install · D5
desktop only · D6 correct PDF values (Info dict = semantic parity) · D7 legacy
`Notes` read but never rewritten · D8 1.x feature-frozen.

## Verified test environment

- Kavita: `http://kavita.bragi.internal` (port 80), auth header
  `x-api-key: <plugin key in plans/kopibon_rust_port/kavita_server.txt>`,
  unversioned `/api/...` routes. Port 8080 speaks versioned routes — do not use.
- Library **Doujin-Test (id 6)** maps to `/kavita/doujinstest`
  (`/mnt/bragi/Kavita/DoujinsTest`), never scanned (clean slate).
- Three golden fixtures in that folder, produced by 1.x on 2026-09-05 and known
  good in Kavita (see `10-test-plan.md`).
