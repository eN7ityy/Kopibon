//! Port of `src/main/services/metadata/mappers.ts` — FileMetadata in,
//! template context out. Everything that could be decided differently lives
//! here and nowhere else (07-metadata-spec §4 is the table of truth; the
//! cites below are mappers.ts line numbers).
//!
//! Values are XML-escaped here, because the engine cannot tell markup from
//! text. The docinfo helpers deliberately return raw values: those are
//! written into a PDF Info dictionary, not into XML.

use crate::metadata::context::{FileMetadata, JsDate};
use crate::metadata::template::{render_template, TemplateContext, TemplateValue};
use crate::metadata::templates_io::{load_template, COMICINFO_TEMPLATE, PDF_XMP_TEMPLATE};
use crate::metadata::xml_utils::{escape_xml, resolve_language_name, to_iso_language};

/// Reported in both the XMP packet and the PDF Info dictionary
/// (mappers.ts:24). **Kept verbatim for XMP byte parity** (07-metadata-spec
/// §1/§5): the packet's `pdf:Producer` element still carries this string.
/// The Info dict's `Producer` differs in 2.x — see `build_doc_info` (D6).
pub const PDF_PRODUCER: &str = "pikepdf 10.8.0";

/// The byte-order mark the XMP packet header requires (mappers.ts:27).
pub const XMP_BOM: &str = "\u{FEFF}";

/// Volatile "now" — threaded, never read inline (07-metadata-spec §9;
/// 08/01 §6). `now_ms` is the only source of wall-clock time in this module.
pub trait Clock {
    fn now_ms(&self) -> i64;
}

/// The real wall clock, for the live write paths.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
}

/// A frozen instant, for tests and the golden corpus.
pub struct FixedClock(pub i64);

impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

// ─── Policy ─────────────────────────────────────────────────────────────────

/// Whether this file genuinely belongs to a series (mappers.ts:39-41).
/// Having been given a series name is the whole test.
pub fn is_part_of_series(meta: &FileMetadata) -> bool {
    match &meta.series_name {
        Some(name) => {
            // JS: Boolean(name && name.trim())
            !name.is_empty() && !crate::metadata::xml_utils::js_trim(name).is_empty()
        }
        None => false,
    }
}

/// The series to write. ComicInfo always needs one, so the title stands in
/// (mappers.ts:44-46).
pub fn series_title(meta: &FileMetadata) -> String {
    match &meta.series_name {
        Some(name) if !name.is_empty() => name.clone(),
        _ => meta.title.clone(),
    }
}

/// Position within the series, or null when there is nothing to number
/// (mappers.ts:56-60): only for a real series member with a positive index.
pub fn series_number(meta: &FileMetadata) -> Option<f64> {
    if !is_part_of_series(meta) {
        return None;
    }
    match meta.series_index {
        // JS: meta.seriesIndex == null || !(meta.seriesIndex > 0) → null
        Some(i) if i > 0.0 && !i.is_nan() => Some(i),
        _ => None,
    }
}

/// Who to credit (mappers.ts:69-73): artists → groups → 'Unknown'.
pub fn resolve_writers(meta: &FileMetadata) -> Vec<String> {
    if !meta.artists.is_empty() {
        return meta.artists.clone();
    }
    if !meta.groups.is_empty() {
        return meta.groups.clone();
    }
    vec!["Unknown".to_string()]
}

/// The circle if there is one, otherwise whatever publisher was supplied
/// (mappers.ts:76-78).
pub fn resolve_publisher(meta: &FileMetadata) -> Option<String> {
    meta.groups
        .first()
        .cloned()
        .or_else(|| meta.publisher.clone())
}

/// The human-readable language, e.g. 'English' (mappers.ts:87-89): a settled
/// language wins; otherwise the tags resolve by priority, not order.
pub fn resolve_language_value(meta: &FileMetadata) -> Option<String> {
    match &meta.language {
        Some(l) if !l.is_empty() => Some(l.clone()),
        // JS: meta.language ?? resolveLanguageName(...) — note `??`, so an
        // empty-string language would NOT fall through; see resolve test.
        Some(l) => Some(l.clone()),
        None => {
            let cands: Vec<Option<String>> =
                meta.language_tags.iter().map(|t| Some(t.clone())).collect();
            resolve_language_name(&cands)
        }
    }
}

/// The collection this file belongs to (mappers.ts:102-104): the first
/// parody, unconditional.
pub fn resolve_series_group(meta: &FileMetadata) -> Option<String> {
    meta.parodies.first().cloned()
}

/// The localized name for the *series*, only for a one-shot
/// (mappers.ts:116-119).
pub fn resolve_localized_series(meta: &FileMetadata) -> Option<String> {
    if is_part_of_series(meta) {
        return None;
    }
    match &meta.title_japanese {
        Some(t) if !t.is_empty() => Some(t.clone()),
        _ => None,
    }
}

