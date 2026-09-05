//! Port of `src/main/services/metadata/file-metadata.ts` — the one shape
//! every metadata write starts from. Adapters do no thinking; every decision
//! lives in `mappers.rs` (module doc of file-metadata.ts). Field-for-field,
//! including the fields no shipped template uses (07-metadata-spec §4).

use serde::{Deserialize, Serialize};

/// Reading direction, as ComicInfo spells it (file-metadata.ts:27).
pub const MANGA_DIRECTIONS: [&str; 3] = ["Yes", "YesAndRightToLeft", "No"];

/// The two output formats (dispatch target of apply-metadata).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Pdf,
    Cbz,
}

impl Format {
    pub fn parse_format(s: &str) -> Format {
        if s.eq_ignore_ascii_case("cbz") {
            Format::Cbz
        } else {
            Format::Pdf // default, as the dispatcher falls through to PDF
        }
    }
}

/// A JS `Date` reduced to what the mappers need: epoch milliseconds, with
/// local-timezone Y/M/D (ComicInfo Year/Month/Day use `getFullYear` et al.,
/// i.e. **local** time) and UTC ISO formatting (`toISOString`, always 3-digit
/// milliseconds).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct JsDate(pub i64); // milliseconds since epoch

impl Serialize for JsDate {
    /// ISO string, matching what `JSON.stringify(new Date(...))` yields on the
    /// 1.x side — the differential harness compares these shapes.
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_iso_string())
    }
}

impl<'de> Deserialize<'de> for JsDate {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V;
        impl serde::de::Visitor<'_> for V {
            type Value = JsDate;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("ISO date string or epoch milliseconds")
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<JsDate, E> {
                parse_js_iso_ms(v)
                    .map(|ms| JsDate(ms as i64))
                    .ok_or_else(|| serde::de::Error::custom(format!("invalid date: {v}")))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<JsDate, E> {
                Ok(JsDate(v))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<JsDate, E> {
                Ok(JsDate(v as i64))
            }
        }
        deserializer.deserialize_any(V)
    }
}

impl JsDate {
    /// `Date.toISOString()` — UTC, millisecond precision always
    /// ("2024-08-28T12:42:28.000Z").
    pub fn to_iso_string(self) -> String {
        let secs = self.0.div_euclid(1000);
        let millis = self.0.rem_euclid(1000);
        let zoned = jiff::Timestamp::from_second(secs)
            .expect("ms date is in range")
            .to_zoned(jiff::tz::TimeZone::UTC);
        format!("{}.{:03}Z", zoned.strftime("%Y-%m-%dT%H:%M:%S"), millis)
    }

    /// `getFullYear()` — local timezone (jiff reads TZ / /etc/localtime).
    fn local_zoned(self) -> jiff::Zoned {
        let ts = jiff::Timestamp::from_millisecond(self.0).expect("ms date is in range");
        ts.to_zoned(jiff::tz::TimeZone::system())
    }

    pub fn get_full_year(self) -> i16 {
        self.local_zoned().year()
    }

    /// `getMonth() + 1` (JS months are 0-based).
    pub fn get_month_1(self) -> i8 {
        self.local_zoned().month()
    }

    pub fn get_date(self) -> i8 {
        self.local_zoned().day()
    }
}

/// `toDate` (file-metadata.ts:234-238): falsy values — including timestamp 0 —
/// are absent; `unit: 'seconds'` multiplies by 1000; `unit: 'iso'` parses the
/// string; anything unparseable is absent.
pub fn to_date(value: Option<&str>, unit: &str) -> Option<JsDate> {
    let value = value?;
    if value.is_empty() {
        return None; // JS falsy
    }
    let ms: f64 = if unit == "seconds" {
        // JS: new Date(Number(value) * 1000).getTime()
        value.parse::<f64>().ok()? * 1000.0
    } else {
        // JS: new Date(String(value)).getTime() — ISO strings are the contract
        parse_js_iso_ms(value)?
    };
    if !ms.is_finite() {
        return None; // Invalid Date → null
    }
    Some(JsDate(ms as i64))
}

