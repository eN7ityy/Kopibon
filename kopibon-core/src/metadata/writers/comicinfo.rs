//! ComicInfoWriter — render + the CBZ rewrite pass (08/01 §5; sources:
//! cbz-generator.ts, apply-metadata.ts:114-192).
//!
//! PageCount is always derived from the archive/image list, never the caller
//! (07-metadata-spec §4; cbz-generator.ts:63). A rewrite rebuilds the archive
//! with ComicInfo.xml as the FIRST entry, every other entry copied STOREd in
//! original order, then renames over the original only after a clean finish
//! and unlinks the partial on any failure.

use crate::metadata::context::FileMetadata;
use crate::metadata::filenames::temp_sibling_path;
use crate::metadata::mappers::build_comic_info_xml;
use crate::metadata::writers::zip::StoreZipWriter;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::SystemTime;

/// Entries that are page images — everything except the metadata file
/// (apply-metadata.ts:55-56).
pub fn is_image_entry(name: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)\.(jpe?g|png|gif|bmp|webp|avif|jxl)$").unwrap())
        .is_match(name)
        && name != "ComicInfo.xml"
}

/// How many page images a CBZ holds — read via the central directory,
/// nothing inflated (apply-metadata.ts:91-94; reading may use the `zip`
/// crate, writes may not, 08/01 §2).
pub fn count_cbz_pages(path: &Path) -> Result<usize, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    Ok((0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|e| e.name().to_string()))
        .filter(|n| is_image_entry(n))
        .count())
}

/// Render ComicInfo.xml for a CBZ with the derived page count.
pub fn comicinfo_for_archive(meta: &FileMetadata, image_count: usize) -> Result<Vec<u8>, String> {
    let mut m = meta.clone();
    m.page_count = if image_count > 0 {
        image_count as f64
    } else {
        m.page_count
    };
    Ok(build_comic_info_xml(&m)?.into_bytes())
}

/// Rewrite ComicInfo.xml inside an existing CBZ (apply-metadata.ts:114-192):
/// entry names enumerated first for an accurate PageCount; new ComicInfo
/// written FIRST; every other entry copied in original order, skipping
/// directories and the old metadata file; atomic rename, unlink on failure.
pub fn rewrite_comic_info_in_cbz(
    path: &Path,
    meta: &FileMetadata,
    mtime: u64,
) -> Result<(), String> {
    // Same 255-byte limit as the CBZ writer — the file that broke conversion
    // would have broken a metadata rewrite on sync for the same reason.
    let part_path = temp_sibling_path(path);

    let result = (|| -> Result<(), String> {
        // Pass 1: entry names, so PageCount reflects reality.
        let file = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        let names: Vec<String> = (0..archive.len())
            .filter_map(|i| archive.by_index_raw(i).ok().map(|e| e.name().to_string()))
            .collect();
        let image_count = names.iter().filter(|n| is_image_entry(n)).count();
        let ci_xml = comicinfo_for_archive(meta, image_count)?;

        // Pass 2: rebuild, ComicInfo first, entries copied sequentially.
        let part = fs::File::create(&part_path).map_err(|e| e.to_string())?;
        let mut writer = StoreZipWriter::new(part);
        writer
            .add_first_entry("ComicInfo.xml", &ci_xml, mtime)
            .map_err(|e| e.to_string())?;

        for name in &names {
            if name == "ComicInfo.xml" || name.ends_with('/') {
                continue;
            }
            let mut entry = archive.by_name(name).map_err(|e| e.to_string())?;
            // yazl's addReadStream stamps its default mode 0664 for every
            // copied entry (index.js Entry ctor) — mirror that, not the
            // source mode.
            writer
                .add_streamed_mode(name, &mut entry, mtime, 0o100_664)
                .map_err(|e| e.to_string())?;
        }
        writer.finish().map_err(|e| e.to_string())?;
        drop(archive);

        fs::rename(&part_path, path).map_err(|e| e.to_string())?;
        Ok(())
    })();

    // Never leave a partial archive behind — the scanner would ingest it.
    if result.is_err() {
        let _ = fs::remove_file(&part_path);
    }
    result
}

/// Generate a fresh CBZ from in-memory pages (cbz-generator.ts equivalent,
/// STORE pages, no transform path — sharp re-encoding stays in the download
/// worker, WP-A8). ComicInfo first with a derived PageCount, pages named
/// `%04d.jpg`, every mtime a parameter (07-metadata-spec §9).
pub fn generate_cbz(
    pages: &[Vec<u8>],
    out: &Path,
    meta: &FileMetadata,
    mtime: u64,
    page_ext: &str,
) -> Result<(), String> {
    let ci_xml = comicinfo_for_archive(meta, pages.len())?;
    if let Some(parent) = out.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let file = fs::File::create(out).map_err(|e| e.to_string())?;
    let mut writer = StoreZipWriter::new(file);
    writer
        .add_first_entry("ComicInfo.xml", &ci_xml, mtime)
        .map_err(|e| e.to_string())?;
    for (i, page) in pages.iter().enumerate() {
        let name = format!("{:04}.{}", i + 1, page_ext);
        writer
            .add_streamed(&name, page.as_slice(), mtime)
            .map_err(|e| e.to_string())?;
    }
    writer.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// Copy an entry's bytes out (helper for tests).
#[allow(dead_code)]
pub fn read_entry(path: &Path, name: &str) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut entry = archive.by_name(name).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// The mtime the writers stamp entries with when the caller has no better
/// value — the file's own mtime.
pub fn entry_mtime(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
