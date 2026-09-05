//! Scanner-scheme thumbnails (library-scanner.worker.ts:479-574).
//!
//! Naming: `sha1(absolute_path)[0..16].jpg` in the thumbnail dir — content-
//! addressed by full path, shared dir with the download scheme; never unified
//! (01-current-architecture §7). Size 600×800 fit-inside (never upscale),
//! quality 82. JPEG bytes are NOT byte-critical (plan §6): cache artefacts,
//! the DB stores only the bare filename. sharp → the `image` crate.
//!
//! PDF covers: 1.x shells to `pdftoppm`. The native rasteriser choice (D3 /
//! Q-S4) is an open escalation — until it lands PDF thumbnails are absent
//! (as on a poppler-less 1.x install), loudly: every attempt is reported as
//! a failure by the caller, never silently dropped.

use sha1::{Digest, Sha1};

pub const THUMB_WIDTH: u32 = 600;
pub const THUMB_HEIGHT: u32 = 800;
pub const THUMB_QUALITY: u8 = 82;

/// `createHash('sha1').update(path).digest('hex').slice(0, 16)` (:489, :548).
pub fn thumbnail_filename(absolute_path: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(absolute_path.as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}.jpg", &hex[..16])
}

/// Generate the CBZ thumbnail: first non-`ComicInfo.xml` entry, resized
/// fit-inside, JPEG q82 (:483-537). Returns the thumb path, or None when
/// generation failed (non-image first entry, unreadable archive, …).
pub fn generate_cbz_thumbnail(
    file_path: &std::path::Path,
    thumbnail_dir: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let thumb_path = thumbnail_dir.join(thumbnail_filename(&file_path.to_string_lossy()));
    if thumb_path.exists() {
        return Some(thumb_path);
    }

    let file = std::fs::File::open(file_path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;

    // First entry that is not exactly 'ComicInfo.xml' (:504-518).
    let mut image_bytes: Option<Vec<u8>> = None;
    for i in 0..archive.len() {
        if let Ok(mut entry) = archive.by_index(i) {
            if entry.name() == "ComicInfo.xml" {
                continue; // skip metadata — look for first image
            }
            let mut buf = Vec::new();
            if std::io::Read::read_to_end(&mut entry, &mut buf).is_ok() {
                image_bytes = Some(buf);
            }
            break;
        }
    }
    let data = image_bytes?;

    encode_thumbnail(&data, &thumb_path)
}

/// Resize fit-inside (never upscale) + JPEG q82. sharp's silent catch becomes
/// a None here; the caller logs it (07-metadata-spec §12.1).
fn encode_thumbnail(image_bytes: &[u8], thumb_path: &std::path::Path) -> Option<std::path::PathBuf> {
    let img = image::load_from_memory(image_bytes).ok()?;

    // fit: 'inside' — scale to fit within the box, never upscale.
    let (w, h) = (img.width(), img.height());
    let scaled = if w <= THUMB_WIDTH && h <= THUMB_HEIGHT {
        img
    } else {
        let ratio = (THUMB_WIDTH as f64 / w as f64).min(THUMB_HEIGHT as f64 / h as f64);
        let (nw, nh) = ((w as f64 * ratio).round() as u32, (h as f64 * ratio).round() as u32);
        img.resize_exact(nw.max(1), nh.max(1), image::imageops::FilterType::Lanczos3)
    };

    // sharp's .jpeg() is 3-channel; drop alpha if present.
    let rgb = scaled.to_rgb8();
    let mut out = std::fs::File::create(thumb_path).ok()?;
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, THUMB_QUALITY);
    rgb.write_with_encoder(encoder).ok()?;
    Some(thumb_path.to_path_buf())
}
