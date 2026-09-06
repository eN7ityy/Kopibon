//! Shared fixture builders for the scanner suites: a synthesised library
//! tree (PDFs with docinfo/XMP, CBZs with ComicInfo.xml, noise, reserved and
//! dot directories) plus JS-side seeding via repo_harness `execSql`.

#![allow(dead_code)]

use std::io::Write;
use std::path::{Path, PathBuf};

/// A tiny valid JPEG (real image crate output) used as a cover page.
pub fn cover_jpeg(width: u32, height: u32) -> Vec<u8> {
    let img = image::RgbaImage::from_pixel(width, height, image::Rgba([180, 40, 40, 255]));
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut buf, image::ImageFormat::Jpeg)
        .expect("encode jpeg");
    buf.into_inner()
}

/// Build a minimal single-page PDF with an /Info dict and an optional XMP
/// metadata stream (indirect object, same shape the writers produce).
pub fn build_pdf(
    path: &Path,
    info: &[(&str, String)],
    xmp: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    use lopdf::{Dictionary, Object, Stream};

    fn name(s: &str) -> Object {
        Object::Name(s.as_bytes().to_vec())
    }
    let mut doc = lopdf::Document::with_version("1.4");
    let pages_id = doc.new_object_id();
    let page_dict = Dictionary::from_iter([
        (b"Type".to_vec(), name("Page")),
        (b"Parent".to_vec(), Object::Reference(pages_id)),
        (
            b"MediaBox".to_vec(),
            Object::Array(vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::Integer(612),
                Object::Integer(792),
            ]),
        ),
        (
            b"Resources".to_vec(),
            Dictionary::from_iter([(
                b"Font".to_vec(),
                Dictionary::new().into(),
            )])
            .into(),
        ),
    ]);
    let page_id = doc.add_object(page_dict);
    let font_id = doc.add_object(Dictionary::from_iter([
        (b"Type".to_vec(), name("Font")),
        (b"Subtype".to_vec(), name("Type1")),
        (b"BaseFont".to_vec(), "Helvetica".into()),
    ]));
    let content = Stream::new(
        Dictionary::new(),
        b"BT /F1 24 Tf 72 720 Td (fixture) Tj ET".to_vec(),
    );
    let content_id = doc.add_object(content);
    let page_dict2 = Dictionary::from_iter([
        (b"Type".to_vec(), name("Page")),
        (b"Parent".to_vec(), Object::Reference(pages_id)),
        (
            b"MediaBox".to_vec(),
            Object::Array(vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::Integer(612),
                Object::Integer(792),
            ]),
        ),
        (
            b"Resources".to_vec(),
            Dictionary::from_iter([(
                b"Font".to_vec(),
                Dictionary::from_iter([(b"F1".to_vec(), Object::Reference(font_id))]).into(),
            )])
            .into(),
        ),
        (b"Contents".to_vec(), Object::Reference(content_id)),
    ]);
    doc.set_object(page_id, page_dict2);
    let pages_dict = Dictionary::from_iter([
        (b"Type".to_vec(), name("Pages")),
        (b"Kids".to_vec(), Object::Array(vec![Object::Reference(page_id)])),
        (b"Count".to_vec(), Object::Integer(1)),
    ]);
    doc.set_object(pages_id, pages_dict);

    let info_dict = Dictionary::from_iter(info.iter().map(|(k, v)| {
        (
            k.as_bytes().to_vec(),
            Object::String(v.clone().into_bytes(), lopdf::StringFormat::Literal),
        )
    }));
    let info_id = doc.add_object(info_dict);

    let catalog_id = doc.add_object(Dictionary::from_iter([
        (b"Type".to_vec(), name("Catalog")),
        (b"Pages".to_vec(), Object::Reference(pages_id)),
    ]));
    if let Some(packet) = xmp {
        let stream = Stream::new(
            Dictionary::from_iter([
                (b"Type".to_vec(), name("Metadata")),
                (b"Subtype".to_vec(), name("XML")),
            ]),
            packet.as_bytes().to_vec(),
        );
        let metadata_id = doc.add_object(stream);
        doc.set_object(
            catalog_id,
            Dictionary::from_iter([
                (b"Type".to_vec(), name("Catalog")),
                (b"Pages".to_vec(), Object::Reference(pages_id)),
                (b"Metadata".to_vec(), Object::Reference(metadata_id)),
            ]),
        );
    }
    doc.trailer.set("Root", Object::Reference(catalog_id));
    doc.trailer.set("Info", Object::Reference(info_id));
    doc.trailer.set("Size", Object::Integer(doc.max_id as i64 + 1));
    doc.save(path)?;
    Ok(())
}

