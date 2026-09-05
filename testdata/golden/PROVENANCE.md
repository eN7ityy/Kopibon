# Golden fixtures — provenance (R15, 10-test-plan §1.3 / §8 rule 3)

Copied read-only (chmod 444) from `/mnt/bragi/Kavita/DoujinsTest/` on
2026-09-05 at Phase A start (WP-A1). That mount is **never a write target**
(10 §8 rule 2); these copies are the byte targets for the writer suites and
scanner inputs. Produced by 1.x (Kopibon 1.0.2, Electron/pikepdf pipeline),
known good in Kavita (library Doujin-Test, id 6).

| File | sha256 | Size | Role |
|---|---|---|---|
| `DEMONBANE FANZIN Vol. 1_ DEMONBANE CAUSAL SEQUENCE [nhentai-528499].cbz` | `8a8dd331f7a10b1ff226fb230c14cb86244f06648f25b6aec0f0ba7136236549` | 22 050 395 B | Fixture 1: 51 entries (ComicInfo + 50 pages), one-shot, parody `demonbane` as SeriesGroup, `LanguageISO ja`, **legacy** Notes string (07 §11) |
| `Red Crais - Part 1 - [nhentai-527515].cbz` | `89323a3e8c3a5f7d07fe8291bd8fa1e3385b89bf45b35937a23cddfb28bd7472` | 10 832 282 B | Fixture 2: 36 entries, publisher present (circle as publisher), characters, 2-tag+parody Genre |
| `Kaijou Gentei Omakebon [nhentai-527302].pdf` | `748339eff1d0bffeac0b41b5a19945b46a1833159187c01945d47baff04eca95` | 6 687 740 B | Fixture 3: 16 pages, Info dict `/Author (shaa)`, pdf-lib `/Creator`, 7-token `/Keywords`, `/Producer (pikepdf 10.8.0)`, `/Trapped (/False)`, XMP packet 1782 B, no calibre block |

Notes:

- ComicInfo byte-parity tests against fixtures 1–2 **exclude/normalise the
  `Notes` line** (Q11; 07 §11) — the fixtures predate the rebrand and D7 keeps
  the current product string in writer output.
- Template set at capture: `resources/metadata-templates/`
  (`comicinfo.template`, `pdf-xmp.template`), committed in this repo.
- Volatile fields were **not** injectable at capture time (real 1.x run), so
  the XMP `MetadataDate` / Info dates / ZIP mtimes inside these files are the
  frozen values the Rust tests inject (07 §9) — the WR-02 golden packet is
  compared after injecting the fixture's own volatile values, not the wall
  clock (10 §8 rule 1).
- A drifted fixture is a corpus bug (10 §8 rule 3): re-verify these hashes
  against the mount before touching them.
