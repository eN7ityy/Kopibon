//! pdfium lossy rasteriser (18-future-work F1 RESOLVED, USER DECISION option A).
//!
//! 1.x rasterises non-DCTDecode PDF pages with `pdftoppm -jpeg -r 150`
//! (pdf-extract.ts:177-206) and PDF covers with
//! `pdftoppm -f 1 -l 1 -singlefile -jpeg -scale-to 800`
//! (library-scanner.worker.ts:541-574). D3 bans poppler in the shipped build;
//! this module is the native replacement via `pdfium-render` against a
//! vendored `libpdfium.so` (`third-party/pdfium/` — a bundled library, never
//! a shelled-out tool).
//!
//! Fidelity spike (2026-09-06, 3-page vector PDF): page count 3=3, dimensions
//! identical 1275×1650 @150 DPI, mean-abs-diff ≈0.18/255 per channel (JPEG
//! encoder difference only — the lossy path is never byte-parity, only "one
//! page per page, in order, JPEG").
//!
//! Binding is process-global and first-call-wins: pdfium-render enforces a
//! single binding per process (any second `bind_to_*` fails with
//! `PdfiumLibraryBindingsAlreadyInitialized`), so this module holds one
//! `OnceLock<Pdfium>` shared by conversion and thumbnails. The explicit
//! `lib_override` parameter is therefore effective only for the process's
//! first raster call — the rasteriser-absent loud-failure test lives in its
//! own test target (`tests/raster_absent.rs`) for exactly this reason.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use pdfium_render::prelude::*;

/// Mirrors `pdftoppm -jpeg -r 150` (pdf-extract.ts:183).
pub const RASTER_DPI: f32 = 150.0;

/// Explicit-override env var, read during the one-time binding init (first
/// raster call wins). Lets installs point at a custom library path without
/// code changes; tests use the `lib_override` parameter instead.
pub const PDFIUM_LIB_ENV: &str = "KOPIBON_PDFIUM_LIB";

/// Library search order: explicit override → executable sibling dir (the
/// shipped layout; Tauri `resources` at packaging time) → vendored repo copy
/// (dev/test only, see below) → system library.
pub fn pdfium_library_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(p) = std::env::var(PDFIUM_LIB_ENV) {
        if !p.is_empty() {
            out.push(PathBuf::from(p));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(Pdfium::pdfium_platform_library_name_at_path(dir));
        }
    }
    if let Some(vendored) = vendored_repo_library() {
        out.push(vendored);
    }
    out
}

/// The `third-party/pdfium/` copy, resolved from the compile-time manifest
/// dir. Dev/test convenience ONLY (`#[cfg(debug_assertions)]` — release
/// builds never see a build-machine path): `cargo test` binaries live in
/// `target/debug/deps/`, far from any shipped sibling `.so`, so without this
/// every raster test would need env staging with first-call-wins ordering
/// hazards. Absent on user machines by construction (falls through).
#[cfg(debug_assertions)]
fn vendored_repo_library() -> Option<PathBuf> {
    let platform = if cfg!(target_os = "windows") {
        "win-x64"
    } else if cfg!(target_os = "macos") {
        "mac-arm64"
    } else {
        "linux-x64"
    };
    let file = if cfg!(target_os = "windows") { "pdfium.dll" } else { "libpdfium.so" };
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../third-party/pdfium")
        .join(platform)
        .join(file);
    path.exists().then_some(path)
}

/// Release builds ship the sibling `.so`, never a build-machine path.
#[cfg(not(debug_assertions))]
fn vendored_repo_library() -> Option<PathBuf> {
    None
}

fn init_pdfium(lib_override: Option<&Path>) -> Result<Pdfium, String> {
    if let Some(path) = lib_override {
        // Explicit path (tests, custom installs): no fallback — absence must
        // fail LOUD, never silently degrade (the lossy safety property). The
        // canonical text leads so the per-item error stays greppable.
        let bindings = Pdfium::bind_to_library(path).map_err(|e| {
            format!("{LOSSY_FALLBACK_UNAVAILABLE} (pdfium bind failed for {}: {e})", path.display())
        })?;
        return Ok(Pdfium::new(bindings));
    }
    for candidate in pdfium_library_candidates() {
        if let Ok(bindings) = Pdfium::bind_to_library(&candidate) {
            return Ok(Pdfium::new(bindings));
        }
    }
    Pdfium::bind_to_system_library()
        .map(Pdfium::new)
        .map_err(|e| format!("{LOSSY_FALLBACK_UNAVAILABLE}: {e}"))
}

