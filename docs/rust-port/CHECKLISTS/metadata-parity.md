# CHECKLISTS — Metadata-writing change

Operational checklist for **any** change to metadata writing (template engine, mappers, writers, filenames,
write paths). The contract is [../07-metadata-spec.md](../07-metadata-spec.md); this checklist keeps a change
from silently redefining parity ([../10-test-plan.md](../10-test-plan.md) §8 rule 5; [../15-agent-playbook.md](../15-agent-playbook.md) §1.3).

## 1. Artefacts touched (state the parity level before touching code — 07 §1)

- [ ] `ComicInfo.xml` — **byte-identical** (as written into CBZ; Notes line excluded per Q11 only for the three pre-rebrand golden fixtures)
- [ ] PDF XMP packet — **byte-identical** (1782 B golden; via exactly the two lxml normalisations: self-closed empty elements + newline tail — 07 §2/§10.1)
- [ ] `/Keywords` + Info dict — **semantic** (D6: `Producer = "Kopibon 2.x"`, `/Trapped /False` as a name — deviation, not defect)
- [ ] ZIP container — **byte-identical on every structural field** (S3: version-made-by 831, method 0, flags 0x0800/0x0808, UT extra CD-only, external attrs, no comment)
- [ ] Page image extraction — **byte-identical** for DCTDecode sources (S4)
- [ ] Whole-PDF bytes — **not a target**; never widen or narrow a level without a ledger §9 row

## 2. Golden fixtures that apply (07 §11; [../10-test-plan.md](../10-test-plan.md) §1)

- [ ] Fixture 1 `DEMONBANE FANZIN … [nhentai-528499].cbz` (51 entries, one-shot, legacy Notes)
- [ ] Fixture 2 `Red Crais - Part 1 - [nhentai-527515].cbz` (36 entries, publisher/characters)
- [ ] Fixture 3 `Kaijou Gentei Omakebon [nhentai-527302].pdf` (XMP 1782 B, Info dict, no calibre block)
- [ ] CURRENT-BUILD captures for the writer string assertion (`comicinfo.template:15`) — legacy corpus is never a byte target (D7)
- [ ] Fixtures are read-only, sha256-provenance'd; a drifted fixture is a corpus bug, not a failure to chase

## 3. Diff level + harness invocation ([../10-test-plan.md](../10-test-plan.md) §3; [../15-agent-playbook.md](../15-agent-playbook.md) §2.3)

- [ ] Every affected test names its level up front — a test that cannot name its level does not enter the inventory
- [ ] JS side run: `node tests/differential/harness.mjs <op> <context.json>` (real built 1.x modules from `dist/`)
- [ ] Rust comparison: `cargo test --test differential_matrix` (runner spawns both sides; compares error strings where JS throws — 1-based line numbers are load-bearing)
- [ ] Affected suites re-run: TA-01/TA-02/MA-01/WR-01/WR-02/WR-03/FN-01 as applicable + `python3 tests/zip/validate.py` for any CBZ
- [ ] Fuzz seeded over the change (≥10k cases/run; mismatch shrinks to a fixed vector); volatile fields injected per 07 §9 — no test reads the wall clock

## 4. No blank cells (07 §5)

- [ ] Every field of every artefact touched by the change has an explicit rule (ComicInfo, XMP, Info dict, `/Keywords` token order 1–6) — **no blank cells**: an unspecified field is a bug in the change, not a free choice
- [ ] All 12 write paths re-checked through the three shared context builders (`comicInfoContext`, `xmpContext`, `buildKeywordTokens` + `buildDocInfo`) — paths differ only in metadata source (07 §6)

## 5. Preserved quirks — do not "fix" ([../15-agent-playbook.md](../15-agent-playbook.md) §1.2; 07 §4, §7, §8, §12)

- [ ] `galleryId` 0 asymmetry: absent from template context (`?? ''`) but `nhentai:0` emitted in `/Keywords` (`!= null`) — the two guards deliberately disagree (mappers.ts:136-138 vs :272)
- [ ] **Three distinct sanitisers** never unified: download (`_`-substitute/180/suffix marker), custom-entry (delete/120/prefix marker), directory-segment (`_`/leading-dot-strip/180/`'Unknown'`)
- [ ] Legacy `Notes` (D7): `Tagged by Doujin Downloader — …` read and tolerated, **never rewritten unprompted**; writer always emits the current product string; both marker placements first-class inputs
- [ ] Also standing: mixed timestamp units (reads tolerate both, old rows never rewritten), tag substring over-match (Phase A verbatim), template error strings with 1-based line numbers, unspecified comma/colon `/Keywords` round-trip (write tests asserting current behaviour)

## 6. Sanctioned bug fixes — the only behaviour changes (07 §12)

- [ ] sharp's silent thumbnail failure → **loud** failure
- [ ] pikepdf's silent empty-metadata failure → **loud** failure
- [ ] (Noted, not ported: pikepdf `.tmp` path bypassing the 255-byte guard disappears with Python/D3)
- [ ] Any other behaviour change has a ledger §9 row **before or with** the code ([../15-agent-playbook.md](../15-agent-playbook.md) §1.3)

## Sign-off

- [ ] `bash scripts/port/phase-a-gate.sh` exit 0 after the change (gate re-runs at every later phase)
- [ ] `CHECKLISTS/tests.md` rows for affected suites ticked; `cargo test --workspace` green
