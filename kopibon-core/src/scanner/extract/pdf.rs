//! extractPdfMetadata port (library-scanner.worker.ts:248-322).
//!
//! Docinfo comes from lopdf (replacing pdf-lib's getters), XMP is regexed off
//! the raw buffer with the exact pattern set of :126-149. Read failures yield
//! the all-None metadata — never an error (:254-256).

use lopdf::{Dictionary, Object};
use regex::Regex;

use super::{ExtractedMetadata, KeywordParsed};

use crate::metadata::xml_utils::decode_xml_entities as decode_entities_shared;

/// The scanner worker's OWN decodeXmlEntities (:157-166). It differs from
/// xml-utils.ts in exactly one named entity: this copy decodes `&apos;`,
/// xml-utils decodes `&#39;` (the APOS constant is built by concatenation
/// there). Kept separate for parity — the "shared" claim of plan §5.1 is
/// not true of the source.
fn decode_xml_entities(s: &str) -> Result<String, String> {
    let decoded = decode_entities_shared(s)?;
    // decode_entities_shared handles hex/dec/&lt;/&gt;/&quot;/&amp;-last and
    // decodes &#39; where the worker decodes &apos; — swap that one mapping.
    Ok(decoded.replace("&apos;", "'"))
}


// ─── XMP pattern set (:126-149) — verbatim ───────────────────────────────────

const XMP_SERIES_NESTED: &str =
    r"(?i)<calibre:series[^>]*>[\s\S]*?<rdf:value[^>]*>([^<]+)</rdf:value>";
const XMP_SERIES_FLAT: &str = r"(?i)<calibre:series[^>]*>([^<]+)</calibre:series>";
const XMP_SERIES_INDEX: &str = r"(?i)<ns0:series_index[^>]*>([^<]+)</ns0:series_index>";
const XMP_SERIES_INDEX_ALT: &str =
    r"(?i)<calibreSI:series_index[^>]*>([^<]+)</calibreSI:series_index>";
const XMP_LANGUAGE_BAG: &str = r"(?i)<dc:language[^>]*>[\s\S]*?<rdf:li[^>]*>([^<]+)</rdf:li>";
const XMP_LANGUAGE_FLAT: &str = r"(?i)<dc:language[^>]*>([^<\s][^<]*)</dc:language>";
const XMP_PUBLISHER: &str = r"(?i)<dc:publisher[^>]*>[\s\S]*?<rdf:li[^>]*>([^<]*)</rdf:li>";
const XMP_DESCRIPTION_ALT: &str =
    r"(?i)<dc:description[^>]*>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)</rdf:li>";
const XMP_DESCRIPTION: &str = r"(?i)<dc:description[^>]*>([^<]*)</dc:description>";
const XMP_TITLE: &str = r"(?i)<dc:title[^>]*>[\s\S]*?<rdf:li[^>]*>([^<]+)</rdf:li>";
const XMP_CREATOR: &str = r"(?i)<dc:creator[^>]*>[\s\S]*?<rdf:li[^>]*>([^<]+)</rdf:li>";
const XMP_DATE: &str = r"(?i)<dc:date[^>]*>([^<]+)</dc:date>";
const XMP_ISBN: &str = r"(?i)<pdfx:isbn[^>]*>(\d+)</pdfx:isbn>";
const XMP_PACKET: &str = r"(?i)<x:xmpmeta[^>]*>([\s\S]*?)</x:xmpmeta>";

/// Raw XMP matches before precedence (extractXmpFromBuffer, :172-244).
struct XmpRaw {
    series_name: Option<String>,
    /// series_index as the RAW string — parsed with parseFloat later (:299-302).
    series_index: Option<String>,
    language: Option<String>,
    publisher: Option<String>,
    description: Option<String>,
    xmp_title: Option<String>,
    xmp_creators: Option<String>,
    xmp_date: Option<String>,
    xmp_gallery_id: Option<String>,
}

