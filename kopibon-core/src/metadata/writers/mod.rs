//! The three writers and the `apply_metadata` dispatcher (08/01 §5).
//! Writers produce one artefact each and compute no policy (that is
//! `mappers.rs`) and invent no filename (that is `filenames.rs` + callers).

pub mod comicinfo;
pub mod pdf;
pub mod zip;

use crate::metadata::context::{FileMetadata, Format};
use crate::metadata::mappers::Clock;
use std::path::Path;

/// The one entry point every write path calls (apply-metadata.ts:204-220):
/// `cbz` → ComicInfo rewrite in place, everything else → the PDF writer.
pub fn apply_metadata(
    path: &Path,
    format: Format,
    meta: &FileMetadata,
    clock: &dyn Clock,
    mtime: u64,
) -> Result<(), String> {
    match format {
        Format::Cbz => comicinfo::rewrite_comic_info_in_cbz(path, meta, mtime),
        Format::Pdf => pdf::write_pdf_metadata(path, meta, clock),
    }
}
