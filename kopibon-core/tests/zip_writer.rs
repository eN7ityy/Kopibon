//! WR-03 — ZIP structural checklist (S3 field list) + Python zipfile CRC
//! validation (10-test-plan §7). Builds a CBZ from fixture 1's page bytes
//! with a freshly rendered ComicInfo (current Notes string per D7), then
//! asserts the structural contract of 07-metadata-spec §10.2 and validates
//! every CRC externally.

mod common;

use kopibon_core::metadata::context::default_file_metadata;
use kopibon_core::metadata::writers::comicinfo::{generate_cbz, read_entry};
use std::path::PathBuf;
use std::process::Command;

const GOLDEN_CBZ: &str = "DEMONBANE FANZIN Vol. 1_ DEMONBANE CAUSAL SEQUENCE [nhentai-528499].cbz";
const MTIME: u64 = 1788566452; // 2026-09-05T00:00:52Z, frozen per 07 §9

fn golden_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../testdata/golden")
        .join(GOLDEN_CBZ)
}

/// A reference render of the ComicInfo for the 2-page scratch archive, with
/// the current product string (the fixture predates the rebrand, Q11).
fn reference_comicinfo() -> Vec<u8> {
    let mut m = default_file_metadata();
    m.gallery_id = Some(528499.0);
    m.title = "DEMONBANE FANZIN Vol. 1_ DEMONBANE CAUSAL SEQUENCE".into();
    m.page_count = 2.0;
    m.language_tags = vec!["japanese".into()];
    m.parodies = vec!["demonbane".into()];
    m.categories = vec!["doujinshi".into()];
    m.release_date = None;
    let xml = kopibon_core::metadata::mappers::build_comic_info_xml(&m).expect("render");
    xml.into_bytes()
}

fn strip_notes(bytes: &[u8]) -> Vec<u8> {
    // Q11: exclude/normalise the Notes line for byte comparisons against
    // pre-rebrand fixtures.
    let text = String::from_utf8_lossy(bytes);
    let kept: Vec<&str> = text.lines().filter(|l| !l.contains("<Notes>")).collect();
    kept.join("\n").into_bytes()
}

fn read_fixture_pages(count: usize) -> Vec<Vec<u8>> {
    let file = std::fs::File::open(golden_path()).expect("open golden");
    let mut archive = zip::ZipArchive::new(file).expect("open zip");
    let mut pages = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).expect("entry");
        if entry.name() == "ComicInfo.xml" || entry.name().ends_with('/') {
            continue;
        }
        if pages.len() >= count {
            break;
        }
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut buf).expect("read page");
        pages.push(buf);
    }
    pages
}

fn run_validate_py(path: &std::path::Path) -> String {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/zip/validate.py");
    let out = Command::new("python3")
        .arg(script)
        .arg(path)
        .output()
        .expect("run python3 validator");
    assert!(
        out.status.success(),
        "python zipfile validation failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn wr03_zipfile_crc_and_structural_checklist() {
    common::init();
    let tmp = std::env::temp_dir().join(format!("wr03-{}.cbz", std::process::id()));

    // 3 pages from fixture 1 + fresh ComicInfo (current Notes string).
    let pages = read_fixture_pages(3);
    assert_eq!(pages.len(), 3);
    let meta = {
        let mut m = default_file_metadata();
        m.gallery_id = Some(528499.0);
        m.title = "T".into();
        m
    };
    generate_cbz(&pages, &tmp, &meta, MTIME, "jpg").expect("generate");

    let out = run_validate_py(&tmp);
    let lines: Vec<&str> = out.lines().filter(|l| l.starts_with("REC")).collect();
    assert_eq!(lines.len(), 4, "ComicInfo + 3 pages: {out}");

    // First entry: ComicInfo.xml, buffered shape.
    let ci = lines[0];
    assert!(ci.starts_with("REC ComicInfo.xml|"), "{ci}");
    assert!(ci.contains("vmade=3:63"), "create_system 3 Unix, 6.3: {ci}");
    assert!(ci.contains("needed=20"), "{ci}");
    assert!(ci.contains("method=0"), "STORE: {ci}");
    assert!(ci.contains("flag=0x0800"), "{ci}");
    assert!(ci.contains("mode=0o100664"), "external attrs 0664: {ci}");
    // UT extra, central directory only: 55 54 05 00 03 + mtime.
    let le: String = (MTIME as u32)
        .to_le_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert!(ci.contains(&format!("extra=5554050003{le}")), "{ci}");
    assert!(!ci.contains("comment=true"), "{ci}");

    // Pages: streamed shape.
    for (i, page) in lines[1..].iter().enumerate() {
        let name = format!("{:04}.jpg", i + 1);
        assert!(page.starts_with(&format!("REC {name}|")), "{page}");
        assert!(page.contains("flag=0x0808"), "descriptor flag: {page}");
        assert!(page.contains("method=0"), "{page}");
        assert!(page.contains("mode=0o100644"), "{page}");
    }
    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn wr03_comicinfo_entry_bytes_notes_excluded() {
    common::init();
    let tmp = std::env::temp_dir().join(format!("wr03-ci-{}.cbz", std::process::id()));
    let pages = read_fixture_pages(2);
    let mut meta = default_file_metadata();
    meta.gallery_id = Some(528499.0);
    meta.title = "DEMONBANE FANZIN Vol. 1_ DEMONBANE CAUSAL SEQUENCE".into();
    meta.page_count = 2.0;
    meta.language_tags = vec!["japanese".into()];
    meta.parodies = vec!["demonbane".into()];
    meta.categories = vec!["doujinshi".into()];
    generate_cbz(&pages, &tmp, &meta, MTIME, "jpg").expect("generate");

    let written = read_entry(&tmp, "ComicInfo.xml").expect("ComicInfo entry");
    let expected = reference_comicinfo();
    assert_eq!(
        strip_notes(&written),
        strip_notes(&expected),
        "ComicInfo entry bytes differ (Notes excluded per Q11)"
    );
    // The current Notes string is what the writer always emits (D7).
    let text = String::from_utf8_lossy(&written);
    assert!(
        text.contains("Tagged by Kopibon — nhentai gallery 528499"),
        "writer must emit the current product string"
    );
    let _ = std::fs::remove_file(&tmp);
}
