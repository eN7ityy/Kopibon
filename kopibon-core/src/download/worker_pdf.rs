//! download-pdf.worker.ts / pdf-generator.ts port — one image-only PDF, one
//! DCTDecode XObject per page, page boxes per pageSize mode, aspect-preserving
//! centred draw, optional black background rect (03 §6).
//!
//! Compression mirrors 1.x: quality < 100 re-encodes every page as JPEG (via
//! the `image` crate where 1.x used sharp); quality = 100 embeds the original
//! JPEG bytes directly. pdf-lib could also embed PNGs as Flate streams — the
//! port re-encodes those as JPEG instead (downloads are JPEG in practice;
//! documented deviation, ledger row on first real case).

use lopdf::{Dictionary, Object, Stream};

pub const DYNAMIC_WIDTH: f64 = 1800.0;

#[derive(Debug, Clone, PartialEq)]
pub struct PdfOptions {
    pub page_size: String, // 'dynamic' | 'fit' | 'letter' | 'a4'
    pub quality: i64,      // 1-95 compress, 100 = embed original
    pub black_background: bool,
}

impl Default for PdfOptions {
    fn default() -> Self {
        PdfOptions {
            page_size: "dynamic".to_string(),
            quality: 80,
            black_background: true,
        }
    }
}

struct DecodedPage {
    /// JPEG bytes to embed with DCTDecode.
    jpeg: Vec<u8>,
    width: u32,
    height: u32,
}

fn decode_page(path: &std::path::Path, quality: i64, log: &mut dyn FnMut(String)) -> Option<DecodedPage> {
    let buffer = std::fs::read(path).ok()?;
    let is_jpeg = buffer.starts_with(&[0xFF, 0xD8]);

    if quality < 100 || !is_jpeg {
        // sharp path: decode + re-encode as JPEG at the configured quality.
        let img = match image::load_from_memory(&buffer) {
            Ok(img) => img.to_rgb8(),
            Err(e) => {
                log(format!("image decode failed for {}: {e}", path.display()));
                return None;
            }
        };
        let (w, h) = (img.width(), img.height());
        let mut jpeg = std::io::Cursor::new(Vec::new());
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, quality.clamp(1, 95) as u8);
        if let Err(e) = img.write_with_encoder(encoder) {
            log(format!("jpeg encode failed for {}: {e}", path.display()));
            return None;
        }
        Some(DecodedPage {
            jpeg: jpeg.into_inner(),
            width: w,
            height: h,
        })
    } else {
        // quality 100 + already-JPEG: embed the original bytes (embedJpg).
        let (w, h) = match image::load_from_memory(&buffer) {
            Ok(img) => (img.width(), img.height()),
            Err(e) => {
                log(format!("dimension probe failed for {}: {e}", path.display()));
                return None;
            }
        };
        Some(DecodedPage {
            jpeg: buffer,
            width: w,
            height: h,
        })
    }
}

