//! WR-01 — Field × mutation matrix, golden-corpus cells (10-test-plan §7;
//! 07-metadata-spec §6). The 12 write paths all funnel through the three
//! context builders + two writers, so the headless cells here run the REAL
//! 1.x writers (yazl / pikepdf via the bundled source) against the Rust
//! writers on identical inputs:
//!
//! - path 1/5 (download→PDF / updateMetadata): applyMetadata pdf — XMP
//!   packet byte-identical, Info dict semantic per D6
//! - path 2 (download→CBZ): generateCbz — whole archive byte-identical
//! - path 5/6/7/8 (any CBZ rewrite): applyMetadata cbz — whole archive
//!   byte-identical
//! - path 11 (attach/detach id): filename only — see filenames.rs (FN-01)
//!
//! Cells whose artefacts involve the DB layer (paths 3/4/9/12) ride on the
//! same writers once WP-A5/A9 wire the row sources; the CURRENT-BUILD
//! capture cells land with WP-A11-full (10-test-plan §1.2).

mod common;

use serde_json::json;

const NOW_MS: i64 = 1788566452000; // 2026-09-05T00:00:52.000000+00:00
const MTIME: u64 = 1788566452;
const GOLDEN_PDF: &str = "Kaijou Gentei Omakebon [nhentai-527302].pdf";
const GOLDEN_CBZ: &str = "DEMONBANE FANZIN Vol. 1_ DEMONBANE CAUSAL SEQUENCE [nhentai-528499].cbz";

fn golden(name: &str) -> String {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../testdata/golden")
        .join(name)
        .to_string_lossy()
        .into_owned()
}

/// Path 2 — download → CBZ: identical page bytes + metadata must produce a
/// byte-identical archive (byte level per 07-metadata-spec §1).
#[test]
fn wr01_download_cbz_byte_identical() {
    common::init();
    let pages: Vec<String> = (0..3)
        .map(|i| {
            // Distinct pseudo-page payloads.
            base64_of(format!("page payload {i}").as_bytes())
        })
        .collect();
    let meta = json!({
        "galleryId": 528499,
        "title": "DEMONBANE FANZIN Vol. 1",
        "artists": ["artist"],
        "tags": ["a tag"],
        "allTags": ["doujinshi", "japanese", "a tag"],
        "categories": ["doujinshi"],
        "languageTags": ["japanese"],
        "mangaDirection": "YesAndRightToLeft",
        "format": "cbz"
    });
    let input = json!({"pages": pages, "meta": meta, "mtime": MTIME});
    let js = common::js_op("generateCbz", &input).expect("JS generateCbz");
    let rs = common::rust_op("generateCbz", &input).expect("Rust generateCbz");
    assert_eq!(js, rs, "download→CBZ cell: archives differ at byte level");
}

/// Path 5 — updateMetadata on a CBZ: rebuild with ComicInfo first, every
/// other entry preserved; whole archive byte-identical (write path of
/// apply-metadata.ts:114-192).
#[test]
fn wr01_update_metadata_cbz_byte_identical() {
    common::init();
    let meta = json!({
        "galleryId": 528499,
        "title": "Edited Title",
        "artists": ["The Artist"],
        "seriesName": "A Series",
        "seriesIndex": 3,
        "mangaDirection": "YesAndRightToLeft",
        "format": "cbz"
        // pageCount deliberately absent: derived from the archive, never the
        // caller (07-metadata-spec §4)
    });
    let input = json!({
        "file": golden(GOLDEN_CBZ),
        "format": "cbz",
        "meta": meta,
        "mtime": MTIME,
        "now": NOW_MS
    });
    let js = common::js_op("applyMetadata", &input).expect("JS applyMetadata cbz");
    let rs = common::rust_op("applyMetadata", &input).expect("Rust applyMetadata cbz");
    assert_eq!(
        js["apply"]["success"].as_bool(),
        Some(true),
        "JS apply failed: {js:?}"
    );
    assert_eq!(
        js, rs,
        "updateMetadata→CBZ cell: archives differ at byte level"
    );
}

