//! extractCbzMetadata port (library-scanner.worker.ts:338-417): stream the
//! root `ComicInfo.xml` entry, map it onto the shared ExtractedMetadata shape.
//! Gallery ID recovery precedence: Web > Notes > filename (filename handled by
//! processFile).

use super::comicinfo::{parse_comic_info_xml, ComicInfoMetadata};
use super::ExtractedMetadata;

/// Read the root `ComicInfo.xml` entry verbatim; `None` when the archive
/// has none (TS resolves '' and bails, :384).
pub fn read_comic_info_xml(file_path: &std::path::Path) -> Option<String> {
    let file = std::fs::File::open(file_path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;
    // First entry named exactly 'ComicInfo.xml' (:356-374).
    for i in 0..archive.len() {
        if let Ok(mut entry) = archive.by_index(i) {
            if entry.name() == "ComicInfo.xml" {
                let mut contents = String::new();
                std::io::Read::read_to_string(&mut entry, &mut contents).ok()?;
                return Some(contents);
            }
        }
    }
    None
}

/// `/nhentai\.net\/g\/(\d+)/` over the Web field (:404).
fn gallery_id_from_web(web: &str) -> Option<i64> {
    let re = regex::Regex::new(r"nhentai\.net/g/(\d+)").unwrap();
    re.captures(web)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<i64>().ok())
}

/// `/nhentai gallery (\d+)/i` over Notes (:408).
fn gallery_id_from_notes(notes: &str) -> Option<i64> {
    let re = regex::Regex::new(r"(?i)nhentai gallery (\d+)").unwrap();
    re.captures(notes)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<i64>().ok())
}

pub fn extract_cbz_metadata(file_path: &std::path::Path) -> ExtractedMetadata {
    let mut metadata = ExtractedMetadata::default();
    let Some(xml) = read_comic_info_xml(file_path) else {
        return metadata;
    };
    if xml.is_empty() {
        return metadata;
    }

    let parsed: ComicInfoMetadata = parse_comic_info_xml(&xml);

    metadata.title = parsed.title.clone().filter(|t| !t.is_empty());
    metadata.authors = parsed.writers.clone();
    metadata.tags = parsed
        .genres
        .iter()
        .chain(parsed.tags.iter())
        .cloned()
        .collect();
    // Series==Title is "no real series" (:391-396).
    metadata.series_name = match (&parsed.series, &parsed.title) {
        (Some(series), Some(title)) if series != title => Some(series.clone()),
        _ => None,
    };
    metadata.series_index = parsed.volume;
    metadata.language = parsed.language_iso.clone().filter(|l| !l.is_empty());
    metadata.publisher = parsed.publisher.clone().filter(|p| !p.is_empty());
    metadata.description = parsed.summary.clone().filter(|d| !d.is_empty());

    // Web > Notes > filename (:402-410)
    if let Some(web) = &parsed.web_url {
        if let Some(g) = gallery_id_from_web(web) {
            metadata.gallery_id = Some(g);
        }
    }
    if metadata.gallery_id.is_none() {
        if let Some(notes) = &parsed.notes {
            if let Some(g) = gallery_id_from_notes(notes) {
                metadata.gallery_id = Some(g);
            }
        }
    }
    metadata
}
