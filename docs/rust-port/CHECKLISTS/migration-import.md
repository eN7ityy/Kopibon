# CHECKLISTS — 1.x → 2.x import safety (D4, side-by-side)

Implements [../09-migration-phases.md](../09-migration-phases.md) §Phase D work item (2). New appId + new data
dir; on first run 2.x imports from the 1.x profile and **leaves 1.x untouched**. Machine gate: `cargo test --test import_matrix` (09 Phase D exits 1–3); test IM-01 in [CHECKLISTS/tests.md](tests.md).

## 1. 1.x data dir untouched — checksum proof (09 Phase D exit 2)

- [ ] sha256 manifest computed over the entire 1.x data dir **before** the import run
- [ ] Keychain probe recorded before import (what exists, encrypted blobs only — never decrypt for the probe)
- [ ] Import runs **copy-forward only**: 2.x never opens, writes, checkpoints or prunes anything inside the 1.x dir
- [ ] sha256 manifest + keychain probe re-computed after import — **identical, asserted not assumed**; any drift is a release blocker
- [ ] Proof captured in the import test output (IM-01 invariant) and in `upgrade.md`

## 2. DB copy-forward (09 Phase D; [../03-data-model.md](../03-data-model.md) §7.3, §10.1, §10.5)

- [ ] `db.sqlite` (+WAL) checkpointed **in a copy** and copied into the 2.x data dir — the 1.x file itself is never checkpointed
- [ ] Copy opened with the Rust migrator — zero schema surprises on an already-migrated DB
- [ ] `_migrated_*` sentinels preserved verbatim
- [ ] **Mixed timestamp units travel with the copy**: real DBs hold milliseconds (Drizzle module-load defaults, `seedDefaults`, `sync_queue` claim/finish) beside `unixepoch()` seconds — the port writes seconds, tolerates ms on read via the `Timestamp` newtype, and **never rewrites old rows**
- [ ] Mixed-units test green: DB seeded with both ms and s rows reads, sorts and displays correctly after import; no row rewritten (03 §10.5)
- [ ] `integrity_check ok` after import; re-run of import is idempotent

## 3. Key re-entry (S5 softened by D4; 07-sync plan §5.1, 05-DB plan §5)

- [ ] nhentai API key is Electron `safeStorage`/OS-keychain material — **not recoverable** from Rust; first run prompts re-entry exactly once
- [ ] Prompt appears once (not on every run) and is skippable without blocking other functionality
- [ ] Kavita key is app-level AES: `decryptKey` ported verbatim — the key imports cleanly, no re-entry
- [ ] 1.x keeps its own key either way (side-by-side: both apps can talk to Kavita/nhentai independently)

## 4. Preferences and paths (08-GUI §2.6; ledger D-localstorage-keys)

- [ ] `doujin-ui-store` + `doujin-search-history` localStorage keys imported or migrated per the D-localstorage-keys decision (resolved at Phase C)
- [ ] `onboardingCompleted` flows through the copied settings — importing user does not see the wizard
- [ ] **Library files are not copied**: settings point 2.x at the same library root, thumbnails and originals; only DB + prefs move
- [ ] Both apps run alternately against the same library (demo scenario) — safe because both use the byte-parity writers (a 2.x-written file is a legal 1.x file, Phase A matrix)

## 5. Rollback (09 Phase D)

- [ ] By construction: delete the 2.x data dir and uninstall 2.x — 1.x never had a byte touched (D4 + exit 2)
- [ ] Library files shared but only ever mutated through byte-parity writers — no rollback action needed on the library
- [ ] `upgrade.md` documents import, divergence handling and key re-entry (09 Phase D work item 3)

## Sign-off

- [ ] `cargo test --test import_matrix` green before any packaged release ([CHECKLISTS/release.md](release.md) final gate)
- [ ] Clean-machine demo done: install 1.x → populate → install 2.x beside it → import → use both alternately → 1.x profile byte-identical at the end
