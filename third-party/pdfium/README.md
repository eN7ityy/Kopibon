# Vendored pdfium binaries (D3-compliant: bundled libraries, not shelled-out tools)

`kopibon-core::conversion::raster` binds this library at runtime via
`pdfium-render` (`Pdfium::bind_to_library`) — never via a subprocess, so D3
(zero external tools) holds.

| Platform | File | Unpacked | Source |
|---|---|---|---|
| linux-x64 | `linux-x64/libpdfium.so` | 7.7 MB | `github.com/bblanchon/pdfium-binaries`, release `chromium/8035` (pdfium 154.0.8035.0), **non-V8** build (no JS/XFA needed) |

Licence: BSD-3-Clause (`linux-x64/LICENSE.pdfium`), notice reproduced in
`THIRD-PARTY-NOTICES.md` at release time (see `docs/rust-port/13-licence-audit.md`).

Runtime resolution order (`raster::pdfium_library_candidates`):
1. `$KOPIBON_PDFIUM_LIB` — explicit override (tests, custom installs).
2. The executable's sibling directory — the shipped layout (Tauri `resources` /
   `externalBin` at packaging time; Phase D).
3. System library (`bind_to_system_library`).

Windows (`pdfium.dll`) and macOS are intentionally absent — out of scope until
the Phase D packaging review (F1 trigger, now resolved for linux-x64).