// ─── Shared context ─────────────────────────────────────────────────────────

fn esc(value: Option<&str>) -> String {
    // JS: value ? escapeXml(value) : ''
    match value {
        Some(v) if !v.is_empty() => escape_xml(v),
        _ => String::new(),
    }
}

fn esc_all(values: &[String]) -> Vec<TemplateValue> {
    values
        .iter()
        .map(|v| TemplateValue::Str(escape_xml(v)))
        .collect()
}

fn sv(s: String) -> TemplateValue {
    TemplateValue::Str(s)
}

fn nv_or_empty(v: Option<f64>) -> TemplateValue {
    // JS: value ?? '' — null/undefined → ''
    match v {
        Some(n) => TemplateValue::Num(n),
        None => sv(String::new()),
    }
}

/// Everything both formats can offer, escaped and ready to substitute
/// (mappers.ts:132-185). Fields the shipped templates never mention are here
/// on purpose — they are what makes a template edit possible without code.
fn common_context(meta: &FileMetadata) -> TemplateContext {
    let language = resolve_language_value(meta);
    let mut c = TemplateContext::new();

    // Zero is absent, not a gallery (mappers.ts:138): `galleryId || ''`.
    c.insert(
        "galleryId".into(),
        match meta.gallery_id {
            Some(0.0) | None => sv(String::new()),
            Some(id) => TemplateValue::Num(id),
        },
    );
    c.insert("title".into(), sv(esc(Some(&meta.title))));
    c.insert(
        "titleEnglish".into(),
        sv(esc(meta.title_english.as_deref())),
    );
    c.insert(
        "titleJapanese".into(),
        sv(esc(meta.title_japanese.as_deref())),
    );
    c.insert("titlePretty".into(), sv(esc(meta.title_pretty.as_deref())));

    c.insert("seriesName".into(), sv(esc(meta.series_name.as_deref())));
    c.insert(
        "partOfSeries".into(),
        TemplateValue::Bool(is_part_of_series(meta)),
    );

    c.insert("artists".into(), TemplateValue::Arr(esc_all(&meta.artists)));
    c.insert("groups".into(), TemplateValue::Arr(esc_all(&meta.groups)));
    c.insert(
        "writers".into(),
        TemplateValue::Arr(esc_all(&resolve_writers(meta))),
    );
    c.insert(
        "characters".into(),
        TemplateValue::Arr(esc_all(&meta.characters)),
    );
    c.insert(
        "parodies".into(),
        TemplateValue::Arr(esc_all(&meta.parodies)),
    );
    c.insert(
        "categories".into(),
        TemplateValue::Arr(esc_all(&meta.categories)),
    );
    // ComicInfo Genre is categories then parodies (mappers.ts:160).
    let mut genres = meta.categories.clone();
    genres.extend(meta.parodies.iter().cloned());
    c.insert("genres".into(), TemplateValue::Arr(esc_all(&genres)));
    c.insert("tags".into(), TemplateValue::Arr(esc_all(&meta.tags)));
    c.insert(
        "allTags".into(),
        TemplateValue::Arr(esc_all(&meta.all_tags)),
    );

    c.insert(
        "publisher".into(),
        sv(esc(resolve_publisher(meta).as_deref())),
    );
    c.insert("description".into(), sv(esc(meta.description.as_deref())));

    c.insert("language".into(), sv(esc(language.as_deref())));
    c.insert(
        "languageIso".into(),
        sv(esc(to_iso_language(language.as_deref()).as_deref())),
    );

    c.insert("pageCount".into(), TemplateValue::Num(meta.page_count));
    c.insert(
        "galleryPageCount".into(),
        nv_or_empty(meta.gallery_page_count),
    );
    c.insert("format".into(), sv(esc(meta.format.as_deref())));
    c.insert("ageRating".into(), sv(esc(Some(&meta.age_rating))));
    c.insert("manga".into(), sv(esc(Some(&meta.manga_direction))));
    c.insert("producer".into(), sv(PDF_PRODUCER.to_string()));

    // Carried for template authors; nothing shipped uses these.
    c.insert("mediaId".into(), nv_or_empty(meta.media_id));
    c.insert("favorites".into(), nv_or_empty(meta.favorites));
    c.insert("coverUrl".into(), sv(esc(meta.cover_url.as_deref())));
    c.insert(
        "thumbnailUrl".into(),
        sv(esc(meta.thumbnail_url.as_deref())),
    );
    c.insert("scanlator".into(), sv(esc(meta.scanlator.as_deref())));
    c
}

