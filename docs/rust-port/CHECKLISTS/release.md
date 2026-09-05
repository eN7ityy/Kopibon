# CHECKLISTS — Release pre-flight

Owns the pre-flight list of [../11-ci-release-plan.md](../11-ci-release-plan.md) §8 (which is §8's items (a)–(g));
licence gate recorded by reference from [../13-licence-audit.md](../13-licence-audit.md) §7. Nothing ships until every box is ticked.

## Version and tags ([../11-ci-release-plan.md](../11-ci-release-plan.md) §5)

- [ ] Beta version is `X.Y.(Z+1)-beta.run_number`, resolved once in the `version` job — not `npm version prerelease` (checkout wipes the tree; `run_number` is the differentiator, 11 §1)
- [ ] `scripts/port/set-version.sh` rewrote both `tauri.conf.json` and workspace `Cargo.toml` (same `--allow-same-version` semantics; nothing committed from the job)
- [ ] Stable tag `v*` is the version source of truth; tag landed on `main` (branch enforcement makes "tag = tested main" true)
- [ ] 2.x releases emit **no electron-updater manifests** (`latest.yml`/`latest-linux.yml`) — only Tauri's signed `latest.json`, so frozen 1.x updaters find nothing new (D8 coexistence, 11 §6)

## Gates green ([../11-ci-release-plan.md](../11-ci-release-plan.md) §3)

- [ ] `cargo test --workspace` green on Linux (self-hosted) **and** Windows (`windows-latest`) in the release workflow
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` green (CI gate from first commit; local commits never gated)
- [ ] `cargo fmt --all -- --check` green
- [ ] `cargo deny check advisories licenses sources` green — any crate outside the 13 §5 table fails until table + allow-list are amended
- [ ] `scripts/port/phase-a-gate.sh` exit 0 (regression gate re-runs from Phase A onward)
- [ ] `npm run contract:bridge` 144/144 (from Phase B onward)
- [ ] Workflow hygiene held: `rm -rf dist` first on release jobs, `merge-multiple: true`, `fail_on_unmatched_files: true`, `if-no-files-found: error`, `tag_name` as expression, Windows steps `shell: bash` (11 §1)

## Notices — fresh, every run ([../11-ci-release-plan.md](../11-ci-release-plan.md) §3.2; 13 §1, §3)

- [ ] `cargo about` regenerated `THIRD-PARTY-NOTICES.md` from `Cargo.lock` this run; CI failed-on-diff if stale (fixes the 1.x stale-notices defect: generator only ran on the Windows build path)
- [ ] Document structure reproduced: summary table, **copyleft section renders empty** (libvips gone — 13 §6 acceptance check), per-crate licence text
- [ ] `LICENSE` + `THIRD-PARTY-NOTICES.md` travel-with in every artifact (`bundle.resources`; verified unpacked in NSIS and AppImage — 13 §4)

## AGPL / licence gate ([../13-licence-audit.md](../13-licence-audit.md) §7 — human backstop to the CI gate)

- [ ] Generated notices match `Cargo.lock` exactly
- [ ] Crate table in 13 §5 is current; every new crate added to the table **and** the `cargo deny` allow-list before merge
- [ ] No GPL/AGPL (AGPL = blocker pending review) or non-standard-licence crate entered without the licence review gate
- [ ] MPL crates, if any, recorded with files separable (13 §2); `ring` OpenSSL attribution present if selected

## Updater signing keys ([../11-ci-release-plan.md](../11-ci-release-plan.md) §6)

- [ ] Minisign keypair present: public key in `tauri.conf.json`; `TAURI_SIGNING_PRIVATE_KEY` + password in GitHub secrets
- [ ] A test-signed artifact verified against the shipped public key (losing the private key bricks all future updates for installed apps)
- [ ] Recovery note exists (regeneration + new-public-key rollout procedure)

## Channels and publish gate ([../11-ci-release-plan.md](../11-ci-release-plan.md) §6)

- [ ] Beta channel: push to `test` → prerelease (`prerelease: true`, `generate_release_notes: true`), concurrency group `test-release`, serial, `cancel-in-progress: false`
- [ ] Stable channel: tag `v*` → **draft** release; **Publish is the manual human gate** — verify tauri-plugin-updater ignores drafts like electron-updater did, else the checklist owns the publish step
- [ ] Channel sanity: Settings → Advanced stable/beta switch maps onto updater config; `autoDownload=false` preserved (check → explicit download → install; no background download ever)
- [ ] Updater end-to-end green against a staged release feed with explicit user action before download (09 Phase D exit 4)

## Package budgets and final gates ([../11-ci-release-plan.md](../11-ci-release-plan.md) §8; [../05-baselines.md](../05-baselines.md) §1)

- [ ] Artifact sizes within budgets: ≤ 80 MB unpacked, .deb ≤ 60 MB, .rpm ≤ 55 MB
- [ ] `app:checkToolchain` reports **zero** external tools (D3)
- [ ] Phase A+B+C gate set re-run on the **packaged** build (09 Phase D exit 5)
- [ ] `cargo test --test import_matrix` green (09 Phase D exit 1)
