//! CV-01 (rasteriser-absent side) — the loud lossy-fallback failure.
//!
//! MUST stay in its own test target: the pdfium binding is process-global and
//! first-call-wins (`conversion::raster` module docs), so any successful
//! raster call earlier in the same process would make the absent path
//! untestable. This target performs no successful bind — only the failure.
//! Never add a success-path test to this file.

#[path = "scanner_fixture.rs"]
mod scanner_fixture;

#[test]
fn cv01_rasteriser_absent_loud_failure() {
    let dir = std::env::temp_dir().join(format!("cv-noraster-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let pdf_abs = dir.join("noraster.pdf");
    let jpeg = scanner_fixture::cover_jpeg(300, 420);
    scanner_fixture::build_image_pdf(&pdf_abs, std::slice::from_ref(&jpeg)).unwrap();

    // Explicit bogus override, effective because this process has never bound:
    // no fallback, no silent degrade — the loud per-item error, so a lossy
    // conversion can never destroy the only full-quality copy.
    let scratch = dir.join("scratch");
    let err = kopibon_core::conversion::raster::render_pages(
        &pdf_abs,
        &scratch,
        1,
        Some(std::path::Path::new("/nonexistent-dir/libpdfium.so")),
    )
    .unwrap_err();
    assert!(
        err.contains("lossy fallback requires a rasteriser"),
        "loud error, got: {err}"
    );
    assert!(pdf_abs.exists(), "the source PDF is never deleted on the lossy path");

    // The failure is cached, not retried into a degrade: a second call with
    // the real library staged still reports the same loud error.
    let vendored = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../third-party/pdfium/linux-x64/libpdfium.so");
    let err2 = kopibon_core::conversion::raster::render_pages(&pdf_abs, &scratch, 1, Some(&vendored))
        .unwrap_err();
    assert!(
        err2.contains("lossy fallback requires a rasteriser"),
        "first-call-wins binding, got: {err2}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
