# 11 — CI and release plan (2.x)

The CI, packaging, updater and release-channel plan for the Rust port. Owns
Phase D work item (1) — packaging and updater ([09-migration-phases.md](09-migration-phases.md)
§Phase D); the interface with the GUI plan is fixed in
[08-subsystem-plans/08-gui-app-shell.md](08-subsystem-plans/08-gui-app-shell.md)
§5 (bundler targets, updater plumbing, icons, D3 size win live here). Licence
mechanisms are specified in [13-licence-audit.md](13-licence-audit.md) and
enforced here. Evidence for 1.x behaviour: discovery-03 §B, verified against
`.github/workflows/*`, `ci/runner/*`, `electron-builder.yml`, `package.json`.

Toolkit note: everything below is written against the Tauri v2 conditional
primary ([06-technology-decision.md](06-technology-decision.md) §7, S2-gated);
the fallback-ladder deltas are in §6.

---

## 1. What survives from 1.x unchanged

| Mechanism | 1.x evidence | 2.x disposition |
|---|---|---|
| Branch-enforcement gate: `test` accepts only `dev`, `main` only `test`; `edited` PR type catches base retargeting | `.github/workflows/branch-enforcement.yml:14-17, :23-38` | Carry over verbatim, no changes |
| Beta pipeline shape: push to `test` → version job → Linux + Windows builds → GitHub **prerelease**; `permissions: contents: write`; serial `concurrency: test-release, cancel-in-progress: false` (one runner, predictable ordering) | `test.yml:9-24` | Same shape, new build steps (§4) |
| Version scheme `X.Y.(Z+1)-beta.run_number`, resolved **once** in a `version` job so both platforms cannot disagree | `test.yml:27-62` | Kept; computed against the 2.x version source (§5) |
| **Why `run_number`, not `npm version prerelease`**: checkout wipes the tree each run, so `npm version` recomputed the same value and silently overwrote the previous pre-release; the patch is bumped first so the beta sorts *above* the last stable | `test.yml:46-55` | Rationale carried into the 2.x script; do not "simplify" back to `npm version` |
| Stable pipeline: tag `v*` → **draft** release; pressing Publish is the intended user-facing gate because electron-updater cannot see drafts | `release.yml:3-6, :115` | Draft + Publish gate preserved; tauri-plugin-updater's draft behaviour verified at adoption (§6) |
| Release-job hygiene: release job does not check out → `rm -rf dist` first (stale self-hosted workspace files are merged in by `download-artifact` otherwise); `merge-multiple: true`; `fail_on_unmatched_files: true` (softprops is silent on unmatched globs by default); `tag_name` passed as an expression, never shell-built | `test.yml:150-180`, `release.yml:99-120` | Carried verbatim into both release workflows |
| `if-no-files-found: error` on artifact upload — a missing update manifest must fail the run, not ship a release that cannot auto-update | `test.yml:90-98` | Carried; the 2.x manifest set is §6's |
| Windows jobs run `shell: bash` for any `${VAR#v}`-style expansion — the default PowerShell takes it literally | `test.yml:129-130`, `release.yml:80-81` | Standing rule for all 2.x Windows steps |
| Self-hosted runner: registration token minted from a PAT at **every** start (tokens expire ~1 h) with named 401/403/404 triage; `config.sh --unattended --replace`; `exec ./run.sh` so SIGTERM reaches the runner | `ci/runner/entrypoint.sh:5-8, :32-60` | Unchanged |
| Runner labels `linux,doujin-builder` must match `runs-on`; `self-hosted` is implicit and rejected if listed; unqualified image name (Portainer "Pull latest image" stays off); no Docker socket mounted | `docker-compose.yml:16-30`, `ci/runner/README.md` | Unchanged |
| `APPIMAGE_EXTRACT_AND_RUN: '1'` — appimagetool needs FUSE the container does not have | `docker-compose.yml:32-36` | Unchanged (Tauri's Linux bundling still shells to appimagetool) |
| Named volumes `_work`/`.npm`/`.cache`, pre-created runner-owned in the image so volumes inherit ownership; `stop_grace_period: 5m` | `docker-compose.yml:44-54`, `Dockerfile:40-48` | Extended with cargo volumes (§7) |

**1.x gates for the record:** typecheck + `npm test` on Linux, `npm test` on
Windows, lint **never** a gate (`eslint` exits non-zero on a pre-existing
backlog, `test.yml:80-82`), and branch-enforcement was the only PR-time check —
it neither built nor tested (discovery-03 §B2).

## 2. Toolchain

1. **`rust-toolchain.toml` at the repo root** pins the channel plus `clippy`
   and `rustfmt` components. It is the single version authority: dev shells,
   CI (`actions-rust-lang/setup-rust-toolchain` reads it), and the runner
   image all resolve through it. Pin the channel measured in
   [05-baselines.md](05-baselines.md) (rustc/cargo 1.97) at Phase A start;
   bumps are ordinary reviewed PRs.
2. **Matrix: Linux + Windows, no macOS.** Linux builds on the self-hosted
   runner (`[self-hosted, linux, doujin-builder]`); Windows on
   `windows-latest` — 1.x used a native Windows runner because cross-compiling
   silently mis-resolved platform binaries and sharp failed **silently**
   (`test.yml:105-110`); Tauri has the same shape (WebView2/NSIS must be
   built on Windows). macOS stays permanently out (Q10, user-confirmed;
   same rationale as `electron-builder.yml:101-104`).
3. **Runner image** (`ci/runner/Dockerfile`): keep the pinned
   `actions-runner` base, `rpm fakeroot dpkg-dev binutils`; **add the Tauri
   Linux build deps** (`libwebkit2gtk-4.1-dev` and companions — Tauri links
   the system webkit2gtk, 06 §5.1) and rustup. Toolchains themselves are
   downloaded per `rust-toolchain.toml` into a cached volume, not baked in,
   so the pin above stays the only authority. Poppler/pikepdf remain absent
   (they were runtime deps of 1.x packages; D3 removes them entirely).

## 3. Gates

| Gate | Command | Where | 1.x counterpart |
|---|---|---|---|
| Tests | `cargo test --workspace` | Linux + Windows, both release workflows + PR CI | `npm test` on both platforms (`test.yml:84, :127`) |
| Clippy | `cargo clippy --workspace --all-targets -- -D warnings` | **CI gate, not a local-commit gate** (§3.1) | none — lint never gated |
| Format | `cargo fmt --all -- --check` | CI + PR | `prettier`, ungated |
| Advisories + licences | `cargo deny check advisories licenses sources` | PR + both release workflows | none |
| Notices freshness | regenerate `THIRD-PARTY-NOTICES.md` from `Cargo.lock`, fail on diff | **every CI run** (§3.2) | none — the 1.x defect |
| Regression gate | `scripts/port/phase-a-gate.sh` (differential matrix, fuzz, removal guards, DB parity, pumps) re-runs on every later phase | CI from Phase A onward | n/a |
| Bridge contract | `npm run contract:bridge` (144/144) | CI from Phase B onward | n/a |

**3.1 Clippy decision.** 1.x could not gate lint because eslint failed on a
large pre-existing backlog (`test.yml:80-82`) — gating would have failed every
run. 2.x starts from zero lines, so the same excuse does not exist: **clippy
`-D warnings` gates CI from the first commit**, keeping the backlog at zero
forever. Local commits are never gated (no hook blocks a commit); the gate is
the PR. Warning-lints are denied in `Cargo.toml` workspace lints so local and
CI behaviour agree; the "not for local commits" rule only means no pre-commit
enforcement.

**3.2 Notices generation is a REQUIRED CI step — the 1.x stale-notices defect
is fixed here.** In 1.x the generator ran only via `npm run build`
(`package.json:19`), which `build:win` reached but `build:linux`/
`build:appimage` skipped (`package.json:23-24`), and it never ran in CI — a
Linux-only dependency change shipped a stale `THIRD-PARTY-NOTICES.md`
(discovery-03 §B6; [13-licence-audit.md](13-licence-audit.md) §1). Tool choice
per 13 §3's open item: **`cargo about`** with a workspace `about.toml` +
template reproducing the 1.x document structure (summary table, copyleft
section — which must render **empty** for 2.x, the §6 acceptance check —
per-crate licence text). CI regenerates on every run and fails on a diff
against the committed file; generation is OS-independent because it reads
`Cargo.lock`, not an installed tree, so no platform split is possible.

**3.3 Advisories/licence tooling.** `cargo-deny` (single tool covering
RustSec advisories, the §7 licence allow/deny list of 13, and crate-source
policy) over `cargo-audit` + separate tooling. Any crate outside the 13 §5
table fails the licences check until the table and the allow-list are amended
— the AGPL gate of 13 §7, machine-enforced, with the
`CHECKLISTS/release.md` item as the human backstop.

## 4. Workflow inventory (2.x)

| Workflow | Trigger | Runner | Body |
|---|---|---|---|
| `branch-enforcement.yml` | `pull_request` (opened/synchronize/reopened/edited) | `ubuntu-latest` | Unchanged direction gate |
| `pr.yml` (new) | `pull_request` targeting `dev` | `ubuntu-latest` | fmt, clippy `-D warnings`, `cargo deny`, notices diff, `cargo test --workspace`; + `contract:bridge` from Phase B |
| `test-release.yml` | `push` to `test` | version + Linux on self-hosted; Windows on `windows-latest` | `version` job → `build-linux` (cargo test, clippy, `cargo about` check, `cargo tauri build` → AppImage/.rpm/.deb) + `build-windows` (cargo test, `cargo tauri build` → NSIS) → `release` job: prerelease, `prerelease: true`, `generate_release_notes: true` |
| `release.yml` | `push` tags `v*` | same split | Same builds, version from the tag; **`draft: true`**; Publish is the manual gate |
| `nightly.yml` (optional) | `schedule` | self-hosted | Fuzz soak (1M cases, 10-test-plan §3) + `cargo deny advisories` against live RustSec |

Both release workflows keep the 1.x concurrency groups (`test-release`,
`stable-release` — different groups, which is exactly why the `rm -rf dist`
guard exists, `release.yml:99-104`), `permissions: contents: write`, and the
`fail_on_unmatched_files: true` release step.

## 5. Versioning and tags

- Semver + prerelease suffixes are kept. Beta: `X.Y.(Z+1)-beta.run_number`
  from the `version` job (mechanism and rationale in §1). Stable: tag `v*`
  is the source of truth (`release.yml:44`).
- 2.x version lives in `tauri.conf.json` + workspace `Cargo.toml`; the
  `version` job rewrites both with a small checked-in script
  (`scripts/port/set-version.sh`, `--allow-same-version` semantics), replacing
  `npm version` — same write-and-don't-commit behaviour, but `run_number`
  (not the file) stays the differentiator per the §1 lesson.
- Tags still only ever land on `main`; branch enforcement (§1) is what makes
  "tag = tested main" true.

## 6. Release channels and the updater story (Tauri primary)

- **Channels preserved.** Settings → Advanced exposes stable/beta
  (`ReleaseChannel.tsx:14-49`, persisted immediately on change `:20`, default
  `stable`). 2.x maps `releaseChannel` onto `tauri-plugin-updater`
  `allowDowngrade`/prerelease configuration; the 1.x quirk that the channel
  "defaults from the version string only the first time it is read, before the
  setting exists" (`test.yml:5-8`) is re-derived deliberately, not copied.
- **Feed.** `tauri-plugin-updater` against the same GitHub releases
  (`publish: github eN7ityy/Kopibon`, `electron-builder.yml:146-149`). The
  electron-updater manifests (`latest.yml`/`latest-linux.yml`) are replaced by
  Tauri's signed `latest.json`; the artifact globs and
  `fail_on_unmatched_files` set follow.
- **`autoDownload=false` is preserved**: a check surfaces status, the user
  explicitly downloads, then installs — the 1.x `installUpdate`-gated flow
  (02-ipc-surface §2.10; 09 §Phase D, including cached-status-`null`-before-
  first-event). No background download, ever.
- **Signature keys.** The updater requires a minisign keypair: public key in
  `tauri.conf.json`, private key + password as GitHub secrets
  (`TAURI_SIGNING_PRIVATE_KEY*`), used by the build jobs to sign each
  artifact. Losing the private key means every installed updater rejects all
  future updates until a new public key ships — key generation, secret
  storage and a recovery note are CHECKLISTS/release.md items.
- **Publish gate.** Stable releases are still assembled as drafts; the human
  Publish action is the release gate. *Verify at adoption* that
  tauri-plugin-updater ignores draft releases the way electron-updater does
  (`release.yml:3-6`); if it does not, the workflow holds the release in
  draft and the checklist owns the publish step either way.
- **1.x coexistence (D8).** 2.x releases emit no electron-updater manifests,
  so frozen 1.x installs' updaters simply find nothing new — no separate feed
  or channel split is needed for the side-by-side window.
- Budgets: ≤ 80 MB unpacked, `app:checkToolchain` reports **zero** external
  tools (D3) — Phase D exit criteria (09 §Phase D, 05 §1).

## 7. Build caching

- **`windows-latest`:** `Swatinem/rust-cache` keyed on `Cargo.lock` + the
  toolchain pin.
- **Self-hosted:** persistent named volumes make cache invalidation the
  risk, so use **`sccache`** (`RUSTC_WRAPPER`) with its cache dir in a new
  named volume, plus a `runner-cargo` volume for `CARGO_HOME`/registry —
  mirroring the `.npm`/`.cache` pattern and its pre-created-ownership rule
  (`Dockerfile:47-48`). Job-local `target/` dirs under the existing
  `_work` volume; never share `target/` between jobs on the persistent
  workspace.

## 8. CHECKLISTS/release.md

The pre-flight list is owned by `CHECKLISTS/release.md` (planned deliverable
of this corpus; 13 §7 records its gate by reference). Items: (a) regenerated
notices match `Cargo.lock`; (b) the 13 §5 crate table is current; (c)
`cargo deny` licences job green; (d) updater signing secrets present and a
test-signed artifact verified; (e) release assembled as draft and Publish is
the manual step; (f) artifact sizes within the 05 §1 budgets; (g) Phase A+B+C
gate set re-run on the packaged build and the import matrix green (09 §Phase D
exit criteria).

## 9. Fallback deltas (if S2 unseats Tauri)

egui/relm4/Dioxus change only §6 and §4's build step: no
`tauri-plugin-updater` — a self-hosted update feed or OS-level packaging
update story is chosen at flip time and this section amended; the bundler
targets, gates, versioning, runner and notices machinery are toolkit-neutral
and survive unchanged. The WebKitGTK support-matrix item (08-GUI §10)
disappears with it; any replacement webview/toolkit runtime gets the same
support-matrix entry here.