/// Parse an ISO-8601 string the way `new Date(str)` does for the formats this
/// app produces/stores. Returns epoch milliseconds.
///
/// Documented non-observable divergence: JS's *legacy* parser accepts
/// non-ISO garbage ("0" → year 2000 local, "5" → 2001-04-30) that jiff
/// rejects. The UI only ever sends ISO strings (MetadataPayload.date is an
/// ISO string end to end), so the legacy forms are unreachable; if a real
/// input ever carries one, that is a ledger §9 row, not a silent choice.
fn parse_js_iso_ms(s: &str) -> Option<f64> {
    let ts: jiff::Timestamp = s.parse().ok()?;
    Some(ts.as_millisecond() as f64)
}

/// `toDate(value, 'seconds')` on a raw JS number (file-metadata.ts:234-238):
/// falsy numbers — 0 and NaN — are absent, otherwise ×1000.
fn to_date_seconds(value: Option<f64>) -> Option<JsDate> {
    let v = value?;
    if v == 0.0 || !v.is_finite() {
        return None;
    }
    Some(JsDate((v * 1000.0) as i64))
}

/// `splitList` (file-metadata.ts:240-246): comma-split, trim, drop empties.
pub fn split_list(csv: Option<&str>) -> Vec<String> {
    match csv {
        None | Some("") => Vec::new(),
        Some(csv) => csv
            .split(',')
            .map(crate::metadata::xml_utils::js_trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect(),
    }
}

/// A tag as nhentai returns it (file-metadata.ts:30-34).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TagLike {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<f64>,
    #[serde(default)]
    pub r#type: String,
    #[serde(default)]
    pub name: String,
}

fn names_of_type(tags: &[TagLike], tag_type: &str) -> Vec<String> {
    tags.iter()
        .filter(|t| t.r#type == tag_type)
        .map(|t| t.name.clone())
        .collect()
}

/// Whether a cached gallery row holds real API data (file-metadata.ts:256-266).
/// Scanner-invented rows carry a stub whose tags are all untyped; their
/// upload date must never be written.
pub fn is_real_gallery_row(raw_tags_json: Option<&str>) -> bool {
    let Some(json) = raw_tags_json else {
        return false;
    };
    if json.is_empty() {
        return false;
    }
    let Ok(tags) = serde_json::from_str::<Vec<TagLike>>(json) else {
        return false;
    };
    if tags.is_empty() {
        return false;
    }
    let types: std::collections::HashSet<&str> = tags.iter().map(|t| t.r#type.as_str()).collect();
    !(types.len() == 1 && types.contains("tag"))
}

/// The canonical shape (file-metadata.ts:117-176).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FileMetadata {
    /// nhentai gallery number, or null for anything added by hand.
    pub gallery_id: Option<f64>,
    /// The name to write. Never empty — adapters substitute a fallback.
    pub title: String,
    pub title_english: Option<String>,
    pub title_japanese: Option<String>,
    pub title_pretty: Option<String>,
    pub series_name: Option<String>,
    /// Position within the series. Only meaningful when seriesName is set.
    pub series_index: Option<f64>,
    pub artists: Vec<String>,
    /// Circles. Doubles as the publisher when there is one.
    pub groups: Vec<String>,
    pub characters: Vec<String>,
    pub parodies: Vec<String>,
    /// nhentai `category`-type tags — `doujinshi`, `manga`.
    pub categories: Vec<String>,
    /// nhentai `tag`-type tags only.
    pub tags: Vec<String>,
    /// Every tag name whatever its type — what PDF XMP writes as dc:subject.
    pub all_tags: Vec<String>,
    /// Raw `language`-type tag names, still to be resolved to one language.
    pub language_tags: Vec<String>,
    /// A language the caller has already settled on; wins over languageTags.
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub description: Option<String>,
    /// Validated; never an Invalid Date.
    pub release_date: Option<JsDate>,
    /// Pages in the file itself. Writers that know better override it.
    pub page_count: f64,
    /// Pages the gallery claims, which can differ from the file.
    pub gallery_page_count: Option<f64>,
    pub format: Option<String>,
    pub manga_direction: String,
    pub age_rating: String,
    // Carried but unused by the shipped templates (file-metadata.ts:166-175):
    pub media_id: Option<f64>,
    pub favorites: Option<f64>,
    pub cover_url: Option<String>,
    pub thumbnail_url: Option<String>,
    pub scanlator: Option<String>,
}

impl Default for FileMetadata {
    fn default() -> Self {
        default_file_metadata()
    }
}

/// The values every adapter starts from (file-metadata.ts:185-215).
pub fn default_file_metadata() -> FileMetadata {
    FileMetadata {
        gallery_id: None,
        title: "Untitled".to_string(),
        title_english: None,
        title_japanese: None,
        title_pretty: None,
        series_name: None,
        series_index: None,
        artists: Vec::new(),
        groups: Vec::new(),
        characters: Vec::new(),
        parodies: Vec::new(),
        categories: Vec::new(),
        tags: Vec::new(),
        all_tags: Vec::new(),
        language_tags: Vec::new(),
        language: None,
        publisher: None,
        description: None,
        release_date: None,
        page_count: 0.0,
        gallery_page_count: None,
        format: None,
        manga_direction: "YesAndRightToLeft".to_string(),
        age_rating: "Adults Only 18+".to_string(),
        media_id: None,
        favorites: None,
        cover_url: None,
        thumbnail_url: None,
        scanlator: None,
    }
}

/// Build a FileMetadata from a partial one, filling the rest with defaults
/// (file-metadata.ts:218-220). A partial with `None` fields keeps the
/// defaults (serde `default` handles absent JSON keys the same way).
pub fn make_file_metadata(partial: FileMetadata) -> FileMetadata {
    partial
}

// ─── Adapters (file-metadata.ts:268-383) ────────────────────────────────────

/// A gallery as the nhentai API describes it, as passed to the download
/// workers (file-metadata.ts:39-61).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct GalleryMetadata {
    pub id: f64,
    pub title: GalleryTitle,
    pub tags: Vec<TagLike>,
    pub upload_date: Option<f64>,
    pub num_pages: Option<f64>,
    pub series_name: Option<String>,
    pub series_index: Option<f64>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub description: Option<String>,
    pub media_id: Option<f64>,
    pub favorites: Option<f64>,
    pub cover_url: Option<String>,
    pub thumbnail_url: Option<String>,
    pub scanlator: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct GalleryTitle {
    pub english: Option<String>,
    pub japanese: Option<String>,
    pub pretty: Option<String>,
}

/// A library row's metadata, as the conversion worker and the IPC layer hold
/// it (file-metadata.ts:70-94).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct LibraryItemMetadata {
    pub gallery_id: Option<f64>,
    pub custom_title: Option<String>,
    pub primary_artist: Option<String>,
    pub series_name: Option<String>,
    pub series_index: Option<f64>,
    pub custom_tags: Option<String>,
    pub custom_language: Option<String>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub description: Option<String>,
    pub upload_date: Option<f64>,
    pub raw_tags_json: Option<String>,
    pub format: Option<String>,
    pub page_count: Option<f64>,
    pub id: Option<f64>,
    /// Folded in from the cached gallery row, where one exists.
    pub title_english: Option<String>,
    pub title_japanese: Option<String>,
    pub media_id: Option<f64>,
    pub favorites_count: Option<f64>,
    pub cover_url: Option<String>,
    pub thumbnail_url: Option<String>,
    pub gallery_page_count: Option<f64>,
}

