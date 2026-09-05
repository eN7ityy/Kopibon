//! WR-02 — XMP packet round-trip (S1, 1782 B golden; 10-test-plan §7).
//! Renders the golden PDF's metadata through the Rust engine, writes it with
//! the lopdf writer, re-extracts the packet, and byte-compares against the
//! packet pikepdf wrote into the golden fixture.

mod common;

use kopibon_core::metadata::context::{default_file_metadata, FileMetadata, JsDate};
use kopibon_core::metadata::mappers::FixedClock;
use kopibon_core::metadata::templates_io::{clear_template_cache, PDF_XMP_TEMPLATE};
use std::path::PathBuf;
use std::sync::Mutex;

/// Serialise tests that share the template cache (install/dirs mutate).
static LOCK: Mutex<()> = Mutex::new(());

fn golden_pdf() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../testdata/golden/Kaijou Gentei Omakebon [nhentai-527302].pdf")
}

/// The golden PDF's metadata, reconstructed from the packet pikepdf wrote
/// (07-metadata-spec §11 fixture 3; the values are also the S1 spike's).
fn golden_meta() -> FileMetadata {
    let mut m = default_file_metadata();
    m.gallery_id = Some(527302.0);
    m.title = "Kaijou Gentei Omakebon".to_string();
    m.artists = vec!["shaa".to_string()];
    m.groups = vec!["neko-bus tei".to_string()]; // resolves as publisher
    m.all_tags = vec![
        "doujinshi".into(),
        "japanese".into(),
        "genshin impact".into(),
        "non-h".into(),
        "yoimiya naganohara".into(),
        "shaa".into(),
        "neko-bus tei".into(),
    ];
    m.language_tags = vec!["japanese".into()];
    m.tags = vec!["non-h".into(), "yoimiya naganohara".into()];
    m.parodies = vec!["genshin impact".into()];
    m.categories = vec!["doujinshi".into()];
    m.description = None; // one-shot with no description (self-closed li)
    m.release_date = Some(JsDate(1724848948000)); // 2024-08-28T12:42:28.000Z
    m
}

/// The instant pikepdf stamped into the golden packet's MetadataDate.
const GOLDEN_NOW_MS: i64 = 1788566452000; // 2026-09-05T00:00:52.000000+00:00

fn extract_packet(pdf_path: &std::path::Path) -> Vec<u8> {
    let doc = lopdf::Document::load(pdf_path).expect("load written PDF");
    let root = doc
        .trailer
        .get(b"Root")
        .and_then(|o| o.as_reference())
        .expect("catalog");
    let catalog = doc.get_object(root).expect("catalog object");
    let lopdf::Object::Dictionary(dict) = catalog else {
        panic!("catalog not a dictionary")
    };
    let meta = dict.get(b"Metadata").expect("Metadata in catalog");
    let lopdf::Object::Reference(id) = meta else {
        panic!("Metadata not a reference")
    };
    let obj = doc.get_object(*id).expect("metadata object");
    let lopdf::Object::Stream(stream) = obj else {
        panic!("Metadata not a stream")
    };
    stream.content.clone()
}

#[test]
fn wr02_xmp_packet_roundtrip_byte_identical() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    clear_template_cache();
    common::init();

    let golden_packet = extract_packet(&golden_pdf());
    assert_eq!(
        golden_packet.len(),
        1782,
        "golden packet is 1782 bytes (S1)"
    );

    // Render with the frozen clock, write into a temp copy, re-extract.
    let clock = FixedClock(GOLDEN_NOW_MS);
    let rendered =
        kopibon_core::metadata::mappers::build_xmp_xml(&golden_meta(), &clock).expect("render");
    let packet = kopibon_core::metadata::writers::pdf::lxml_normalisations(&rendered);

    // The render + two lxml normalisations alone must equal the golden bytes.
    if packet.as_bytes() != &golden_packet[..] {
        std::fs::write("/tmp/test-golden.xmp", &golden_packet).ok();
        std::fs::write("/tmp/test-ours.xmp", packet.as_bytes()).ok();
    }
    assert_eq!(
        packet.as_bytes(),
        &golden_packet[..],
        "rendered packet != golden packet"
    );

    // Now the full writer round-trip on a scratch copy.
    let tmp = std::env::temp_dir().join(format!("wr02-{}.pdf", std::process::id()));
    std::fs::copy(golden_pdf(), &tmp).expect("copy golden pdf");
    kopibon_core::metadata::writers::pdf::write_pdf_metadata(&tmp, &golden_meta(), &clock)
        .expect("write_pdf_metadata");
    let written_packet = extract_packet(&tmp);

    assert_eq!(
        written_packet, golden_packet,
        "packet inside the written PDF != golden packet"
    );
    std::fs::remove_file(&tmp).ok();
}

