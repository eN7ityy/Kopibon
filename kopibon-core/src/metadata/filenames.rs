//! Port of gallery-filename.ts + temp-path.ts + the three sanitisers
//! (07-metadata-spec §7, 08/01 §7). **Three distinct sanitisers — never
//! unified**: download (`_`-substitute/180/suffix), custom-entry
//! (delete/120/prefix), directory-segment (`_`-substitute + leading-dot strip
//! + 180 + 'Unknown' fallback).
//!
//! Rust hazard documented in 07 §7: JS strings are UTF-16, Rust strings
//! UTF-8; the 255-byte rule is byte-based on the basename and truncation is
//! code-point-safe by construction here (chars(), never byte slicing).

use sha1::{Digest, Sha1};
use std::path::{Path, PathBuf};

/// The shared character class of the download and directory sanitisers:
/// `/ \ ? % * : | " < >` — substitute with `_` (download-manager.ts:552).
/// The custom-entry sanitiser uses the same class but DELETES it
/// (library.ipc.ts:1311-1313).
const UNSAFE_CHARS: &str = "[/\\\\?%*:|\"<>]";

fn unsafe_class() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(UNSAFE_CHARS).unwrap())
}

/// Matches the marker wherever it sits, since both placements exist on disk
/// (gallery-filename.ts:14).
pub fn strip_id_markers(s: &str) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"\s*\[nhentai-\d+\]\s*").unwrap())
        .replace_all(s, " ")
        .into_owned()
}

/// Linux caps a single filename at 255 bytes (temp-path.ts:37) — bytes, not
/// characters, and only the basename is measured.
pub const MAX_NAME_BYTES: usize = 255;

/// Cut a string to at most `max_bytes`, never splitting a character
/// (temp-path.ts:54-66). Iterates code points, which also keeps surrogate
/// pairs — emoji, some CJK extensions — intact.
pub fn truncate_to_bytes(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut out = String::new();
    let mut used = 0usize;
    for c in value.chars() {
        let size = c.len_utf8();
        if used + size > max_bytes {
            break;
        }
        out.push(c);
        used += size;
    }
    out
}

/// A temporary path beside `final_path`, guaranteed to fit
/// (temp-path.ts:79-90): normally `<final><suffix>`; when that would exceed
/// the limit the name is cut and a short sha1 of the final name added.
/// Always in the same directory, so the rename that follows is atomic.
pub fn temp_sibling_path(final_path: &Path) -> PathBuf {
    temp_sibling_path_suffix(final_path, ".part")
}

pub fn temp_sibling_path_suffix(final_path: &Path, suffix: &str) -> PathBuf {
    let dir = final_path.parent().unwrap_or(Path::new(""));
    let name = final_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    let plain = format!("{name}{suffix}");
    if plain.len() <= MAX_NAME_BYTES {
        return dir.join(plain);
    }

    // Distinguishes two long names that truncate to the same prefix.
    let mut hasher = Sha1::new();
    hasher.update(name.as_bytes());
    let digest = hasher.finalize();
    let stamp = format!(
        ".{:02x}{:02x}{:02x}{:02x}",
        digest[0], digest[1], digest[2], digest[3]
    );
    let room = MAX_NAME_BYTES - stamp.len() - suffix.len();
    dir.join(format!("{}{stamp}{suffix}", truncate_to_bytes(&name, room)))
}

/// `name.cbz` → `('name', '.cbz')`; no extension or a leading dot gives `''`
/// (gallery-filename.ts:24-29).
fn split_extension(file_name: &str) -> (&str, &str) {
    match file_name.rfind('.') {
        Some(0) | None => (file_name, ""),
        Some(dot) => (&file_name[..dot], &file_name[dot..]),
    }
}

/// Rewrite a filename so it carries `galleryId`, or none when null
/// (gallery-filename.ts:42-54): existing markers removed wherever they sit,
/// whitespace collapsed, the stem (never the marker) byte-trimmed, empty
/// stem → 'Untitled'.
pub fn apply_gallery_id_to_filename(file_name: &str, gallery_id: Option<u32>) -> String {
    let (raw_stem, ext) = split_extension(file_name);

    let stripped = strip_id_markers(raw_stem);
    // Collapse the whitespace removal leaves behind: JS `.replace(/\s+/g, ' ')`
    // then `.trim()`, with JS's own \s set (xml_utils::is_js_whitespace).
    let mut collapsed = String::new();
    let mut pending_space = false;
    for c in stripped.chars() {
        if crate::metadata::xml_utils::is_js_whitespace(c) {
            pending_space = true;
        } else {
            if pending_space && !collapsed.is_empty() {
                collapsed.push(' ');
            }
            pending_space = false;
            collapsed.push(c);
        }
    }
    let stem = collapsed.as_str();

    let marker = gallery_id
        .map(|id| format!(" [nhentai-{id}]"))
        .unwrap_or_default();

    // Never produce an empty name: a file called only `[nhentai-123].cbz`
    // after detaching would have nothing left at all.
    let safe_stem = if stem.is_empty() { "Untitled" } else { stem };

    let room = MAX_NAME_BYTES.saturating_sub(marker.len() + ext.len());
    format!(
        "{}{marker}{ext}",
        truncate_to_bytes(safe_stem, room).trim_end()
    )
}