/// Path 1 — download → PDF / any PDF rewrite: the XMP packet inside the
/// written file is byte-identical; Info dict values semantic per D6
/// (Producer and /Trapped are the sanctioned deviations).
#[test]
fn wr01_pdf_xmp_packet_and_info_semantic() {
    common::init();
    let meta = json!({
        "galleryId": 527302,
        "title": "Kaijou Gentei Omakebon",
        "artists": ["shaa"],
        "groups": ["neko-bus tei"],
        "allTags": ["doujinshi", "japanese", "genshin impact", "non-h",
                    "yoimiya naganohara", "shaa", "neko-bus tei"],
        "tags": ["non-h", "yoimiya naganohara"],
        "parodies": ["genshin impact"],
        "categories": ["doujinshi"],
        "languageTags": ["japanese"],
        "releaseDate": "2024-08-28T12:42:28.000Z",
        "format": "pdf"
    });
    let input = json!({
        "file": golden(GOLDEN_PDF),
        "format": "pdf",
        "meta": meta,
        "mtime": MTIME,
        "now": NOW_MS
    });
    let js = common::js_op("applyMetadata", &input).expect("JS applyMetadata pdf");
    let rs = common::rust_op("applyMetadata", &input).expect("Rust applyMetadata pdf");
    assert!(
        js["apply"]["success"].as_bool().unwrap_or(false),
        "JS pdf apply failed: {js:?}"
    );
    assert!(
        rs["apply"]["success"].as_bool().unwrap_or(false),
        "Rust pdf apply failed: {rs:?}"
    );

    let js_pdf = decode_base64(js["bytes"].as_str().expect("js bytes"));
    let rs_pdf = decode_base64(rs["bytes"].as_str().expect("rs bytes"));

    let js_packet = extract_packet(&js_pdf).expect("packet in JS output");
    let rs_packet = extract_packet(&rs_pdf).expect("packet in Rust output");
    assert_eq!(
        js_packet, rs_packet,
        "download→PDF cell: XMP packets differ at byte level"
    );

    // Info dict: semantic level. Title/Author/Keywords must match exactly;
    // Producer differs by D6 (port emits "Kopibon 2.x"), /Trapped is a
    // proper name in 2.x and the string '/False' in 1.x.
    let js_info = info_fields(&js_pdf);
    let rs_info = info_fields(&rs_pdf);
    for key in ["Title", "Author", "Keywords"] {
        assert_eq!(
            js_info.get(key),
            rs_info.get(key),
            "Info {key} diverged: js={:?} rs={:?}",
            js_info.get(key),
            rs_info.get(key)
        );
    }
    assert_eq!(
        rs_info.get("Producer").map(String::as_str),
        Some("Kopibon 2.x")
    );
    assert_eq!(
        js_info.get("Producer").map(String::as_str),
        Some("pikepdf 10.8.0")
    );
}

// ─── helpers ────────────────────────────────────────────────────────────────

fn base64_of(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn decode_base64(s: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .expect("valid base64")
}

fn extract_packet(pdf: &[u8]) -> Result<Vec<u8>, String> {
    use lopdf::Object;
    let path = std::env::temp_dir().join(format!("wr01-extract-{}.pdf", std::process::id()));
    std::fs::write(&path, pdf).map_err(|e| e.to_string())?;
    let doc = lopdf::Document::load(&path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&path);
    let root = doc
        .trailer
        .get(b"Root")
        .and_then(|o| o.as_reference())
        .map_err(|e| e.to_string())?;
    let dict = doc.get_dictionary(root).map_err(|e| e.to_string())?;
    let meta = dict.get(b"Metadata").map_err(|e| e.to_string())?;
    match doc.dereference(meta).map_err(|e| e.to_string())? {
        (Some(_), Object::Stream(s)) => Ok(s.content.clone()),
        _ => Err("Metadata not a stream".into()),
    }
}

fn info_fields(pdf: &[u8]) -> std::collections::HashMap<String, String> {
    use lopdf::Object;
    let path = std::env::temp_dir().join(format!("wr01-info-{}.pdf", std::process::id()));
    std::fs::write(&path, pdf).expect("write");
    let doc = lopdf::Document::load(&path).expect("load");
    let _ = std::fs::remove_file(&path);
    let mut out = std::collections::HashMap::new();
    let info_ref = doc.trailer.get(b"Info").ok().and_then(|o| match o {
        Object::Reference(id) => Some(*id),
        _ => None,
    });
    if let Some(id) = info_ref {
        if let Ok(Object::Dictionary(dict)) = doc.get_object(id) {
            for (k, v) in dict.iter() {
                if let Object::String(bytes, _) = v {
                    out.insert(
                        String::from_utf8_lossy(k).into_owned(),
                        String::from_utf8_lossy(bytes).into_owned(),
                    );
                }
            }
        }
    }
    out
}