/// The process-global binding (first call wins — see module docs).
static PDFIUM: OnceLock<Result<Pdfium, String>> = OnceLock::new();

/// Shared binding, initialised once from `lib_override` (effective only on
/// the first call) or the candidate search. A failed init is cached and
/// returned LOUD on every later call — never retried into a silent degrade.
fn pdfium(lib_override: Option<&Path>) -> Result<&'static Pdfium, String> {
    PDFIUM
        .get_or_init(|| init_pdfium(lib_override))
        .as_ref()
        .map_err(|e| e.clone())
}

/// The loud-error outcome (extract.rs re-exports the canonical text).
pub use crate::conversion::extract::LOSSY_FALLBACK_UNAVAILABLE;

/// Pixels for one side at [`RASTER_DPI`] (`pdftoppm -r 150` scales by
/// resolution regardless of page size — same formula).
fn dpi_pixels(points: f32) -> i32 {
    ((points / 72.0 * RASTER_DPI).round() as i32).max(1)
}

/// Render every page at 150 DPI into `scratch_dir` as `page-%04d.jpg`
/// (the 4-digit `pdftoppm` padding shape, matching the Attempt-1 S4 naming so
/// downstream `numeric_sort_key` + CBZ assembly are untouched).
///
/// `expected_pages` comes from the caller (the document page tree, never
/// gallery metadata); a short render fails with the 1.x count-guard message
/// shape (pdf-extract.ts:194-198).
pub fn render_pages(
    pdf_path: &Path,
    scratch_dir: &Path,
    expected_pages: usize,
    lib_override: Option<&Path>,
) -> Result<Vec<PathBuf>, String> {
    let pdfium = pdfium(lib_override)?;
    let doc = pdfium
        .load_pdf_from_file(pdf_path, None)
        .map_err(|e| format!("pdfium load failed for {}: {e}", pdf_path.display()))?;
    let pages = doc.pages();
    if pages.len() as usize != expected_pages {
        return Err(format!(
            "pdfium produced {} file(s) but expected {expected_pages} pages",
            pages.len()
        ));
    }
    std::fs::create_dir_all(scratch_dir).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(expected_pages);
    for (i, page) in pages.iter().enumerate() {
        let image = render_page(&page)?;
        let path = scratch_dir.join(format!("page-{:04}.jpg", i + 1));
        // `image::save` JPEG default quality is 75 — the `pdftoppm -jpeg`
        // default. No quality flag exists on either side; keep both mute.
        image.save(&path).map_err(|e| e.to_string())?;
        out.push(path);
    }
    if out.is_empty() {
        return Err("pdfium produced zero files".to_string());
    }
    Ok(out)
}

/// Render one page at 150 DPI. Both sides are set from the page's own aspect
/// so nothing distorts; rotation is applied by pdfium by default.
fn render_page(page: &PdfPage) -> Result<image::DynamicImage, String> {
    let bitmap = page
        .render_with_config(
            &PdfRenderConfig::new()
                .set_target_width(dpi_pixels(page.width().value))
                .set_target_height(dpi_pixels(page.height().value)),
        )
        .map_err(|e| format!("pdfium render failed: {e}"))?;
    bitmap.as_image().map_err(|e| format!("pdfium bitmap failed: {e}"))
}

/// Render page 1 at 150 DPI — the thumbnail source (the caller downsamples
/// fit-inside 600×800 q82 through the shared CBZ-scheme encoder).
pub fn render_first_page(
    pdf_path: &Path,
    lib_override: Option<&Path>,
) -> Result<image::DynamicImage, String> {
    let pdfium = pdfium(lib_override)?;
    let doc = pdfium
        .load_pdf_from_file(pdf_path, None)
        .map_err(|e| format!("pdfium load failed for {}: {e}", pdf_path.display()))?;
    let pages = doc.pages();
    if pages.is_empty() {
        return Err("pdfium produced zero files".to_string());
    }
    let page = pages
        .get(0)
        .map_err(|e| format!("pdfium page 1 failed: {e}"))?;
    render_page(&page)
}