/// Every value comes out of XML, so entities must be decoded (:181). The
/// worker wraps the whole extraction in try/catch, so a decode failure
/// (JS RangeError on an out-of-range code point) aborts and returns
/// everything extracted so far — modelled with Result.
fn text(raw: &str) -> Result<String, String> {
    decode_xml_entities(raw.trim())
}

fn extract_xmp_from_buffer(buffer: &[u8]) -> XmpRaw {
    let mut result = XmpRaw {
        series_name: None,
        series_index: None,
        language: None,
        publisher: None,
        description: None,
        xmp_title: None,
        xmp_creators: None,
        xmp_date: None,
        xmp_gallery_id: None,
    };
    // buffer.toString('utf-8') — lossy replacement chars on invalid UTF-8,
    // matching Buffer's utf-8 decoding.
    let str = String::from_utf8_lossy(buffer);
    let Some(packet) = Regex::new(XMP_PACKET).unwrap().captures(&str) else {
        return result;
    };
    let xmp = packet.get(1).map(|m| m.as_str()).unwrap_or("");

    // A decode error aborts and returns what was extracted so far — the
    // worker's try/catch shape.
    let run = |result: &mut XmpRaw| -> Result<(), String> {
        let set_text = |slot: &mut Option<String>, raw: Option<regex::Match<'_>>| -> Result<(), String> {
            if let Some(m) = raw {
                *slot = Some(text(m.as_str())?);
            }
            Ok(())
        };

        // calibre:series — nested <rdf:value> form first, then legacy flat
        let nested = Regex::new(XMP_SERIES_NESTED).unwrap().captures(xmp);
        match nested.and_then(|c| c.get(1)) {
            Some(m) => {
                result.series_name = Some(text(m.as_str())?);
            }
            None => {
                if let Some(m) = Regex::new(XMP_SERIES_FLAT).unwrap().captures(xmp).and_then(|c| c.get(1)) {
                    result.series_name = Some(text(m.as_str())?);
                }
            }
        }

        // series_index in calibre namespace — raw string, trimmed
        let si = Regex::new(XMP_SERIES_INDEX).unwrap().captures(xmp);
        if let Some(m) = si.and_then(|c| c.get(1)) {
            result.series_index = Some(m.as_str().trim().to_string());
        } else if let Some(m) = Regex::new(XMP_SERIES_INDEX_ALT)
            .unwrap()
            .captures(xmp)
            .and_then(|c| c.get(1))
        {
            result.series_index = Some(m.as_str().trim().to_string());
        }

        // dc:language — rdf:Bag form first, then flat text child
        let bag = Regex::new(XMP_LANGUAGE_BAG).unwrap().captures(xmp);
        match bag.and_then(|c| c.get(1)) {
            Some(m) => {
                result.language = Some(text(m.as_str())?);
            }
            None => {
                set_text(&mut result.language, Regex::new(XMP_LANGUAGE_FLAT).unwrap().captures(xmp).and_then(|c| c.get(1)))?;
            }
        }

        // dc:publisher
        set_text(&mut result.publisher, Regex::new(XMP_PUBLISHER).unwrap().captures(xmp).and_then(|c| c.get(1)))?;

        // dc:description — rdf:Alt form first, then plain text child
        let desc_alt = Regex::new(XMP_DESCRIPTION_ALT).unwrap().captures(xmp);
        match desc_alt.and_then(|c| c.get(1)) {
            Some(m) => {
                result.description = Some(text(m.as_str())?);
            }
            None => {
                set_text(&mut result.description, Regex::new(XMP_DESCRIPTION).unwrap().captures(xmp).and_then(|c| c.get(1)))?;
            }
        }

        // dc:title — fallback for pikepdf-processed files (no docinfo)
        set_text(&mut result.xmp_title, Regex::new(XMP_TITLE).unwrap().captures(xmp).and_then(|c| c.get(1)))?;

        // dc:creator — global loop (:227-232)
        let mut creators: Vec<String> = Vec::new();
        for c in Regex::new(XMP_CREATOR).unwrap().captures_iter(xmp) {
            if let Some(m) = c.get(1) {
                creators.push(text(m.as_str())?);
            }
        }
        if !creators.is_empty() {
            result.xmp_creators = Some(creators.join(", "));
        }

        // dc:date — fallback for pikepdf-processed files
        result.xmp_date = Regex::new(XMP_DATE)
            .unwrap()
            .captures(xmp)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_string());

        // pdfx:isbn — nhentai gallery ID fallback (digits only, :149)
        result.xmp_gallery_id = Regex::new(XMP_ISBN)
            .unwrap()
            .captures(xmp)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());

        Ok(())
    };
    let _ = run(&mut result);

    result
}