/// From an nhentai gallery (file-metadata.ts:277-308). The gallery's own
/// `language` field is deliberately not consulted.
pub fn file_metadata_from_gallery(
    meta: &GalleryMetadata,
    over: FileMetadataOverrides,
) -> FileMetadata {
    let mut m = default_file_metadata();
    m.gallery_id = Some(meta.id);
    m.title = meta.title.pretty.clone().unwrap_or_default();
    m.title_english = non_empty(meta.title.english.as_deref());
    m.title_japanese = non_empty(meta.title.japanese.as_deref());
    m.title_pretty = non_empty(meta.title.pretty.as_deref());
    m.series_name = non_empty(meta.series_name.as_deref());
    m.series_index = meta.series_index;
    m.artists = names_of_type(&meta.tags, "artist");
    m.groups = names_of_type(&meta.tags, "group");
    m.characters = names_of_type(&meta.tags, "character");
    m.parodies = names_of_type(&meta.tags, "parody");
    m.categories = names_of_type(&meta.tags, "category");
    m.tags = names_of_type(&meta.tags, "tag");
    m.all_tags = meta.tags.iter().map(|t| t.name.clone()).collect();
    m.language_tags = names_of_type(&meta.tags, "language");
    m.publisher = non_empty(meta.publisher.as_deref());
    m.description = non_empty(meta.description.as_deref());
    m.release_date = to_date_seconds(meta.upload_date);
    m.gallery_page_count = meta.num_pages;
    m.media_id = meta.media_id;
    m.favorites = meta.favorites;
    m.cover_url = meta.cover_url.clone();
    m.thumbnail_url = meta.thumbnail_url.clone();
    m.scanlator = non_empty(meta.scanlator.as_deref());
    overlay(&mut m, over);
    m
}

