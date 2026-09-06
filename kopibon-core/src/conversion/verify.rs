//! verifyCbz port (convert-cbz.worker.ts:106-176) — the integrity gate.
//! Every valid archive must pass; every tampered one must fail on the
//! specific check.

use crate::scanner::extract::comicinfo::parse_comic_info_xml;

/// `/\.(jpe?g|png|gif|bmp|webp)$/i` (:140).
fn is_image(name: &str) -> bool {
    let lower = name.to_lowercase();
    [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

pub fn verify_cbz(output_path: &std::path::Path, expected_pages: usize) -> bool {
    let Ok(file) = std::fs::File::open(output_path) else {
        return false;
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return false;
    };

    let mut entry_index = 0usize;
    let mut image_count = 0usize;
    let mut comic_info_is_first = false;
    let mut comic_info_parsed = false;
    let mut image_names: Vec<String> = Vec::new();

    for i in 0..archive.len() {
        let Ok(mut entry) = archive.by_index(i) else {
            return false;
        };
        let name = entry.name().to_string();
        if name == "ComicInfo.xml" {
            if entry_index == 0 {
                comic_info_is_first = true;
            }
            let mut xml_bytes = Vec::new();
            if std::io::Read::read_to_end(&mut entry, &mut xml_bytes).is_err() {
                return false;
            }
            let Ok(xml) = String::from_utf8(xml_bytes) else {
                return false;
            };
            let parsed = parse_comic_info_xml(&xml);
            match parsed.title {
                Some(t) if !t.is_empty() => {}
                _ => return false,
            }
            comic_info_parsed = true;
            // ComicInfo.xml is NOT an image — do NOT increment imageCount.
            entry_index += 1;
        } else if is_image(&name) {
            image_names.push(name);
            image_count += 1;
            entry_index += 1;
        } else {
            entry_index += 1;
        }
    }

    let total_entries = entry_index;
    if !comic_info_is_first || !comic_info_parsed {
        return false;
    }
    if image_count != expected_pages {
        return false;
    }
    if total_entries != expected_pages + 1 {
        return false;
    }

    // Zero-padded, sequential, each entry preserving its own extension
    // (:159-163).
    for (i, name) in image_names.iter().enumerate() {
        let ext = std::path::Path::new(name)
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_else(|| ".jpg".to_string());
        let expected_name = format!("{:04}{}", i + 1, ext);
        if *name != expected_name {
            return false;
        }
    }

    true
}