/// Decode a PDF text string the way pdf-lib's PDFTextString does: UTF-16BE
/// when the BOM is present, otherwise the byte values as the PDFDocEncoding
/// code points (ASCII-identical for the range this library writes).
pub fn decode_pdf_text(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let units: Vec<u16> = bytes[2..]
            .chunks(2)
            .filter(|c| c.len() == 2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    bytes.iter().map(|&b| b as char).collect()
}

/// pdf-lib's PDFDateString.parse: `D:YYYYMMDDHHmmSS[+HH'mm'|Z]` with defaults
/// month/day 1, time 0; the result is a UTC-based epoch (missing offset means
/// UTC, matching pdf-lib which builds from Date.UTC).
pub fn parse_pdf_date(s: &str) -> Option<i64> {
    let re = regex::Regex::new(
        r"(?i)^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([+\-Z])?(\d{2})?'?(\d{2})?'?$",
    )
    .ok()?;
    let c = re.captures(s.trim())?;
    let num = |i: usize| c.get(i).and_then(|m| m.as_str().parse::<i64>().ok());
    let year = num(1)?;
    let month = num(2).unwrap_or(1).max(1);
    let day = num(3).unwrap_or(1).max(1);
    let hour = num(4).unwrap_or(0);
    let minute = num(5).unwrap_or(0);
    let second = num(6).unwrap_or(0);
    // Days since epoch via the civil-date algorithm, then UTC seconds.
    let days = days_from_civil(year, month as u32, day as u32);
    let mut secs = days * 86_400 + hour * 3600 + minute * 60 + second;
    if let Some(tz) = c.get(7) {
        let sign = match tz.as_str() {
            "Z" => 0,
            "+" => 1,
            "-" => -1,
            _ => 0,
        };
        if sign != 0 {
            let oh = num(8).unwrap_or(0);
            let om = num(9).unwrap_or(0);
            secs -= sign * (oh * 3600 + om * 60);
        }
    }
    Some(secs * 1000)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    // Howard Hinnant's civil_from_days inverse.
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = ((m + 9) % 12) as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Read a docinfo string out of the /Info dictionary, if present.
/// lopdf's StringFormat is Literal/Hexadecimal only — the UTF-16 BOM check
/// lives in decode_pdf_text, which is what pdf-lib's PDFTextString does too.
fn info_value(info: &Dictionary, key: &[u8]) -> Option<String> {
    match info.get(key).ok()? {
        Object::String(bytes, _) => Some(decode_pdf_text(bytes)),
        _ => None,
    }
}

/// Resolve the /Info dictionary: trailer → Reference → dict (one level, the
/// shape every real writer emits).
fn resolve_info(doc: &lopdf::Document) -> Option<Dictionary> {
    let obj = doc.trailer.get(b"Info").ok()?;
    match obj {
        Object::Reference(id) => {
            let resolved = doc.get_object(*id).ok()?;
            resolved.as_dict().cloned().ok()
        }
        Object::Dictionary(d) => Some(d.clone()),
        _ => None,
    }
}

/// `now_ms` is the load instant: pdf-lib's `PDFDocument.load` defaults
/// `updateMetadata: true`, which fabricates CreationDate = now for files
/// whose docinfo lacks one — so getCreationDate() never returns undefined
/// and the XMP dc:date fallback is dead code in 1.x. The port reproduces
/// that exactly.
pub fn extract_pdf_metadata(file_path: &std::path::Path, now_ms: i64) -> ExtractedMetadata {
    let mut metadata = ExtractedMetadata::default();

    let buffer = match std::fs::read(file_path) {
        Ok(b) => b,
        Err(_) => return metadata,
    };
    let Ok(doc) = lopdf::Document::load_mem(&buffer) else {
        return metadata;
    };
    // updateMetadata fabricated a CreationDate before any docinfo read.
    let mut fabricated_creation = false;

    let info: Option<Dictionary> = resolve_info(&doc);

    if let Some(info) = info {
        // getTitle() || null
        if let Some(t) = info_value(&info, b"Title") {
            metadata.title = if t.is_empty() { None } else { Some(t) };
        }
        // getAuthor() split on ',' (:260)
        if let Some(a) = info_value(&info, b"Author") {
            if !a.is_empty() {
                metadata.authors = a
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
            }
        }
        // /Keywords token parse (:262-281)
        if let Some(kw) = info_value(&info, b"Keywords") {
            if !kw.is_empty() {
                let mut parsed = KeywordParsed {
                    gallery_id: None,
                    series_index: None,
                    series_name: None,
                    language: None,
                    publisher: None,
                    tags: Vec::new(),
                };
                for t in kw.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                    super::parse_keyword_token(t, &mut parsed);
                }
                if let Some(g) = parsed.gallery_id {
                    metadata.gallery_id = Some(g);
                }
                if let Some(si) = parsed.series_index {
                    metadata.series_index = Some(si);
                }
                if let Some(sn) = parsed.series_name {
                    metadata.series_name = Some(sn);
                }
                if let Some(l) = parsed.language {
                    metadata.language = Some(l);
                }
                if let Some(p) = parsed.publisher {
                    metadata.publisher = Some(p);
                }
                metadata.tags.extend(parsed.tags);
            }
        }
        // /CreationDate
        if let Some(d) = info_value(&info, b"CreationDate") {
            match parse_pdf_date(&d) {
                Some(ms) => metadata.creation_date = Some(ms),
                None => fabricated_creation = true,
            }
        } else {
            fabricated_creation = true;
        }
        // /Subject legacy series fallback (:285-290)
        if let Some(subject) = info_value(&info, b"Subject") {
            if metadata.series_name.is_none() {
                let trimmed = subject.trim().to_string();
                if !trimmed.is_empty() {
                    metadata.series_name = Some(trimmed);
                }
            }
        }
    }

    if fabricated_creation {
        metadata.creation_date = Some(now_ms);
    }

    // ── XMP metadata (primary source for calibre fields) ─────────────────
    let xmp = extract_xmp_from_buffer(&buffer);

    // XMP series overrides docinfo Subject (:296)
    if let Some(sn) = xmp.series_name {
        if !sn.is_empty() {
            metadata.series_name = Some(sn);
        }
    }
    // XMP series_index overrides Keywords token; parseFloat + isNaN guard
    // (:299-302).
    if let Some(si) = &xmp.series_index {
        if !si.is_empty() {
            if let Some(parsed) = parse_js_float(si) {
                metadata.series_index = Some(parsed);
            }
        }
    }
    if let Some(l) = &xmp.language {
        if metadata.language.is_none() && !l.is_empty() {
            metadata.language = Some(l.clone());
        }
    }
    if let Some(p) = &xmp.publisher {
        if metadata.publisher.is_none() && !p.is_empty() {
            metadata.publisher = Some(p.clone());
        }
    }
    if let Some(d) = &xmp.description {
        // metadata.description || xmp.description (:307)
        if !d.is_empty() && metadata.description.is_none() {
            metadata.description = Some(d.clone());
        }
    }

    // XMP fallbacks for pikepdf-processed files (:310-319)
    if metadata.title.is_none() {
        if let Some(t) = &xmp.xmp_title {
            if !t.is_empty() {
                metadata.title = Some(t.clone());
            }
        }
    }
    if metadata.authors.is_empty() {
        if let Some(creators) = &xmp.xmp_creators {
            metadata.authors = creators
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
    }
    if metadata.creation_date.is_none() {
        if let Some(d) = &xmp.xmp_date {
            // new Date(string) — ISO-style JS Date parsing.
            metadata.creation_date = parse_js_date(d);
        }
    }
    if metadata.gallery_id.is_none() {
        if let Some(g) = &xmp.xmp_gallery_id {
            metadata.gallery_id = g.parse::<i64>().ok();
        }
    }

    metadata
}

/// JS `parseFloat` — leading numeric prefix, NaN otherwise.
pub fn parse_js_float(s: &str) -> Option<f64> {
    let t = s.trim_start();
    let mut end = 0;
    let bytes = t.as_bytes();
    let mut seen_digit = false;
    let mut seen_dot = false;
    // [+-]?Infinity handling and exponent forms — parseFloat accepts "1e3".
    let mut i = 0;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }
    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_digit() {
            seen_digit = true;
            i += 1;
            end = i;
        } else if b == b'.' && !seen_dot {
            seen_dot = true;
            i += 1;
            end = i;
        } else if (b == b'e' || b == b'E') && seen_digit {
            // Only consume if followed by digits (with optional sign).
            let mut j = i + 1;
            if j < bytes.len() && (bytes[j] == b'+' || bytes[j] == b'-') {
                j += 1;
            }
            if j < bytes.len() && bytes[j].is_ascii_digit() {
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                end = j;
            }
            break;
        } else {
            break;
        }
    }
    if !seen_digit {
        return None;
    }
    t[..end].parse::<f64>().ok()
}

