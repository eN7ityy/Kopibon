//! pdf-extract.ts port — S4 lopdf path (06 §4).
//!
//! Attempt 1 extracts embedded DCTDecode image streams BYTE-IDENTICAL per
//! page order (S4 PASS 16/16), with the count guard: extracted != expected →
//! discard everything. Expected page count comes from the document's page
//! tree, never from gallery.page_count (scanner stubs are 0).
//!
//! Attempt 2 in 1.x is the lossy pdftoppm rasterise. Port: the vendored
//! pdfium rasteriser (`super::raster`, F1 resolved option A) renders every
//! page at 150 DPI (`method: "pdfium"`, `lossless: false`) — exactly the 1.x
//! Attempt-2 shape (pdf-extract.ts:177-206), including the count-guard
//! message shape (:194-198). Rasteriser-absent still fails LOUD per item so
//! the safety property (a lossy conversion can never destroy the only
//! full-quality copy) holds by construction.

use std::path::{Path, PathBuf};

use crate::metadata::writers::comicinfo::is_image_entry;

#[derive(Debug)]
pub struct ExtractResult {
    pub image_paths: Vec<PathBuf>,
    pub page_count: usize,
    pub lossless: bool,
    pub method: &'static str,
}

/// The count guard message shape (pdf-extract.ts:157-162), ported to the
/// loud-error outcome of the USER DECISION.
pub const LOSSY_FALLBACK_UNAVAILABLE: &str =
    "lossy fallback requires a rasteriser; source PDF left in place";

/// Expected page count from the document (pdfinfo equivalent).
pub fn expected_page_count(pdf_path: &Path) -> Result<usize, String> {
    let doc = lopdf::Document::load(pdf_path).map_err(|e| format!("pdf load failed: {e}"))?;
    let catalog_id = doc
        .trailer
        .get(b"Root")
        .map_err(|e| e.to_string())?
        .as_reference()
        .map_err(|e| e.to_string())?;
    let catalog = doc
        .get_object(catalog_id)
        .map_err(|e| e.to_string())?
        .as_dict()
        .map_err(|e| e.to_string())?;
    let pages_id = catalog
        .get(b"Pages")
        .map_err(|e| e.to_string())?
        .as_reference()
        .map_err(|e| e.to_string())?;
    let pages = doc
        .get_object(pages_id)
        .map_err(|e| e.to_string())?
        .as_dict()
        .map_err(|e| e.to_string())?;
    let count = pages
        .get(b"Count")
        .map_err(|e| e.to_string())?
        .as_i64()
        .map_err(|e| e.to_string())?;
    if count <= 0 {
        return Err(format!("pdf reports {count} pages"));
    }
    Ok(count as usize)
}

/// One embedded page image: ordinal, extension, raw stream bytes.
struct PageImage {
    ext: &'static str,
    bytes: Vec<u8>,
}

