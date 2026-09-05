//! parseComicInfoXml port (src/main/services/comicinfo.ts:59+). Per-field
//! regexes rather than a full parser (flat schema), entity-decoded. Pure and
//! synchronous — the read side of the writer already in `metadata::writers`.

use serde_json::json;

use crate::metadata::xml_utils::decode_xml_entities as decode_shared;

/// parseComicInfoXml uses the SHARED xml-utils decode (comicinfo.ts:11) —
/// the `&#39;` variant, unlike the worker's own `&apos;` copy. A decode
/// failure (RangeError case, unreachable for real payloads) skips the field;
/// 1.x would throw into extractCbzMetadata's catch and drop the whole file's
/// metadata — documented divergence, same reason as xml_utils.rs:36-40.
fn decode_xml_entities(s: &str) -> Option<String> {
    decode_shared(s).ok()
}

/// What `parseComicInfoXml` can recover (comicinfo.ts:21-45) — the fields the
/// scanner consumes; the rest of the schema is write-side only.
#[derive(Debug, Default, Clone)]
pub struct ComicInfoMetadata {
    pub title: Option<String>,
    pub series: Option<String>,
    /// Position within the series, Number first then legacy Volume.
    pub volume: Option<f64>,
    pub summary: Option<String>,
    pub writers: Vec<String>,
    pub publisher: Option<String>,
    pub genres: Vec<String>,
    pub tags: Vec<String>,
    pub characters: Vec<String>,
    pub web_url: Option<String>,
    pub notes: Option<String>,
    pub page_count: Option<i64>,
    pub language_iso: Option<String>,
}

fn extract(tag: &str, xml: &str) -> Option<String> {
    let re = regex::Regex::new(&format!(
        r"(?i)<{tag}[^>]*>([^<]+)</{tag}>"
    ))
    .ok()?;
    let m = re.captures(xml)?;
    let raw = m.get(1)?.as_str();
    // text() = decodeXmlEntities(raw.trim())
    decode_xml_entities(raw.trim())
}

fn split_list(value: Option<String>) -> Vec<String> {
    value
        .map(|v| {
            v.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_comic_info_xml(xml: &str) -> ComicInfoMetadata {
    let mut result = ComicInfoMetadata::default();

    if let Some(title) = extract("Title", xml) {
        if !title.is_empty() {
            result.title = Some(title);
        }
    }
    if let Some(series) = extract("Series", xml) {
        if !series.is_empty() {
            result.series = Some(series);
        }
    }
    // Number first, Volume second (comicinfo.ts:74-85).
    let index_str = extract("Number", xml).or_else(|| extract("Volume", xml));
    if let Some(index_str) = index_str {
        if let Some(parsed) = crate::scanner::extract::pdf::parse_js_float(&index_str) {
            if !parsed.is_nan() {
                result.volume = Some(parsed);
            }
        }
    }
    if let Some(summary) = extract("Summary", xml) {
        if !summary.is_empty() {
            result.summary = Some(summary);
        }
    }
    result.writers = split_list(extract("Writer", xml));
    if let Some(publisher) = extract("Publisher", xml) {
        if !publisher.is_empty() {
            result.publisher = Some(publisher);
        }
    }
    result.genres = split_list(extract("Genre", xml));
    result.tags = split_list(extract("Tags", xml));
    result.characters = split_list(extract("Characters", xml));
    if let Some(web) = extract("Web", xml) {
        if !web.is_empty() {
            result.web_url = Some(web);
        }
    }
    if let Some(notes) = extract("Notes", xml) {
        if !notes.is_empty() {
            result.notes = Some(notes);
        }
    }
    if let Some(pc) = extract("PageCount", xml) {
        if let Ok(parsed) = pc.parse::<i64>() {
            result.page_count = Some(parsed);
        }
    }
    if let Some(iso) = extract("LanguageISO", xml) {
        if !iso.is_empty() {
            result.language_iso = Some(iso);
        }
    }
    result
}

/// The gallery stub's `raw_tags_json` payload (upsertGalleryStub, :739).
/// Built as a raw string: `JSON.stringify({id, type, name})` keeps insertion
/// order, and serde_json's default BTreeMap would sort it (id, name, type) —
/// a byte-level divergence in a stored column.
pub fn stub_tags_json(tags: &[String]) -> String {
    let items: Vec<String> = tags
        .iter()
        .map(|t| {
            format!(
                "{{\"id\":0,\"type\":\"tag\",\"name\":{}}}",
                serde_json::to_string(t).unwrap_or_else(|_| "\"\"".to_string())
            )
        })
        .collect();
    format!("[{}]", items.join(","))
}

/// The gallery stub's `raw_json` payload (:740).
pub fn stub_raw_json(gallery_id: i64, title: &str) -> String {
    serde_json::to_string(&json!({ "id": gallery_id, "title": { "pretty": title } }))
        .unwrap_or_else(|_| "{}".to_string())
}
