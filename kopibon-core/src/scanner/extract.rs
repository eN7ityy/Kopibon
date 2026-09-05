//! Extraction: the shared `PdfMetadata` shape (library-scanner.worker.ts:52-63)
//! plus the docinfo/XMP (PDF, :248-322) and ComicInfo (CBZ, :338-417) readers.

pub mod cbz;
pub mod comicinfo;
pub mod pdf;

/// The metadata shape both extractors return (:52-63).
#[derive(Debug, Default, Clone)]
pub struct ExtractedMetadata {
    pub title: Option<String>,
    pub authors: Vec<String>,
    pub tags: Vec<String>,
    pub gallery_id: Option<i64>,
    /// Docinfo /CreationDate (or XMP dc:date fallback) as JS-epoch ms.
    pub creation_date: Option<i64>,
    pub series_name: Option<String>,
    pub series_index: Option<f64>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub description: Option<String>,
}

/// /Keywords token parse (:68, :262-281) — the matched pair of the writer.
/// Returns the parts the tokens carried; `None` when no token matched.
pub struct KeywordParsed {
    pub gallery_id: Option<i64>,
    pub series_index: Option<f64>,
    pub series_name: Option<String>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub tags: Vec<String>,
}

pub fn parse_keyword_token(token: &str, into: &mut KeywordParsed) {
    use regex::Regex;
    let nhentai = regex::Regex::new(r"(?i)nhentai:(\d+)").unwrap();
    if let Some(m) = nhentai.captures(token) {
        into.gallery_id = m.get(1).and_then(|g| g.as_str().parse::<i64>().ok());
        return;
    }
    let si = Regex::new(r"(?i)^series_index:(\d+(?:\.\d+)?)$").unwrap();
    if let Some(m) = si.captures(token) {
        into.series_index = m
            .get(1)
            .and_then(|g| g.as_str().parse::<f64>().ok());
        return;
    }
    let cs = Regex::new(r"(?i)^calibre_series:(.+)$").unwrap();
    if let Some(m) = cs.captures(token) {
        into.series_name = Some(m.get(1).map(|g| g.as_str()).unwrap_or("").trim().to_string());
        return;
    }
    let lang = Regex::new(r"(?i)^language:(\w+)$").unwrap();
    if let Some(m) = lang.captures(token) {
        into.language = Some(
            m.get(1)
                .map(|g| g.as_str().to_lowercase())
                .unwrap_or_default(),
        );
        return;
    }
    let pub_re = Regex::new(r"(?i)^publisher:(.+)$").unwrap();
    if let Some(m) = pub_re.captures(token) {
        into.publisher = Some(m.get(1).map(|g| g.as_str()).unwrap_or("").trim().to_string());
        return;
    }
    into.tags.push(token.to_string());
}

/// `extractIdFromFilename` (:324-327): `[nhentai-NNN]` in the basename.
pub fn extract_id_from_filename(file_name: &str) -> Option<i64> {
    let re = regex::Regex::new(r"\[nhentai-(\d+)\]").unwrap();
    re.captures(file_name)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<i64>().ok())
}