/// From a library row (file-metadata.ts:317-357). Splits on whether the
/// cached gallery data is real: a stub offers only its flat `customTags`,
/// language comes from its own column, and it gets no release date at all.
pub fn file_metadata_from_library_item(
    row: &LibraryItemMetadata,
    over: FileMetadataOverrides,
) -> FileMetadata {
    let mut m = default_file_metadata();
    let title = match &row.custom_title {
        Some(t) if !t.is_empty() => t.clone(),
        _ => format!(
            "Gallery #{}",
            row.gallery_id
                .filter(|g| *g != 0.0)
                .or(row.id)
                .unwrap_or(0.0) as i64
        ),
    };
    m.title = title;
    m.gallery_id = row.gallery_id;
    m.series_name = non_empty(row.series_name.as_deref());
    m.series_index = row.series_index;
    // The row's own artist column, not the artist tags.
    m.artists = match &row.primary_artist {
        Some(a) if !a.is_empty() => vec![a.clone()],
        _ => Vec::new(),
    };
    let real = is_real_gallery_row(row.raw_tags_json.as_deref());
    let parsed: Vec<TagLike> = if real {
        serde_json::from_str(row.raw_tags_json.as_deref().unwrap_or("[]")).unwrap_or_default()
    } else {
        Vec::new()
    };
    m.groups = names_of_type(&parsed, "group");
    m.characters = names_of_type(&parsed, "character");
    m.parodies = names_of_type(&parsed, "parody");
    m.categories = names_of_type(&parsed, "category");
    if real {
        m.tags = names_of_type(&parsed, "tag");
        m.all_tags = parsed.iter().map(|t| t.name.clone()).collect();
        let mut language_tags = names_of_type(&parsed, "language");
        // languageTags: [...namesOfType(parsed, 'language'), row.customLanguage || '']
        language_tags.push(row.custom_language.clone().unwrap_or_default());
        m.language_tags = language_tags;
        m.language = None;
    } else {
        m.tags = split_list(row.custom_tags.as_deref());
        m.all_tags = split_list(row.custom_tags.as_deref());
        m.language_tags = Vec::new();
        m.language = non_empty(row.custom_language.as_deref());
    }
    m.publisher = non_empty(row.publisher.as_deref());
    m.description = non_empty(row.description.as_deref());
    m.release_date = if real {
        to_date_seconds(row.upload_date)
    } else {
        None
    };
    m.format = non_empty(row.format.as_deref());
    m.page_count = row.page_count.unwrap_or(0.0);
    m.title_english = non_empty(row.title_english.as_deref());
    m.title_japanese = non_empty(row.title_japanese.as_deref());
    m.gallery_page_count = row.gallery_page_count;
    m.media_id = row.media_id;
    m.favorites = row.favorites_count;
    m.cover_url = non_empty(row.cover_url.as_deref());
    m.thumbnail_url = non_empty(row.thumbnail_url.as_deref());
    overlay(&mut m, over);
    m
}

/// A hand-assembled edit (file-metadata.ts:102-113).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct MetadataPayload {
    pub title: String,
    pub creators: Vec<String>,
    pub tags: Vec<String>,
    pub nhentai_id: Option<f64>,
    pub series_name: Option<String>,
    pub series_index: Option<f64>,
    pub description: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub date: Option<String>,
}

/// From a flat edit payload (file-metadata.ts:365-383): no typed tags, and
/// the language is whatever the caller decided.
pub fn file_metadata_from_payload(
    payload: &MetadataPayload,
    over: FileMetadataOverrides,
) -> FileMetadata {
    let mut m = default_file_metadata();
    m.gallery_id = payload.nhentai_id;
    m.title = payload.title.clone();
    m.series_name = non_empty(payload.series_name.as_deref());
    m.series_index = payload.series_index;
    m.artists = payload.creators.clone();
    m.tags = payload.tags.clone();
    m.all_tags = payload.tags.clone();
    m.language = non_empty(payload.language.as_deref());
    m.publisher = non_empty(payload.publisher.as_deref());
    m.description = non_empty(payload.description.as_deref());
    m.release_date = to_date(payload.date.as_deref(), "iso");
    overlay(&mut m, over);
    m
}