#[test]
fn wr02_info_dict_semantic_per_d6() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    clear_template_cache();
    common::init();

    let tmp = std::env::temp_dir().join(format!("wr02-info-{}.pdf", std::process::id()));
    std::fs::copy(golden_pdf(), &tmp).expect("copy golden pdf");
    let clock = FixedClock(GOLDEN_NOW_MS);
    kopibon_core::metadata::writers::pdf::write_pdf_metadata(&tmp, &golden_meta(), &clock)
        .expect("write_pdf_metadata");

    let doc = lopdf::Document::load(&tmp).expect("reload");
    let info_id = doc
        .trailer
        .get(b"Info")
        .and_then(|o| o.as_reference())
        .expect("Info");
    let lopdf::Object::Dictionary(info) = doc.get_object(info_id).expect("info obj") else {
        panic!("Info not a dictionary")
    };
    let get = |k: &[u8]| -> String {
        match info
            .get(k)
            .unwrap_or_else(|e| panic!("{}: {e}", String::from_utf8_lossy(k)))
        {
            lopdf::Object::String(bytes, _) => String::from_utf8_lossy(bytes).into_owned(),
            other => format!("{other:?}"),
        }
    };

    // Semantic per D6 (07-metadata-spec §1): values identical; Producer is
    // the sanctioned deviation; Trapped is a proper name.
    assert_eq!(get(b"Title"), "Kaijou Gentei Omakebon");
    assert_eq!(get(b"Author"), "shaa");
    assert_eq!(
        get(b"Keywords"),
        "doujinshi, japanese, genshin impact, non-h, yoimiya naganohara, shaa, \
         neko-bus tei, nhentai:527302, language:Japanese, publisher:neko-bus tei"
    );
    assert_eq!(get(b"Producer"), "Kopibon 2.x");
    assert_eq!(get(b"Trapped"), "/False");
    // pdf-lib /Creator preserved (07-metadata-spec §5 Info dict).
    assert!(
        info.get(b"Creator").is_ok(),
        "original /Creator must be preserved"
    );

    // Page count preserved (07-metadata-spec §10.1).
    let pages = doc.get_pages().len();
    assert_eq!(pages, 16);

    std::fs::remove_file(&tmp).ok();
}

#[test]
fn wr02_packet_uncompressed_length_matches() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    clear_template_cache();
    common::init();

    let tmp = std::env::temp_dir().join(format!("wr02-len-{}.pdf", std::process::id()));
    std::fs::copy(golden_pdf(), &tmp).expect("copy golden pdf");
    kopibon_core::metadata::writers::pdf::write_pdf_metadata(
        &tmp,
        &golden_meta(),
        &FixedClock(GOLDEN_NOW_MS),
    )
    .expect("write");

    // /Length 1782, uncompressed (S1: /Length 1782).
    let data = std::fs::read(&tmp).unwrap();
    let needle = b"/Length 1782";
    assert!(
        data.windows(needle.len()).any(|w| w == needle),
        "written packet must be uncompressed with /Length 1782"
    );
    std::fs::remove_file(&tmp).ok();
}

// Silence unused warnings for the template const re-export.
#[allow(dead_code)]
const _: () = ();
const _: fn() = || {
    let _ = PDF_XMP_TEMPLATE;
};
