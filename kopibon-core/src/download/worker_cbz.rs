//! download-cbz.worker.ts port — StoreZipWriter assembly (ComicInfo.xml
//! first, pages STOREd) via the metadata writers, `.part` sibling + atomic
//! rename, and the download-scheme thumbnail: `<thumbnailDir>/<galleryId>.jpg`
//! @300×400 q80 from the first page — the SECOND naming scheme, shared dir
//! with the scanner scheme; never unified (01-current-architecture §7).

use crate::metadata::filenames::temp_sibling_path;
use crate::metadata::writers::comicinfo::comicinfo_for_archive;
use crate::metadata::writers::zip::StoreZipWriter;
use crate::metadata::context::FileMetadata;

pub const THUMB_WIDTH: u32 = 300;
pub const THUMB_HEIGHT: u32 = 400;
pub const THUMB_QUALITY: u8 = 80;

/// generateCbz (cbz-generator.ts:110-151 via the workers): pages from disk,
/// written to `<out>.part` then renamed.
pub fn generate_cbz_from_paths(
    image_paths: &[std::path::PathBuf],
    output_path: &std::path::Path,
    meta: &FileMetadata,
    mtime: u64,
    page_ext: &str,
) -> Result<std::path::PathBuf, String> {
    let page_count = image_paths.len();
    let ci_xml = comicinfo_for_archive(meta, page_count)?;
    if let Some(parent) = output_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let part_path = temp_sibling_path(output_path);
    {
        let file = std::fs::File::create(&part_path).map_err(|e| e.to_string())?;
        let mut writer = StoreZipWriter::new(file);
        writer
            .add_first_entry("ComicInfo.xml", &ci_xml, mtime)
            .map_err(|e| e.to_string())?;
        for (i, page) in image_paths.iter().enumerate() {
            let bytes = std::fs::read(page).map_err(|e| format!("page {}: {e}", page.display()))?;
            let name = format!("{:04}.{page_ext}", i + 1);
            writer
                .add_streamed(&name, bytes.as_slice(), mtime)
                .map_err(|e| e.to_string())?;
        }
        writer.finish().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&part_path, output_path).map_err(|e| e.to_string())?;
    Ok(output_path.to_path_buf())
}

/// The download-worker thumbnail (download-cbz.worker.ts:100-108): first page
/// → `<dir>/<galleryId>.jpg` fit-inside 300×400 q80. Non-fatal on failure.
pub fn generate_download_thumbnail(
    first_image_path: &std::path::Path,
    thumbnail_dir: &std::path::Path,
    gallery_id: i64,
) -> Option<std::path::PathBuf> {
    let _ = std::fs::create_dir_all(thumbnail_dir);
    let thumb_path = thumbnail_dir.join(format!("{gallery_id}.jpg"));
    let buffer = std::fs::read(first_image_path).ok()?;
    let img = image::load_from_memory(&buffer).ok()?;
    let (w, h) = (img.width(), img.height());
    let scaled = if w <= THUMB_WIDTH && h <= THUMB_HEIGHT {
        img
    } else {
        let ratio = (THUMB_WIDTH as f64 / w as f64).min(THUMB_HEIGHT as f64 / h as f64);
        img.resize_exact(
            ((w as f64 * ratio).round() as u32).max(1),
            ((h as f64 * ratio).round() as u32).max(1),
            image::imageops::FilterType::Lanczos3,
        )
    };
    let rgb = scaled.to_rgb8();
    let mut out = std::fs::File::create(&thumb_path).ok()?;
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, THUMB_QUALITY);
    rgb.write_with_encoder(encoder).ok()?;
    Some(thumb_path)
}