/// `...over` in TS: every field **present** in the override wins; absent
/// keys leave the adapter's value. All-Option so present-vs-absent is
/// representable after a JSON round-trip.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct FileMetadataOverrides {
    pub gallery_id: Option<f64>,
    pub title: Option<String>,
    pub title_english: Option<String>,
    pub title_japanese: Option<String>,
    pub title_pretty: Option<String>,
    pub series_name: Option<String>,
    pub series_index: Option<f64>,
    pub artists: Option<Vec<String>>,
    pub groups: Option<Vec<String>>,
    pub characters: Option<Vec<String>>,
    pub parodies: Option<Vec<String>>,
    pub categories: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
    pub all_tags: Option<Vec<String>>,
    pub language_tags: Option<Vec<String>>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub description: Option<String>,
    pub release_date: Option<JsDate>,
    pub page_count: Option<f64>,
    pub gallery_page_count: Option<f64>,
    pub format: Option<String>,
    pub manga_direction: Option<String>,
    pub age_rating: Option<String>,
    pub media_id: Option<f64>,
    pub favorites: Option<f64>,
    pub cover_url: Option<String>,
    pub thumbnail_url: Option<String>,
    pub scanlator: Option<String>,
}

/// Apply an override: every `Some` field wins, every `None` field leaves the
/// adapter's value (the `...over` spread).
fn overlay(m: &mut FileMetadata, over: FileMetadataOverrides) {
    let FileMetadataOverrides {
        gallery_id,
        title,
        title_english,
        title_japanese,
        title_pretty,
        series_name,
        series_index,
        artists,
        groups,
        characters,
        parodies,
        categories,
        tags,
        all_tags,
        language_tags,
        language,
        publisher,
        description,
        release_date,
        page_count,
        gallery_page_count,
        format,
        manga_direction,
        age_rating,
        media_id,
        favorites,
        cover_url,
        thumbnail_url,
        scanlator,
    } = over;
    if gallery_id.is_some() {
        m.gallery_id = gallery_id;
    }
    if let Some(v) = title {
        m.title = v;
    }
    if title_english.is_some() {
        m.title_english = title_english;
    }
    if title_japanese.is_some() {
        m.title_japanese = title_japanese;
    }
    if title_pretty.is_some() {
        m.title_pretty = title_pretty;
    }
    if series_name.is_some() {
        m.series_name = series_name;
    }
    if series_index.is_some() {
        m.series_index = series_index;
    }
    if let Some(v) = artists {
        m.artists = v;
    }
    if let Some(v) = groups {
        m.groups = v;
    }
    if let Some(v) = characters {
        m.characters = v;
    }
    if let Some(v) = parodies {
        m.parodies = v;
    }
    if let Some(v) = categories {
        m.categories = v;
    }
    if let Some(v) = tags {
        m.tags = v;
    }
    if let Some(v) = all_tags {
        m.all_tags = v;
    }
    if let Some(v) = language_tags {
        m.language_tags = v;
    }
    if language.is_some() {
        m.language = language;
    }
    if publisher.is_some() {
        m.publisher = publisher;
    }
    if description.is_some() {
        m.description = description;
    }
    if release_date.is_some() {
        m.release_date = release_date;
    }
    if let Some(v) = page_count {
        m.page_count = v;
    }
    if gallery_page_count.is_some() {
        m.gallery_page_count = gallery_page_count;
    }
    if format.is_some() {
        m.format = format;
    }
    if let Some(v) = manga_direction {
        m.manga_direction = v;
    }
    if let Some(v) = age_rating {
        m.age_rating = v;
    }
    if media_id.is_some() {
        m.media_id = media_id;
    }
    if favorites.is_some() {
        m.favorites = favorites;
    }
    if cover_url.is_some() {
        m.cover_url = cover_url;
    }
    if thumbnail_url.is_some() {
        m.thumbnail_url = thumbnail_url;
    }
    if scanlator.is_some() {
        m.scanlator = scanlator;
    }
}

fn non_empty(s: Option<&str>) -> Option<String> {
    match s {
        Some(v) if !v.is_empty() => Some(v.to_string()),
        _ => None,
    }
}