/// Minimal ES `new Date(string)` for the shapes this scanner meets:
/// date-only (UTC), and ISO date-time (no offset → local per ES2015+,
/// Z/±HH:mm honoured). Returns epoch ms; None for unparseable.
pub fn parse_js_date(s: &str) -> Option<i64> {
    let re = regex::Regex::new(
        r"^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$",
    )
    .ok()?;
    let c = re.captures(s.trim())?;
    let num = |i: usize| c.get(i).and_then(|m| m.as_str().parse::<i64>().ok());
    let year = num(1)?;
    let month = num(2)?;
    let day = num(3)?;
    let hour = num(4).unwrap_or(0);
    let minute = num(5).unwrap_or(0);
    let second = num(6).unwrap_or(0);
    let ms = num(7).map(|m| {
        // ".5" means 500 ms in ES.
        let digits = c.get(7).map(|g| g.as_str().len()).unwrap_or(3);
        m * 10_i64.pow(3 - digits as u32)
    }).unwrap_or(0);

    let days = days_from_civil(year, month as u32, day as u32);
    let utc_secs = days * 86_400 + hour * 3600 + minute * 60 + second;

    match c.get(8).map(|m| m.as_str()) {
        None => {
            if s.contains('T') || s.contains(' ') {
                // Date-time without offset: interpreted as LOCAL time (ES).
                let local_offset = local_tz_offset_secs(year, month as u32, day as u32, hour, minute, second);
                Some((utc_secs - local_offset) * 1000 + ms)
            } else {
                // Date-only: UTC (ES2015+).
                Some(utc_secs * 1000 + ms)
            }
        }
        Some("Z") => Some(utc_secs * 1000 + ms),
        Some(tz) => {
            let sign = if tz.starts_with('-') { -1 } else { 1 };
            let oh: i64 = tz[1..3].parse().ok()?;
            let om: i64 = tz[4..6].parse().ok()?;
            Some((utc_secs - sign * (oh * 3600 + om * 60)) * 1000 + ms)
        }
    }
}

fn local_tz_offset_secs(y: i64, m: u32, d: u32, hh: i64, mm: i64, ss: i64) -> i64 {
    // Offset of the local timezone at that civil instant (jiff), in seconds
    // east of UTC — subtracted to reach UTC.
    let days = days_from_civil(y, m, d);
    let ts = jiff::Timestamp::from_second(days * 86_400 + hh * 3600 + mm * 60 + ss)
        .expect("valid instant");
    let tz = jiff::tz::TimeZone::system();
    let zoned = ts.to_zoned(tz);
    i64::from(zoned.offset().seconds())
}
