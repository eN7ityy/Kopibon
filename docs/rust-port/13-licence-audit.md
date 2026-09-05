# 13 — Licence audit (C7)

Kopibon 1.x is GPL-3.0-or-later (`LICENSE`). This document audits the 2.x Rust
dependency set against that licence, plans notice generation for a Cargo
workspace, and records the compliance simplifications the port delivers. Every
licence claim for a 1.x component below is verified against
`tools/generate-notices.mjs` and `electron-builder.yml`; every claim for a Rust
crate comes from general knowledge of the crates.io ecosystem and is marked
**verify at adoption** unless stated — SPDX fields drift between major versions.

Covers C7 in the D1 criterion list (06-technology-decision.md §3, table row 7).

## 1. Baseline: 1.x obligations and how they are met today

**Obligation.** Distributing the AppImage/installer means distributing every
bundled dependency. MIT, BSD, ISC and Apache-2.0 all require the copyright
notice and licence text to travel with the binary. Without that, 1.x would ship
in breach of licences that are otherwise trivial to satisfy.

**How 1.x meets it — three mechanisms:**

1. **Generated notices file.** `tools/generate-notices.mjs` walks the installed
   `node_modules` tree from `package.json` `dependencies` **plus**
   `optionalDependencies` — the latter because native binaries ship that way; a
   dependencies-only walk missed `@napi-rs/canvas` (pulled in optionally by
   `pdfjs-dist`). It additionally sweeps the `@img` and `@napi-rs` scopes
   directly (scoped platform packages install as siblings on some npm versions)
   and walks `electron` explicitly, since Electron is a devDependency whose
   runtime ships in every artifact. Output: `THIRD-PARTY-NOTICES.md` with a
   licence-summary table, a dedicated **Copyleft components** section, and the
   full licence text per package.