/// generatePdf (pdf-generator.ts:46-200).
pub fn generate_pdf(
    image_paths: &[std::path::PathBuf],
    output_path: &std::path::Path,
    options: &PdfOptions,
    log: &mut dyn FnMut(String),
) -> Result<std::path::PathBuf, String> {
    let mut doc = lopdf::Document::with_version("1.4");
    let pages_id = doc.new_object_id();
    let mut kids: Vec<Object> = Vec::new();
    let mut page_count: usize = 0;

    for image_path in image_paths {
        let Some(page_img) = decode_page(image_path, options.quality, log) else {
            // Unfixable page: dropped with a loud log, never silent
            // (pdf-generator.ts:121-125 — the sanctioned loudness fix).
            continue;
        };

        let img_aspect = page_img.width as f64 / page_img.height as f64;
        let (page_width, page_height) = match options.page_size.as_str() {
            "dynamic" => (DYNAMIC_WIDTH, (DYNAMIC_WIDTH / img_aspect).round()),
            "a4" => (595.28, 841.89),
            "letter" => (612.0, 792.0),
            // 'fit' and default: the image's own dimensions.
            _ => (page_img.width as f64, page_img.height as f64),
        };

        // Aspect-preserving fit + centring (:162-179).
        let page_aspect = page_width / page_height;
        let (draw_width, draw_height) = if img_aspect > page_aspect {
            (page_width, page_width / img_aspect)
        } else {
            (page_height * img_aspect, page_height)
        };
        let x = (page_width - draw_width) / 2.0;
        let y = (page_height - draw_height) / 2.0;

        // Content: optional black background rect, then the image draw.
        let mut content = String::new();
        if options.black_background {
            content.push_str(&format!("0 0 0 rg 0 0 {page_width} {page_height} re f\n"));
        }
        content.push_str(&format!(
            "q {draw_width} 0 0 {draw_height} {x} {y} cm /Im0 Do Q\n"
        ));

        let image_dict = Dictionary::from_iter([
            (b"Type".to_vec(), Object::Name(b"XObject".to_vec())),
            (b"Subtype".to_vec(), Object::Name(b"Image".to_vec())),
            (b"Width".to_vec(), Object::Integer(page_img.width as i64)),
            (b"Height".to_vec(), Object::Integer(page_img.height as i64)),
            (b"ColorSpace".to_vec(), Object::Name(b"DeviceRGB".to_vec())),
            (b"BitsPerComponent".to_vec(), Object::Integer(8)),
            (b"Filter".to_vec(), Object::Name(b"DCTDecode".to_vec())),
        ]);
        let image_stream = Stream::new(image_dict, page_img.jpeg);
        let image_id = doc.add_object(image_stream);

        let page_dict = Dictionary::from_iter([
            (b"Type".to_vec(), Object::Name(b"Page".to_vec())),
            (b"Parent".to_vec(), Object::Reference(pages_id)),
            (
                b"MediaBox".to_vec(),
                Object::Array(vec![
                    Object::Real(0.0),
                    Object::Real(0.0),
                    Object::Real(page_width as f32),
                    Object::Real(page_height as f32),
                ]),
            ),
            (
                b"Resources".to_vec(),
                Dictionary::from_iter([
                    (
                        b"XObject".to_vec(),
                        Dictionary::from_iter([(b"Im0".to_vec(), Object::Reference(image_id))]).into(),
                    ),
                    (
                        b"ProcSet".to_vec(),
                        Object::Array(vec![
                            Object::Name(b"PDF".to_vec()),
                            Object::Name(b"ImageC".to_vec()),
                        ]),
                    ),
                ])
                .into(),
            ),
            (
                b"Contents".to_vec(),
                Stream::new(Dictionary::new(), content.into_bytes()).into(),
            ),
        ]);
        let page_id = doc.add_object(page_dict);
        kids.push(Object::Reference(page_id));
        page_count += 1;
    }

    if kids.is_empty() {
        return Err("PDF generation failed: no usable pages".to_string());
    }

    doc.set_object(
        pages_id,
        Dictionary::from_iter([
            (b"Type".to_vec(), Object::Name(b"Pages".to_vec())),
            (b"Kids".to_vec(), Object::Array(kids)),
            (b"Count".to_vec(), Object::Integer(page_count as i64)),
        ]),
    );

    let catalog_id = doc.add_object(Dictionary::from_iter([
        (b"Type".to_vec(), Object::Name(b"Catalog".to_vec())),
        (b"Pages".to_vec(), Object::Reference(pages_id)),
    ]));
    // pdf-lib's save always writes an Info dict (defaults below); the XMP
    // writer then updates it in place — write_pdf_metadata refuses to write
    // into a document without one.
    let info_id = doc.add_object(Dictionary::from_iter([
        (
            b"Producer".to_vec(),
            Object::String(
                b"pdf-lib 1.8.0 (https://github.com/Hopding/pdf-lib)".to_vec(),
                lopdf::StringFormat::Literal,
            ),
        ),
        (
            b"Creator".to_vec(),
            Object::String(
                b"pdf-lib (https://github.com/Hopding/pdf-lib)".to_vec(),
                lopdf::StringFormat::Literal,
            ),
        ),
    ]));
    doc.trailer.set("Root", Object::Reference(catalog_id));
    doc.trailer.set("Info", Object::Reference(info_id));
    doc.trailer.set("Size", Object::Integer(doc.max_id as i64 + 1));

    doc.save(output_path).map_err(|e| format!("PDF save failed: {e}"))?;
    Ok(output_path.to_path_buf())
}
