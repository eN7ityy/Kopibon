# Production-DB byte copy — provenance (09 Phase A entry; 05-DB plan §3)

Byte copy of the production `~/.config/kopibon/db.sqlite` taken on 2026-09-05
at Phase A start (WP-A1). **Never the live file**: all DB-01/DB-02 tests run
against this copy, opened read-only or on a scratch re-copy per test — this
file itself stays `chmod 444` and is only ever read.

| Property | Value |
|---|---|
| sha256 | `70ea1a1fc2f2e3b47aa10a6f9bd6f2d8afbf3d2f168ead407db2cb26546baea1` |
| Size | 82 247 680 B |
| `library_item` rows | 5261 |
| `sqlite_master` tables | 14 + `sqlite_sequence` |
| `PRAGMA integrity_check` | `ok` (re-verified after copy) |
| Journal mode at copy | WAL, checkpointed — no live `-wal` file |
| Source app | Kopibon 1.0.2 |

The live production DB is never opened by any test or harness (10 §8 rule 2;
KV-02/R16 are about the Kavita server's library id 5). Tests that need a
writable DB copy re-copy this file into a temp dir first.