/// Build a PDF whose pages are embedded DCTDecode JPEGs (the shape the S4
/// extraction path consumes).
pub fn build_image_pdf(path: &Path, jpegs: &[Vec<u8>]) -> Result<(), Box<dyn std::error::Error>> {
    build_image_pdf_with_count(path, jpegs, jpegs.len() as i64)
}

/// `declared_count` lets a test write a page tree whose Count disagrees with
/// the embedded image count (the count-guard fixture).
pub fn build_image_pdf_with_count(
    path: &Path,
    jpegs: &[Vec<u8>],
    declared_count: i64,
) -> Result<(), Box<dyn std::error::Error>> {
    use lopdf::{Dictionary, Object, Stream};

    fn name(s: &str) -> Object {
        Object::Name(s.as_bytes().to_vec())
    }
    let mut doc = lopdf::Document::with_version("1.4");
    // Insert the (empty) Pages dict immediately so no later add_object can
    // collide with its id; fill it at the end.
    let pages_id = doc.add_object(Dictionary::new());
    let mut kids: Vec<Object> = Vec::new();

    for (i, jpeg) in jpegs.iter().enumerate() {
        let (w, h) = (612.0f32, 792.0f32);
        let content = format!("q {w} 0 0 {h} 0 0 cm /Im{i} Do Q\n");
        let image_stream = Stream::new(
            Dictionary::from_iter([
                (b"Type".to_vec(), name("XObject")),
                (b"Subtype".to_vec(), name("Image")),
                (b"Width".to_vec(), Object::Integer(612)),
                (b"Height".to_vec(), Object::Integer(792)),
                (b"ColorSpace".to_vec(), name("DeviceRGB")),
                (b"BitsPerComponent".to_vec(), Object::Integer(8)),
                (b"Filter".to_vec(), name("DCTDecode")),
            ]),
            jpeg.clone(),
        );
        let image_id = doc.add_object(image_stream);
        // Contents must be an INDIRECT stream object (nested streams in a
        // dict break lopdf's writer — same class as the S1 metadata lesson).
        let content_id = doc.add_object(Stream::new(Dictionary::new(), content.into_bytes()));
        let page_dict = Dictionary::from_iter([
            (b"Type".to_vec(), name("Page")),
            (b"Parent".to_vec(), Object::Reference(pages_id)),
            (
                b"MediaBox".to_vec(),
                Object::Array(vec![
                    Object::Integer(0),
                    Object::Integer(0),
                    Object::Integer(612),
                    Object::Integer(792),
                ]),
            ),
            (
                b"Resources".to_vec(),
                Dictionary::from_iter([(
                    b"XObject".to_vec(),
                    Dictionary::from_iter([(format!("Im{i}").into_bytes(), Object::Reference(image_id))])
                        .into(),
                )])
                .into(),
            ),
            (b"Contents".to_vec(), Object::Reference(content_id)),
        ]);
        let page_id = doc.add_object(page_dict);
        kids.push(Object::Reference(page_id));
    }

    doc.set_object(
        pages_id,
        Dictionary::from_iter([
            (b"Type".to_vec(), name("Pages")),
            (b"Kids".to_vec(), Object::Array(kids)),
            (b"Count".to_vec(), Object::Integer(declared_count)),
        ]),
    );
    let catalog_id = doc.add_object(Dictionary::from_iter([
        (b"Type".to_vec(), name("Catalog")),
        (b"Pages".to_vec(), Object::Reference(pages_id)),
    ]));
    // pdf-lib always writes an Info dict; the XMP writer updates it in place.
    let info_id = doc.add_object(Dictionary::from_iter([
        (b"Producer".to_vec(), "pdf-lib 1.8.0 (https://github.com/Hopding/pdf-lib)".into()),
    ]));
    doc.trailer.set("Root", Object::Reference(catalog_id));
    doc.trailer.set("Info", Object::Reference(info_id));
    doc.trailer.set("Size", Object::Integer(doc.max_id as i64 + 1));
    doc.save(path)?;
    Ok(())
}

/// Write a CBZ: ComicInfo.xml first, then cover page(s).
pub fn build_cbz(path: &Path, comic_info: &str, pages: &[Vec<u8>]) -> Result<(), Box<dyn std::error::Error>> {
    let file = std::fs::File::create(path)?;
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
    zip.start_file("ComicInfo.xml", options)?;
    zip.write_all(comic_info.as_bytes())?;
    for (i, page) in pages.iter().enumerate() {
        zip.start_file(format!("page-{i}.jpg"), options)?;
        zip.write_all(page)?;
    }
    zip.finish()?;
    Ok(())
}