// ─── The three sanitisers (07-metadata-spec §7) ─────────────────────────────

/// Download sanitiser (download-manager.ts:552-553): unsafe chars → `_`,
/// capped at 180. The caller appends ` [nhentai-{id}].{ext}`.
pub fn sanitize_download_title(title: &str) -> String {
    unsafe_class()
        .replace_all(title, "_")
        .chars()
        .take(180)
        .collect()
}

/// Custom-entry sanitiser (library.ipc.ts:1311-1317): same class but
/// **deletes** the chars, trims, caps at 120. Marker prefix is the caller's
/// (`[nhentai-00000] ${safeTitle}.${format}`).
pub fn sanitize_custom_entry_title(title: &str) -> String {
    // JS: replace(//, '') .substring(0,120) .trim() — order delete→cap→trim.
    let deleted = unsafe_class().replace_all(title, "");
    let capped: String = deleted.chars().take(120).collect();
    crate::metadata::xml_utils::js_trim(&capped).to_string()
}

/// Directory-segment sanitiser (convert-cbz.worker.ts:61-79): `_`
/// substitution + leading-dot strip + trim + cap 180 + `'Unknown'` fallback.
pub fn safe_path_segment(name: Option<&str>) -> String {
    let cleaned = match name {
        None | Some("") => String::new(),
        Some(name) => {
            let replaced = unsafe_class().replace_all(name, "_");
            let stripped = replaced.trim_start_matches('.');
            let trimmed = crate::metadata::xml_utils::js_trim(stripped);
            trimmed.chars().take(180).collect()
        }
    };
    if cleaned.is_empty() {
        "Unknown".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_sanitisers_stay_distinct() {
        let hostile = r#"a/b\c?d%e*f:g"h<i|j k.cbz"#;
        // Download: substitute, 180.
        let d = sanitize_download_title(hostile);
        assert!(!d.contains('/') && d.contains('_'));
        // Custom entry: delete, trim, 120.
        let c = sanitize_custom_entry_title(hostile);
        assert!(!c.contains('_'));
        // Directory segment: substitute + leading dots + Unknown fallback.
        let s = safe_path_segment(Some("..danger/title"));
        assert!(s.starts_with("danger_title"));
        assert_eq!(safe_path_segment(Some("")), "Unknown");
        assert_eq!(safe_path_segment(Some("...")), "Unknown");
        assert_eq!(safe_path_segment(None), "Unknown");
    }

    #[test]
    fn download_cap_180_substitute() {
        let long = "x".repeat(200);
        assert_eq!(sanitize_download_title(&long).chars().count(), 180);
    }

    #[test]
    fn custom_cap_120_delete() {
        let long = "y".repeat(200);
        assert_eq!(sanitize_custom_entry_title(&long).chars().count(), 120);
    }

    #[test]
    fn marker_machinery() {
        // Both placements are first-class inputs (07-metadata-spec §8).
        assert_eq!(
            apply_gallery_id_to_filename("Title [nhentai-528499].cbz", None),
            "Title.cbz"
        );
        assert_eq!(
            apply_gallery_id_to_filename("[nhentai-00000] Title.pdf", Some(42)),
            "Title [nhentai-42].pdf"
        );
        assert_eq!(
            apply_gallery_id_to_filename("   [nhentai-1]   ", Some(7)),
            "Untitled [nhentai-7]"
        );
        assert_eq!(
            apply_gallery_id_to_filename("A  B [nhentai-3].cbz", None),
            "A B.cbz"
        );
        assert_eq!(
            apply_gallery_id_to_filename(".hidden", Some(5)),
            ".hidden [nhentai-5]"
        );
    }

    #[test]
    fn byte_truncation_is_code_point_safe() {
        let jp = "日本語".repeat(90); // 270 bytes, 3 bytes/char
        let t = truncate_to_bytes(&jp, 255);
        assert!(t.len() <= 255);
        assert_eq!(t.chars().count(), 85); // no split code points
        assert_eq!(truncate_to_bytes("abc", 10), "abc");
    }

    #[test]
    fn temp_sibling_fits_255() {
        // 252 bytes + ".part" = 257 — over the limit (temp-path.ts docstring).
        let long_name = format!("{}.cbz", "日".repeat(84));
        assert_eq!(long_name.len(), 256); // 84 × 3-byte chars + ".cbz"
        let p = temp_sibling_path(Path::new(&format!("/tmp/{long_name}")));
        let base = p.file_name().unwrap().to_string_lossy();
        assert!(base.len() <= 255);
        assert!(base.ends_with(".part"));
        // Short names get the plain sibling.
        let plain = temp_sibling_path(Path::new("/tmp/short.cbz"));
        assert_eq!(plain, Path::new("/tmp/short.cbz.part"));
    }
}