// ─── ComicInfo (CBZ) ────────────────────────────────────────────────────────

/// The context the ComicInfo template is rendered against
/// (mappers.ts:190-213).
pub fn comic_info_context(meta: &FileMetadata) -> TemplateContext {
    let date = meta.release_date;
    let mut c = common_context(meta);

    c.insert("series".into(), sv(esc(Some(&series_title(meta)))));
    c.insert("number".into(), nv_or_empty(series_number(meta)));
    c.insert("seriesIndex".into(), nv_or_empty(meta.series_index));
    c.insert("summary".into(), sv(esc(meta.description.as_deref())));
    c.insert(
        "seriesGroup".into(),
        sv(esc(resolve_series_group(meta).as_deref())),
    );
    c.insert(
        "localizedSeries".into(),
        sv(esc(resolve_localized_series(meta).as_deref())),
    );
    // StoryArc mirrors the series (mappers.ts:205-206).
    c.insert(
        "storyArc".into(),
        if is_part_of_series(meta) {
            sv(esc(meta.series_name.as_deref()))
        } else {
            sv(String::new())
        },
    );
    c.insert("storyArcNumber".into(), nv_or_empty(series_number(meta)));
    // Written as three elements, so all three are absent together
    // (mappers.ts:208-211). Local-timezone Y/M/D, 2-digit padded.
    c.insert(
        "year".into(),
        match date {
            Some(d) => TemplateValue::Num(d.get_full_year() as f64),
            None => sv(String::new()),
        },
    );
    c.insert(
        "month".into(),
        match date {
            Some(d) => sv(format!("{:02}", d.get_month_1())),
            None => sv(String::new()),
        },
    );
    c.insert(
        "day".into(),
        match date {
            Some(d) => sv(format!("{:02}", d.get_date())),
            None => sv(String::new()),
        },
    );
    c.insert(
        "dateIso".into(),
        match date {
            Some(d) => sv(d.to_iso_string()),
            None => sv(String::new()),
        },
    );
    c
}

/// Render ComicInfo.xml for a file (mappers.ts:216-218).
pub fn build_comic_info_xml(meta: &FileMetadata) -> Result<String, String> {
    let template = load_template(COMICINFO_TEMPLATE)?;
    render_template(&template, &comic_info_context(meta))
}

// ─── XMP (PDF) ──────────────────────────────────────────────────────────────

/// Calibre's author_sort: the first creator with its words reversed
/// (mappers.ts:228-230).
fn author_sort(writers: &[String]) -> String {
    match writers.first() {
        Some(w) if !w.is_empty() => {
            // JS: w.split(' ').reverse().join(' ')
            let parts: Vec<&str> = w.split(' ').collect();
            parts.into_iter().rev().collect::<Vec<&str>>().join(" ")
        }
        _ => "unknown".to_string(),
    }
}

/// The context the PDF XMP template is rendered against (mappers.ts:233-250).
pub fn xmp_context(meta: &FileMetadata, clock: &dyn Clock) -> TemplateContext {
    let writers = resolve_writers(meta);
    // An undated file still needs a dc:date, so it gets the moment it was
    // written (mappers.ts:236) — via the clock (07-metadata-spec §9).
    let date = match meta.release_date {
        Some(d) => d,
        None => JsDate(clock.now_ms()),
    };
    let mut c = common_context(meta);

    c.insert("bom".into(), sv(XMP_BOM.to_string()));
    c.insert("creators".into(), TemplateValue::Arr(esc_all(&writers)));
    // dc:subject carries every tag, not just the `tag`-type ones
    // (mappers.ts:242-243) — overrides the common context's `tags`.
    c.insert("tags".into(), TemplateValue::Arr(esc_all(&meta.all_tags)));
    c.insert("date".into(), sv(esc(Some(&date.to_iso_string()))));
    // xmp:MetadataDate is when the file was written (mappers.ts:246).
    c.insert("metadataDate".into(), sv(metadata_date(clock)));
    c.insert(
        "seriesIndex".into(),
        match meta.series_index {
            Some(i) => sv(crate::metadata::js_number::js_to_fixed(i, 2).unwrap_or_default()),
            None => sv(String::new()),
        },
    );
    c.insert("authorSort".into(), sv(esc(Some(&author_sort(&writers)))));
    c
}

/// `new Date().toISOString().replace(/\.\d{3}Z$/, '.000000+00:00')`
/// (mappers.ts:246), via the clock.
pub fn metadata_date(clock: &dyn Clock) -> String {
    let iso = JsDate(clock.now_ms()).to_iso_string();
    // Only the exact ".dddZ" tail is rewritten.
    let bytes = iso.as_bytes();
    if bytes.len() >= 5
        && bytes[bytes.len() - 1] == b'Z'
        && bytes[bytes.len() - 5] == b'.'
        && bytes[bytes.len() - 4..bytes.len() - 1]
            .iter()
            .all(|b| b.is_ascii_digit())
    {
        format!("{}.000000+00:00", &iso[..iso.len() - 5])
    } else {
        iso
    }
}