/// Pin the mtime of a file so the newest-first walk order is deterministic.
pub fn set_mtime(path: &Path, epoch_ms: i64) {
    let secs = epoch_ms / 1000;
    let nsecs = ((epoch_ms % 1000) * 1_000_000) as u32;
    let t = std::time::UNIX_EPOCH + std::time::Duration::new(secs as u64, nsecs);
    std::fs::File::options()
        .write(true)
        .open(path)
        .and_then(|f| f.set_times(std::fs::FileTimes::new().set_accessed(t).set_modified(t)))
        .expect("set mtime");
}

pub struct Fixture {
    pub root: PathBuf,
    /// Absolute paths of the discovered PDF/CBZ files, in a fixed order.
    pub files: Vec<PathBuf>,
}

/// The standard extraction fixture tree.
///
/// (name, kind, mtime) — every file gets a distinct mtime so the
/// newest-first sort cannot tie (ties would keep readdir order, which differs
/// between node and rust).
pub fn build_extraction_fixture(base: &Path) -> Result<Fixture, Box<dyn std::error::Error>> {
    let root = base.join("library");
    std::fs::create_dir_all(&root)?;

    let mut base_ms = 1_700_000_000_000_i64;
    let mut next_mtime = || {
        base_ms += 60_000;
        base_ms
    };

    let page = cover_jpeg(800, 1200);

    // ── CBZ: full ComicInfo, gallery via Web ────────────────────────────────
    let f = root.join("artistA");
    std::fs::create_dir_all(&f)?;
    let p = f.join("Full Metadata [nhentai-559001].cbz");
    build_cbz(
        &p,
        r#"<?xml version="1.0" encoding="utf-8"?>
<ComicInfo>
  <Title>Full Metadata</Title>
  <Series>Full Series</Series>
  <Number>3.5</Number>
  <Summary>A &amp; B &lt;test&gt; summary</Summary>
  <Writer>Writer One, Writer Two</Writer>
  <Publisher>Publisher X</Publisher>
  <Genre>genre1, genre2</Genre>
  <Tags>tag1, tag2</Tags>
  <PageCount>2</PageCount>
  <LanguageISO>en</LanguageISO>
  <Web>https://nhentai.net/g/559001/</Web>
  <Notes>Downloaded from nhentai gallery 559001</Notes>
</ComicInfo>"#,
        std::slice::from_ref(&page),
    )?;
    set_mtime(&p, next_mtime());
    drop(p);

    // ── CBZ: filename marker only (no gallery in metadata) ─────────────────
    let p = f.join("[nhentai-111111] Marker Title.cbz");
    build_cbz(
        &p,
        r#"<?xml version="1.0" encoding="utf-8"?>
<ComicInfo>
  <Title>Marker Title</Title>
  <Series>Marker Title</Series>
</ComicInfo>"#,
        std::slice::from_ref(&page),
    )?;
    set_mtime(&p, next_mtime());
    drop(p);

    // ── CBZ: Volume legacy + entities + Series==Title variant ─────────────
    let p = f.join("Legacy Volume.cbz");
    build_cbz(
        &p,
        r#"<?xml version="1.0" encoding="utf-8"?>
<ComicInfo>
  <Title>Caf&#233; &amp; co</Title>
  <Series>Caf&#233; &amp; co</Series>
  <Volume>7</Volume>
  <Writer>Solo Writer</Writer>
  <Genre>A, B</Genre>
</ComicInfo>"#,
        std::slice::from_ref(&page),
    )?;
    set_mtime(&p, next_mtime());
    drop(p);

    // ── PDF: docinfo only, keywords tokens, comma authors ──────────────────
    let d = f.join("SeriesD");
    std::fs::create_dir_all(&d)?;
    let p = d.join("vol1.pdf");
    build_pdf(
        &p,
        &[
            ("Title", "Docinfo Title".to_string()),
            ("Author", "Doc Author, Second Author".to_string()),
            (
                "Keywords",
                "tagA, series_index:4.5, calibre_series:Doc Series, language:jpn, publisher:Doc Pub".to_string(),
            ),
            ("CreationDate", "D:20240828124228+09'00'".to_string()),
        ],
        None,
    )?;
    set_mtime(&p, next_mtime());
    drop(p);

    // ── PDF: docinfo + Subject series fallback ─────────────────────────────
    let p = d.join("vol2.pdf");
    build_pdf(
        &p,
        &[
            ("Title", "Subject Series Title".to_string()),
            ("Subject", "Subject Series".to_string()),
        ],
        None,
    )?;
    set_mtime(&p, next_mtime());
    drop(p);

    // ── PDF: XMP nested series + bag language + alt description + isbn ────
    let d = root.join("artistB").join("nested");
    std::fs::create_dir_all(&d)?;
    let p = d.join("xmp_nested.pdf");
    let xmp = r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:calibre="http://calibre.kovidgoyal.net/2009/metadata" xmlns:ns0="http://ns0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/">
      <calibre:series rdf:parseType="Resource"><rdf:value>XMP Nested Series</rdf:value></calibre:series>
      <ns0:series_index>12</ns0:series_index>
      <dc:language><rdf:Bag><rdf:li>eng</rdf:li></rdf:Bag></dc:language>
      <dc:publisher><rdf:Bag><rdf:li>XMP Publisher</rdf:li></rdf:Bag></dc:publisher>
      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">XMP &amp;amp; description</rdf:li></rdf:Alt></dc:description>
      <dc:title><rdf:Bag><rdf:li>XMP Title</rdf:li></rdf:Bag></dc:title>
      <dc:creator><rdf:Bag><rdf:li>XMP Author</rdf:li></rdf:Bag></dc:creator>
      <dc:date>2024-08-28T12:42:28Z</dc:date>
      <pdfx:isbn>555888</pdfx:isbn>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>"#;
    build_pdf(
        &p,
        &[
            ("Keywords", "nhentai:222333".to_string()),
        ],
        Some(xmp),
    )?;
    set_mtime(&p, next_mtime());
    drop(p);

    // ── PDF: XMP flat forms ────────────────────────────────────────────────
    let p = d.join("xmp_flat.pdf");
    let xmp_flat = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:calibre="http://calibre.kovidgoyal.net/2009/metadata" xmlns:calibreSI="http://calibreSI" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <calibre:series>Flat Series</calibre:series>
      <calibreSI:series_index>2.5</calibreSI:series_index>
      <dc:language>jpn</dc:language>
      <dc:description>Flat description</dc:description>
      <dc:title><rdf:Bag><rdf:li>Flat XMP Title</rdf:li></rdf:Bag></dc:title>
      <dc:creator><rdf:Bag><rdf:li>Flat Creator</rdf:li></rdf:Bag></dc:creator>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>"#;
    build_pdf(&p, &[("Subject", "Flat Subject".to_string())], Some(xmp_flat))?;
    set_mtime(&p, next_mtime());
    drop(p);

    // ── PDF: nhentai gallery id in Keywords, unparseable XMP date shape ───
    let p = d.join("keywords_gallery.pdf");
    build_pdf(
        &p,
        &[
            ("Title", "Keywords Gallery".to_string()),
            ("Keywords", "series_index:9, calibre_series:Kw Series, nhentai:777888".to_string()),
        ],
        None,
    )?;
    set_mtime(&p, next_mtime());
    drop(p);

    // ── noise: reserved dirs, dot dir, non-pdf/cbz ──────────────────────────
    let unsorted = root.join("_Unsorted");
    std::fs::create_dir_all(&unsorted)?;
    std::fs::write(unsorted.join("ignored.pdf"), b"not really a pdf")?;
    let hidden = root.join(".hidden");
    std::fs::create_dir_all(&hidden)?;
    build_pdf(&hidden.join("hidden.pdf"), &[("Title", "Hidden".to_string())], None)?;
    std::fs::write(root.join("notes.txt"), b"noise")?;
    std::fs::write(root.join("readme.md"), b"noise")?;

    // Discovered set (absolute paths).
    let mut files: Vec<PathBuf> = vec![
        root.join("artistA/Full Metadata [nhentai-559001].cbz"),
        root.join("artistA/[nhentai-111111] Marker Title.cbz"),
        root.join("artistA/Legacy Volume.cbz"),
        root.join("artistA/SeriesD/vol1.pdf"),
        root.join("artistA/SeriesD/vol2.pdf"),
        root.join("artistB/nested/xmp_nested.pdf"),
        root.join("artistB/nested/xmp_flat.pdf"),
        root.join("artistB/nested/keywords_gallery.pdf"),
    ];
    // Newest first: assign increasing mtimes and reverse.
    files.reverse();
    Ok(Fixture { root, files })
}

/// Seed rows on the Rust side (mirror of the JS execSql op).
pub fn exec_sql(conn: &rusqlite::Connection, statements: &[(&str, Vec<rusqlite::types::Value>)]) {
    for (sql, params) in statements {
        conn.execute(sql, rusqlite::params_from_iter(params.iter()))
            .expect("exec fixture sql");
    }
}