2. **Travel-with shipping.** `electron-builder.yml:84-93` ships `LICENSE` and
   `THIRD-PARTY-NOTICES.md` as `extraResources` — outside the asar — because
   bundled deps require notice travel-with and the copyleft component (libvips,
   LGPL-3.0-or-later, via `sharp`'s `@img/*` binaries) needs its terms visible
   on disk, not buried in an archive.
3. **External-tools table.** The generated notices carry a "Tools invoked but
   not bundled" table for poppler (`pdfinfo`/`pdfimages`/`pdftoppm`, GPL), and
   pikepdf + Python 3 (MPL-2.0, PSF). They are shelled out to, not
   redistributed, so no notice obligation attaches — listed for completeness.

**Known 1.x defect.** `npm run notices` is chained only from `npm run build`
(package.json:19,23,30: `build` → `build:unpack`/`build:win`); `build:linux`
and `build:appimage` skip it, and the generator never runs in CI
(discovery-03 B6). A Linux-only dependency change ships a stale notices file.

**D3 is a compliance simplification, not just packaging.** D3
(00-planning-plan: "zero external tools") removes Python, pikepdf and poppler
from the 2.x runtime entirely. That deletes the whole "Tools invoked but not
bundled" table: no more reliance on user-installed GPL poppler binaries, no
documentation of the source-offer implications if poppler were ever bundled,
no PSF/MPL footnote for the pikepdf toolchain. 2.x ships one self-contained
GPL-3.0 binary whose only third-party components are Cargo dependencies.

## 2. The Rust dependency licence position

**The dominant case: permissive licences under a GPL app.** The crates named in
the subsystem plans are MIT/Apache-2.0 dual-licensed (most of the ecosystem),
with some MIT-only and ISC/BSD entries. Permissive licences impose **notice
preservation only** — keep the copyright notice and licence text in the
distribution. They impose **no copyleft propagation**: embedding them in a
GPL-3.0-or-later application changes nothing about either side. There is no
source-offer obligation from permissive deps beyond retaining their notices.

**MPL-2.0.** File-level (weak) copyleft: MPL-licensed source files must remain
available under MPL-2.0 if modified, but they may be statically linked into a
GPL-3.0 work without affecting the rest of the codebase — MPL 2.0 §3.3
expressly permits combining with a secondary licence under GPL compatibility
terms. Static linking inside an already-GPL app is fine. Record it in the
generated notices (the 1.x generator's copyleft regex already keys on `MPL`)
and note in the release checklist that MPL files stay separable. No crate in
the current plans is MPL-2.0; this paragraph exists so the first MPL dep is a
recorded decision, not a surprise.

**Slint (if the toolkit choice is ever re-scored away from Tauri, per
06-technology-decision §8).** Slint is offered as GPL-3.0-or-later OR a
royalty-free commercial licence OR a Slint-specific free licence. The GPL
option is licence-compatible here **and forces the whole app to GPL-3.0** —
consistent, because the app already is GPL-3.0-or-later, but it hardens
"GPL-3.0-or-later" from a choice into a constraint: a future proprietary
relicence would then require buying the commercial option. The royalty-free
commercial alternative exists as the escape hatch. Documenting this in advance
is the discipline the toolkit matrix asked for (06 §5.4).

**webview2-loader (Windows, Tauri only).** Tauri's Windows path links the
WebView2 loader (`webview2-com` / the shipped `WebView2Loader.dll`, MIT, part
of the `webview2-rs` family). MIT terms: notice travels in the generated file
plus the DLL's licence text. Mark **verify at adoption** which exact crates
(`webview2-com`, `webview2-com-sys`) land in the lockfile and reproduce their
notices like any other dependency.

**GPL-family toolkits already cleared:** GTK4 (LGPL-2.1+) and relm4 (MIT/Apache)
are the documented fallbacks; LGPL dynamic-link terms are satisfied in a GPL-3.0
app (06 §5.6). Only Slint changes anything structural, and it changes nothing.

## 3. Notice generation for the Cargo workspace

Replace `tools/generate-notices.mjs` with a Cargo-native generator. Name two
tools (choose one at adoption; no versions pinned here):

- **`cargo about`** — renders a template against the resolved dependency graph
  to produce a `THIRD-PARTY-NOTICES.md` equivalent, embedding full licence
  texts per crate. Preferred: it reads `Cargo.lock`, so it sees exactly what a
  release build contains, and supports per-licence templates (a "copyleft
  components" section, mirroring the 1.x output).
- **`cargo license`** — lighter-weight: prints the SPDX expression per crate
  for diffing in review. Use as the CI-side cross-check if `cargo about` is
  adopted.

Plan:

1. A workspace `about.toml` (if `cargo about`) with an HTML/Markdown template
   reproducing the 1.x document structure: licence summary table, copyleft
   section, per-crate licence text. Generated file lives at
   `THIRD-PARTY-NOTICES.md` in the repo root, same path as 1.x.
2. Generation is a **CI step, not a developer step**. The 1.x defect — notices
   regenerated only on the Windows path — is fixed by making CI run the
   generator on every build and **fail if the committed file differs from the
   freshly generated one** (or commit it from CI on the release branch). A
   Linux-only dependency change can then never ship stale notices, because the
   generation is OS-independent: it reads `Cargo.lock`, not an installed tree.
3. `cargo deny` (or `cargo-deny`'s `licenses` section) is an optional
   additional gate: a machine-readable allow/deny SPDX list so a
   GPL/AGPL-licensed crate fails the build rather than a review. Mark
   **verify at adoption** for exact config schema.

## 4. Runtime licence files travel-with

The `extraResources` equivalent, per toolkit (08-gui-app-shell):

- **Tauri v2 (primary):** `bundle.resources` in `tauri.conf.json` ships
  `LICENSE` and `THIRD-PARTY-NOTICES.md` beside the binary, outside the
  single-file executable payload — the direct analogue of
  `electron-builder.yml:84-93`. Verify at bundler-config time that the files
  land unpacked in the NSIS installer and the AppImage.
- **egui / Slint fallback:** ship the same two files as plain resource files in
  the packaging step of the chosen bundler (whatever doc 11's release plan
  specifies); the obligation is identical, only the mechanism differs.

The app should also expose the notices from a Help/About surface, as 1.x
effectively does by shipping them on disk — parity is not required here, but
the files must exist in every distributable artifact.

## 5. Crate-by-crate table

Licences below are from general knowledge of the ecosystem and are **all
"verify at adoption"** against the crate's `Cargo.toml` SPDX field and the
version actually pinned in `Cargo.lock` — SPDX expressions change between
majors. Sources: 08-subsystem-plans 01–08 as cited.

| Crate (plan) | Licence (unverified unless noted) | Obligation | How met |
| --- | --- | --- | --- |
| `regex` (01) | MIT OR Apache-2.0 | Preserve notice + licence text | Generated notices file |
| `lopdf` (01, 02, 06) | MIT OR Apache-2.0 | Notice preservation | Generated notices file |
| `crc32fast` (01) | MIT OR Apache-2.0 | Notice preservation | Generated notices file |
| `jiff` (01, 05) | MIT OR Apache-2.0 | Notice preservation | Generated notices file |
| `zip` — read side only (02, 04) | MIT | Notice preservation | Generated notices file |
| `rusqlite` + `libsqlite3-sys`, `bundled` feature (02, 05) | MIT / Apache-2.0 (crates); bundled SQLite C amalgamation is **public domain** (no notice obligation, note kept anyway) | Notice preservation | Generated notices file; SQLite's public-domain status recorded, not relied on |
| `walkdir` (02) | MIT OR Apache-2.0 (some files Unlicense/MIT) | Notice preservation | Generated notices file |
| `tokio` (+ `tokio-util`/`tokio-stream` if adopted) (02–05) | MIT | Notice preservation | Generated notices file |
| `image` (02, 03) | MIT OR Apache-2.0 | Notice preservation | Generated notices file |
| `reqwest` with `rustls-tls` (04, 07) | MIT OR Apache-2.0 | Notice preservation | Generated notices file |
| `rustls` (+ `ring` or `aws-lc-rs` backend) (04) | MIT OR Apache-2.0 OR ISC; backend `ring` carries an **OpenSSL-derived** component with extra attribution terms — verify the exact notices text; `aws-lc-rs` is Apache-2.0 **verify at adoption** | Notice preservation + OpenSSL attribution if `ring` | Generated notices file; TLS backend choice recorded here when made |
| `serde`, `serde_json` (04, 07) | MIT OR Apache-2.0 | Notice preservation | Generated notices file |
| `tauri` (08) | MIT OR Apache-2.0 | Notice preservation | Generated notices file |
| `tauri-plugin-opener` (08) | MIT OR Apache-2.0 | Notice preservation | Generated notices file |
| `tauri-plugin-dialog` (08) | MIT OR Apache-2.0 | Notice preservation | Generated notices file |
| `tauri-plugin-updater` (08) | MIT OR Apache-2.0 | Notice preservation | Generated notices file |
| `notify-rust` (08) | MIT OR Apache-2.0 | Notice preservation | Generated notices file |
| `webview2-com` family (08, Windows) | MIT | Notice preservation + licence text of the loader DLL | Generated notices file; verify which crates land in the lockfile |

Anything adopted later that is not in this table must be added to it and to the
`cargo deny` allow-list before merge (see §7).

## 6. libvips removal

1.x's **only bundled copyleft component** is libvips (LGPL-3.0-or-later),
reached through `sharp`'s prebuilt `@img/*` binaries — the reason
`asarUnpack` pulls `node_modules/@img/**` outside the asar and the reason the
generated notices has a "Copyleft components" section at all. The 2.x choice
replaces sharp with the `image` crate (08-subsystem-plans/02 §thumbnails, 03),
which is permissively licensed; no ffmpeg sidecar or other native image
backend is adopted in the current plans. Record: **the LGPL-3.0 bundling
obligation — and its dynamic-link consideration inside a GPL app —
disappears entirely in 2.x.** The generated 2.x notices file should show an
empty copyleft section (unless MPL/Slint-GPL choices above change that), which
is itself the acceptance check for this item.

## 7. No GNU/AGPL crates without a licence review gate

**Rule: no crate under GPL, LGPL (beyond the toolkit fallbacks cleared in §2),
AGPL, or any non-standard licence may be added to any workspace crate without
passing a licence review gate.** AGPL specifically: its network-copyleft terms
are widely read as applying to distributed desktop apps that expose an AGPL
service over a network; treat any AGPL crate as a blocker pending review, not
a dependency.

The gate is recorded **by reference** in `CHECKLISTS/release.md` (authored
with 11-ci-release-plan.md; the checklists directory is a planned deliverable
of this corpus): a release-checklist item confirming that (a) the generated
notices match `Cargo.lock`, (b) the crate table in §5 is current, and (c) the
`cargo deny` licences job passed. The enforcing mechanism is §3's CI gate; the
checklist item is the human backstop.

## Open items

- Confirm SPDX for `lopdf`, `zip`, `walkdir`, `rustls` and the TLS crypto
  backend at first `Cargo.lock` review; replace "verify at adoption" marks
  above with verified values (16-open-questions.md tracks this).
- Choose `cargo about` vs `cargo license`+manual template when 11's CI plan is
  written; both are named here without versions deliberately.
- If Slint is ever selected (06 §8 re-scoring trigger), append its dual-licence
  consequences to 06-technology-decision.md and re-run this audit.
