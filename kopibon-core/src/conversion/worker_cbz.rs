//! The 8-step conversion worker (convert-cbz.worker.ts). The ordering is the
//! safety property — do not reorder steps 1-8. Failure at any step leaves the
//! source PDF and the DB row untouched.

use std::path::{Path, PathBuf};

use crate::metadata::context::{file_metadata_from_library_item, FileMetadataOverrides};
use crate::metadata::filenames::safe_path_segment;
use crate::metadata::mappers::Clock;

use super::extract::extract_pdf_images;
use super::verify::verify_cbz;

/// The command options (library.ipc.ts:3136-3179).
pub struct ConvertOptions<'a> {
    /// `<userData>` — scratch lives at `<userData>/convert-cbz/{itemId}/`.
    pub user_data_dir: &'a Path,
    pub library_root: &'a str,
    /// From the CLAIMED QUEUE ROW, never the setting (:3179).
    pub keep_original: bool,
    pub manga_direction: String,
    /// originalsRoot setting override; empty → `<libraryRoot>/_originals`.
    pub originals_root: &'a str,
    pub thumbnail_dir: Option<&'a Path>,
}

/// The done payload (:312-328).
#[derive(Debug, Clone)]
pub struct ConvertOutcome {
    pub queue_id: i64,
    pub new_path: String,
    pub lossless: bool,
    pub original_kept: bool,
    pub forced_keep: bool,
    pub original_path: Option<String>,
}

/// The 8 ordered steps. `Ok` = verified + original handled + scratch purged.
pub fn convert_to_cbz(
    item: &super::ConvertItem,
    options: &ConvertOptions<'_>,
    clock: &dyn Clock,
    log: &mut dyn FnMut(String),
) -> Result<ConvertOutcome, String> {
    let source = Path::new(&item.file_path);

    // Step 1: source check — the message names the path (:200-202).
    if !source.exists() {
        return Err(format!("Source file not found: {}", item.file_path));
    }

    // Step 2: extract to <userData>/convert-cbz/{itemId}/ (:205-215).
    let scratch_dir = options.user_data_dir.join("convert-cbz").join(item.item_id.to_string());
    let _ = std::fs::create_dir_all(&scratch_dir);
    let extract_result = match extract_pdf_images(source, &scratch_dir, log) {
        Ok(r) => r,
        Err(e) => {
            // Extraction failure removes the scratch dir and rethrows.
            let _ = std::fs::remove_dir_all(&scratch_dir);
            return Err(format!("Extraction failed: {e}"));
        }
    };

    // Step 3: metadata from the library row, pageCount = extracted count
    // (:217-222; all decisions in the adapter, not here).
    let ci_meta = file_metadata_from_library_item(
        &item_metadata(item),
        FileMetadataOverrides {
            page_count: Some(extract_result.page_count as f64),
            manga_direction: Some(options.manga_direction.clone()),
            format: Some("cbz".to_string()),
            ..Default::default()
        },
    );

    // Step 4: generate — source with .pdf → .cbz, uniquified -1,-2,… (:225-239).
    let output_path = replace_ext(source, "cbz");
    let mut final_output = output_path.clone();
    let mut counter = 1;
    while final_output.exists() {
        final_output = replace_ext_counter(&output_path, counter);
        counter += 1;
    }
    let mtime = clock.now_ms() as u64;
    crate::download::worker_cbz::generate_cbz_from_paths(
        &extract_result.image_paths,
        &final_output,
        &ci_meta,
        mtime,
        "jpg",
    )
    .map_err(|e| format!("CBZ generation failed: {e}"))?;

    // Step 5: VERIFY (:246-259) — failure unlinks output, purges scratch.
    if !verify_cbz(&final_output, extract_result.page_count) {
        log(format!(
            "Verification failed for {}, expected {} page(s); output discarded, PDF left in place",
            final_output.display(),
            extract_result.page_count
        ));
        let _ = std::fs::remove_file(&final_output);
        let _ = std::fs::remove_dir_all(&scratch_dir);
        return Err("Verification failed — output CBZ did not pass integrity checks".to_string());
    }

    // Step 6: original handling — only after verification (:261-303).
    let forced_keep = !extract_result.lossless;
    let keep_original = options.keep_original || forced_keep;
    let mut original_path: Option<String> = None;
    if keep_original {
        let archive_root = if options.originals_root.is_empty() {
            Path::new(options.library_root).join("_originals")
        } else {
            PathBuf::from(options.originals_root)
        };
        let originals_dir = if forced_keep {
            archive_root.join("_lossy").join(safe_path_segment(Some(&item.primary_artist)))
        } else {
            archive_root.join(safe_path_segment(Some(&item.primary_artist)))
        };
        let _ = std::fs::create_dir_all(&originals_dir);
        let base = source.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let mut dest = originals_dir.join(&base);
        let mut n = 1;
        while dest.exists() {
            dest = originals_dir.join(replace_ext_counter(&base_with_ext(&base, "pdf"), n));
            n += 1;
        }
        std::fs::rename(source, &dest).map_err(|e| format!("original archive failed: {e}"))?;
        original_path = Some(dest.to_string_lossy().to_string());
        if forced_keep {
            log(format!(
                "Original kept despite the setting: conversion was lossy. Archived to {}",
                dest.display()
            ));
        }
    } else {
        std::fs::remove_file(source).map_err(|e| format!("source delete failed: {e}"))?;
    }

    // Step 7: purge scratch, always (:305-306).
    let _ = std::fs::remove_dir_all(&scratch_dir);

    // Step 8: report (:308-328) — the DB updates happen in the pump.
    Ok(ConvertOutcome {
        queue_id: item.queue_id.unwrap_or(0),
        new_path: final_output.to_string_lossy().to_string(),
        lossless: extract_result.lossless,
        original_kept: keep_original,
        forced_keep,
        original_path,
    })
}

fn item_metadata(item: &super::ConvertItem) -> crate::metadata::context::LibraryItemMetadata {
    crate::metadata::context::LibraryItemMetadata {
        id: Some(item.item_id as f64),
        gallery_id: item.gallery_id.map(|g| g as f64),
        custom_title: item.custom_title.clone(),
        custom_tags: item.custom_tags.clone(),
        custom_language: item.custom_language.clone(),
        series_name: item.series_name.clone(),
        series_index: item.series_index,
        publisher: item.publisher.clone(),
        language: item.language.clone(),
        description: item.description.clone(),
        upload_date: item.upload_date.map(|u| u as f64),
        raw_tags_json: item.raw_tags_json.clone(),
        ..Default::default()
    }
}

fn replace_ext(path: &Path, ext: &str) -> PathBuf {
    path.with_extension(ext)
}

fn replace_ext_counter(path: &Path, n: u32) -> PathBuf {
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    path.with_file_name(format!("{stem}-{n}.{}", path.extension().map(|e| e.to_string_lossy()).unwrap_or_default()))
}

fn base_with_ext(base: &str, ext: &str) -> PathBuf {
    Path::new(base).with_extension(ext)
}