/// Render the XMP packet for a PDF (mappers.ts:253-255).
pub fn build_xmp_xml(meta: &FileMetadata, clock: &dyn Clock) -> Result<String, String> {
    let template = load_template(PDF_XMP_TEMPLATE)?;
    render_template(&template, &xmp_context(meta, clock))
}

// ─── PDF Info dictionary ────────────────────────────────────────────────────

/// The `/Keywords` token list (mappers.ts:267-281). Order: allTags;
/// `nhentai:{id}` when `!= null` (0 included — the deliberate asymmetry with
/// the context's `|| ''`); `calibre_series:`; `series_index:` (ungated, raw);
/// `language:` (human-readable); `publisher:`.
pub fn build_keyword_tokens(meta: &FileMetadata) -> Vec<String> {
    let mut tokens = meta.all_tags.clone();
    let language = resolve_language_value(meta);
    let publisher = resolve_publisher(meta);

    if let Some(id) = meta.gallery_id {
        tokens.push(format!(
            "nhentai:{}",
            crate::metadata::js_number::js_to_string(id)
        ));
    }
    if let Some(series) = &meta.series_name {
        if !series.is_empty() {
            tokens.push(format!("calibre_series:{series}"));
        }
    }
    if let Some(i) = meta.series_index {
        tokens.push(format!(
            "series_index:{}",
            crate::metadata::js_number::js_to_string(i)
        ));
    }
    if let Some(lang) = language {
        tokens.push(format!("language:{lang}"));
    }
    if let Some(publ) = publisher {
        tokens.push(format!("publisher:{publ}"));
    }
    tokens
}

/// The Info-dictionary fields written alongside the XMP packet (mappers.ts:
/// 284-296). Unescaped. **D6 deviation (07-metadata-spec §12, ledger §9):**
/// the port emits `Producer = "Kopibon 2.x"` here — the pikepdf version
/// string disappears with Python; the XMP packet's `pdf:Producer` keeps the
/// 1.x string for byte parity.
pub struct DocInfo {
    pub title: String,
    pub author: String,
    pub keywords: String,
    pub producer: String,
}

pub fn build_doc_info(meta: &FileMetadata) -> DocInfo {
    DocInfo {
        title: meta.title.clone(),
        author: resolve_writers(meta).join(", "),
        keywords: build_keyword_tokens(meta).join(", "),
        producer: "Kopibon 2.x".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::context::{default_file_metadata, make_file_metadata};

    #[test]
    fn gallery_id_zero_asymmetry() {
        // The two guards deliberately disagree (07-metadata-spec §4).
        let mut meta = default_file_metadata();
        meta.gallery_id = Some(0.0);
        meta.all_tags = vec!["t".into()];
        let c = comic_info_context(&meta);
        assert_eq!(c.get("galleryId"), Some(&sv(String::new()))); // 0 → ''
        let tokens = build_keyword_tokens(&meta);
        assert!(tokens.contains(&"nhentai:0".to_string())); // 0 → nhentai:0
    }

    #[test]
    fn policy_rules() {
        let mut meta = default_file_metadata();
        meta.series_name = Some("  ".into());
        assert!(!is_part_of_series(&meta)); // whitespace-only is not a series
        meta.series_name = Some("A".into());
        meta.series_index = Some(0.0);
        assert_eq!(series_number(&meta), None); // index ≤ 0 → unnumbered
        meta.series_index = Some(2.5);
        assert_eq!(series_number(&meta), Some(2.5));

        let mut m2 = default_file_metadata();
        m2.groups = vec!["circle".into()];
        assert_eq!(resolve_writers(&m2), vec!["circle".to_string()]);
        assert_eq!(resolve_publisher(&m2).as_deref(), Some("circle"));
        let m3 = make_file_metadata(FileMetadata {
            title: "t".into(),
            ..default_file_metadata()
        });
        assert_eq!(resolve_writers(&m3), vec!["Unknown".to_string()]);
    }

    #[test]
    fn author_sort_words_reversed() {
        assert_eq!(super::author_sort(&["A B C".to_string()]), "C B A");
        assert_eq!(super::author_sort(&[]), "unknown");
    }

    #[test]
    fn metadata_date_format() {
        let clock = FixedClock(1788566452000); // 2026-09-05T00:00:52Z (UTC)
        assert_eq!(metadata_date(&clock), "2026-09-05T00:00:52.000000+00:00");
    }
}