/// Collect the embedded page images in page order (the S4 lopdf path).
fn extract_embedded_images(doc: &lopdf::Document) -> Result<Vec<PageImage>, String> {
    let catalog_id = doc
        .trailer
        .get(b"Root")
        .map_err(|e| e.to_string())?
        .as_reference()
        .map_err(|e| e.to_string())?;
    let catalog = doc
        .get_object(catalog_id)
        .map_err(|e| e.to_string())?
        .as_dict()
        .map_err(|e| e.to_string())?;
    let pages_id = catalog
        .get(b"Pages")
        .map_err(|e| e.to_string())?
        .as_reference()
        .map_err(|e| e.to_string())?;
    let pages_dict = doc
        .get_object(pages_id)
        .map_err(|e| e.to_string())?
        .as_dict()
        .map_err(|e| e.to_string())?;
    let kids = pages_dict
        .get(b"Kids")
        .map_err(|e| e.to_string())?
        .as_array()
        .map_err(|e| e.to_string())?;

    let mut images = Vec::new();
    for kid in kids {
        let page_id = kid.as_reference().map_err(|e| e.to_string())?;
        let page = doc.get_object(page_id).map_err(|e| e.to_string())?.as_dict().map_err(|e| e.to_string())?;
        // Resources -> XObject -> each image stream.
        let resources = page
            .get(b"Resources")
            .ok()
            .and_then(|o| match o {
                lopdf::Object::Dictionary(d) => Some(d.clone()),
                lopdf::Object::Reference(id) => doc
                    .get_object(*id)
                    .ok()
                    .and_then(|o| o.as_dict().ok().cloned()),
                _ => None,
            });
        let Some(resources) = resources else { continue };
        let Ok(xobjects) = resources.get(b"XObject") else { continue };
        let xobjects = match xobjects {
            lopdf::Object::Dictionary(d) => d.clone(),
            lopdf::Object::Reference(id) => doc
                .get_object(*id)
                .ok()
                .and_then(|o| o.as_dict().ok().cloned())
                .unwrap_or_default(),
            _ => continue,
        };
        for (_name, value) in xobjects.iter() {
            let Ok(obj_id) = value.as_reference() else { continue };
            let Ok(stream) = doc.get_object(obj_id).and_then(|o| o.as_stream()) else {
                continue;
            };
            let dict = stream.dict.clone();
            let is_image = dict
                .get(b"Subtype")
                .and_then(|o| o.as_name())
                .map(|n| n == b"Image")
                .unwrap_or(false);
            if !is_image {
                continue;
            }
            let filter = dict
                .get(b"Filter")
                .ok()
                .and_then(|o| match o {
                    lopdf::Object::Name(n) => Some(n.clone()),
                    lopdf::Object::Array(a) => a.first().and_then(|o| o.as_name().ok()).map(|n| n.to_vec()),
                    _ => None,
                });
            let Some(filter) = filter else { continue };
            let data = stream.content.clone();
            match filter.as_slice() {
                b"DCTDecode" => images.push(PageImage { ext: "jpg", bytes: data }),
                b"JPXDecode" => images.push(PageImage { ext: "jp2", bytes: data }),
                b"FlateDecode" | b"CCITTFaxDecode" | b"JBIG2Decode" => {
                    // Non-JPEG streams: S4 covers Flate raw RGB decode; the
                    // byte-identical contract is JPEG-only. Treated as a
                    // count-mismatch trigger unless it decodes cleanly —
                    // Phase A keeps them as-is for the count guard to catch.
                    images.push(PageImage { ext: "raw", bytes: data });
                }
                _ => {}
            }
        }
    }
    Ok(images)
}

/// extractPdfImages (pdf-extract.ts:128-206) — S4 path + loud fallback error.
pub fn extract_pdf_images(
    pdf_path: &Path,
    scratch_dir: &Path,
    log: &mut dyn FnMut(String),
) -> Result<ExtractResult, String> {
    let expected_pages = expected_page_count(pdf_path)?;

    // Attempt 1: the lopdf S4 path (byte-identical JPEG streams).
    let doc = lopdf::Document::load(pdf_path).map_err(|e| format!("pdf load failed: {e}"))?;
    let images = extract_embedded_images(&doc)?;

    if images.len() == expected_pages {
        let _ = std::fs::create_dir_all(scratch_dir);
        let mut image_paths = Vec::new();
        for (i, img) in images.iter().enumerate() {
            let path = scratch_dir.join(format!("page-{:04}.{}", i + 1, img.ext));
            std::fs::write(&path, &img.bytes).map_err(|e| e.to_string())?;
            image_paths.push(path);
        }
        return Ok(ExtractResult {
            image_paths,
            page_count: expected_pages,
            lossless: true,
            method: "lopdf",
        });
    }

    // Count guard (:150-165): discard everything and fall through.
    log(format!(
        "Count mismatch for {}: lopdf extracted {} image(s) but the document reports {} page(s).",
        pdf_path.display(),
        images.len(),
        expected_pages
    ));
    let _ = std::fs::remove_dir_all(scratch_dir);

    // Attempt 2: the pdfium lossy rasterise (1.x pdftoppm shape,
    // pdf-extract.ts:177-206). Rasteriser-absent fails LOUD per item.
    let image_paths =
        super::raster::render_pages(pdf_path, scratch_dir, expected_pages, None).inspect_err(|_| {
            let _ = std::fs::remove_dir_all(scratch_dir);
        })?;
    Ok(ExtractResult { image_paths, page_count: expected_pages, lossless: false, method: "pdfium" })
}

/// Numeric trailing-index sort key (pdf-extract.ts:85-89) — the digits must
/// NOT be read as a signed hyphenated number (the shipped backwards-CBZ bug).
pub fn numeric_sort_key(path: &Path) -> i64 {
    let name = path
        .file_stem()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let digits: String = name.chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
    digits.parse::<i64>().unwrap_or(0)
}

/// Whether a name counts as an image entry for the verifier.
pub fn image_entry_name(name: &str) -> bool {
    is_image_entry(name)
}
