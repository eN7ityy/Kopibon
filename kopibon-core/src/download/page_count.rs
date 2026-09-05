//! page-count.ts port: how many pages a file holds, whatever its format.
//! cbz: image entries in the central directory, nothing inflated; pdf: 1.x
//! shells to `pdfinfo` — the port reads the trailer via lopdf (same answer,
//! no poppler dependency; 03 §6 note). Returns None rather than throwing —
//! a page count is an enrichment, never a failed download.

use crate::metadata::writers::comicinfo::count_cbz_pages;

pub fn count_pages(file_path: &std::path::Path, format: Option<&str>) -> Option<i64> {
    if !file_path.exists() {
        return None;
    }

    let kind = match format.map(|f| f.to_lowercase()) {
        Some(f) if !f.is_empty() => f,
        _ => {
            if file_path.to_string_lossy().to_lowercase().ends_with(".pdf") {
                "pdf".to_string()
            } else {
                "cbz".to_string()
            }
        }
    };

    let pages = match kind.as_str() {
        "pdf" => pdf_page_count(file_path),
        _ => count_cbz_pages(file_path).ok(),
    };
    match pages {
        Some(n) if n > 0 => Some(n as i64),
        _ => None,
    }
}

/// getPdfPageCount equivalent: /Count from the page tree (pdfinfo parses the
/// same trailer): Root (catalog) → Pages → Count.
fn pdf_page_count(path: &std::path::Path) -> Option<usize> {
    let doc = lopdf::Document::load(path).ok()?;
    let catalog_id = doc.trailer.get(b"Root").ok()?.as_reference().ok()?;
    let catalog = doc.get_object(catalog_id).ok()?.as_dict().ok()?;
    let pages_id = catalog.get(b"Pages").ok()?.as_reference().ok()?;
    let pages = doc.get_object(pages_id).ok()?.as_dict().ok()?;
    pages.get(b"Count").ok()?.as_i64().ok().map(|n| n as usize)
}
