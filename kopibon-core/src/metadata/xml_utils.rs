//! Port of `src/main/services/xml-utils.ts` — escaping, entity decoding and
//! language mapping (07-metadata-spec §3 is the contract; the TS file is the
//! reference implementation and the cites below are its line numbers).

/// Characters that are illegal in XML 1.0 even when escaped
/// (xml-utils.ts:20). Stripped *before* entity substitution.
fn is_illegal_xml_char(c: char) -> bool {
    matches!(c, '\x00'..='\x08' | '\x0B' | '\x0C' | '\x0E'..='\x1F' | '\x7F')
}

/// Escape text for inclusion in XML element text or attribute values
/// (xml-utils.ts:28-36): illegal chars stripped first, then `& < > " '`,
/// ampersand first.
pub fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if is_illegal_xml_char(c) {
            continue;
        }
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Decode XML character entities back to literal characters
/// (xml-utils.ts:47-56): numeric entities first (hex, then decimal order is
/// inherent to the scan), then the named five with `&` **last**.
///
/// JS `String.fromCodePoint` throws `RangeError: Invalid code point N` for
/// values above 0x10FFFF; that surfaces as the same error string here. JS can
/// build lone surrogates; Rust `String` cannot hold them (valid XML 1.0
/// excludes surrogate code points) so they decode to U+FFFD — no real input
/// in this library carries them.
pub fn decode_xml_entities(s: &str) -> Result<String, String> {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c == '&' && s[i..].starts_with("&#") {
            match decode_numeric_entity(&s[i..], &mut out) {
                Ok(Some(len)) => {
                    // Advance past the entity: '&' is already consumed, and
                    // `len` is the whole entity's byte length.
                    for _ in 0..(len - 1) {
                        chars.next();
                    }
                    continue;
                }
                Ok(None) => {}
                Err(e) => return Err(e),
            }
        }
        out.push(c);
    }
    // Then the named five, ampersand last (xml-utils.ts:51-55).
    let out = out.replace("&lt;", "<");
    let out = out.replace("&gt;", ">");
    let out = out.replace("&quot;", "\"");
    let out = out.replace("&#39;", "'");
    let out = out.replace("&amp;", "&");
    Ok(out)
}

/// Decode one numeric entity at the start of `rest` (`&#x..;` or `&#..;`),
/// pushing its char onto `out`. Returns Ok(Some(byte length)) on success,
/// Ok(None) when `rest` does not start with a well-formed numeric entity
/// (the JS regexes simply fail to match then), Err for the JS RangeError.
fn decode_numeric_entity(rest: &str, out: &mut String) -> Result<Option<usize>, String> {
    let b = rest.as_bytes();
    // JS hex form is `&#x` — lowercase only (xml-utils.ts:49).
    let (hex, digits_start) = if b.len() > 3 && b[2] == b'x' {
        (true, 3)
    } else {
        (false, 2)
    };
    let mut end = digits_start;
    while end < b.len() {
        let d = b[end];
        let ok = if hex {
            d.is_ascii_hexdigit()
        } else {
            d.is_ascii_digit()
        };
        if !ok {
            break;
        }
        end += 1;
    }
    if end == digits_start || end >= b.len() || b[end] != b';' {
        return Ok(None);
    }
    let digits = &rest[digits_start..end];
    let value = if hex {
        match u128::from_str_radix(digits, 16) {
            Ok(v) => v,
            Err(_) => return Err(invalid_code_point_msg_js(digits, 16)),
        }
    } else {
        match digits.parse::<u128>() {
            Ok(v) => v,
            Err(_) => return Err(invalid_code_point_msg_js(digits, 10)),
        }
    };
    if value > 0x10FFFF {
        // JS: String.fromCodePoint throws RangeError: Invalid code point <n>
        return Err(format!(
            "Invalid code point {}",
            crate::metadata::js_number::js_to_string_u128(value)
        ));
    }
    match char::from_u32(value as u32) {
        Some(c) => out.push(c),
        None => out.push('\u{FFFD}'), // lone surrogate (see module doc)
    }
    Ok(Some(end + 1))
}

/// For absurdly long digit strings JS's `parseInt` yields Infinity and
/// `fromCodePoint` reports "Invalid code point Infinity"; unreachable for any
/// entity short enough to matter, but keep the message shape honest.
fn invalid_code_point_msg_js(digits: &str, radix: u32) -> String {
    let v = u128::from_str_radix(digits, radix).unwrap_or(u128::MAX);
    format!(
        "Invalid code point {}",
        crate::metadata::js_number::js_to_string_u128(v)
    )
}

// ─── Language mapping (xml-utils.ts:63-185) ─────────────────────────────────

/// `LANGUAGE_TO_ISO` (xml-utils.ts:79-108): nhentai tag names plus ISO 639-2
/// T and B forms, exactly as tabled.
const LANGUAGE_TO_ISO: &[(&str, &str)] = &[
    ("english", "en"),
    ("japanese", "ja"),
    ("chinese", "zh"),
    ("korean", "ko"),
    ("french", "fr"),
    ("spanish", "es"),
    ("german", "de"),
    ("italian", "it"),
    ("portuguese", "pt"),
    ("russian", "ru"),
    ("other", "ot"),
    ("eng", "en"),
    ("jpn", "ja"),
    ("zho", "zh"),
    ("chi", "zh"),
    ("kor", "ko"),
    ("fra", "fr"),
    ("fre", "fr"),
    ("spa", "es"),
    ("deu", "de"),
    ("ger", "de"),
    ("ita", "it"),
    ("por", "pt"),
    ("rus", "ru"),
];

/// Convert a free-text language value to an ISO 639-1 code
/// (xml-utils.ts:116-122). Bare two-letter lowercase passes through; the map
/// covers the rest; anything else (e.g. `translated`) is null.
pub fn to_iso_language(lang: Option<&str>) -> Option<String> {
    let lang = lang?;
    let lower = lang.to_lowercase();
    let lower = js_trim(&lower);
    if lower.is_empty() {
        return None;
    }
    if lower.len() == 2 && lower.bytes().all(|b| b.is_ascii_lowercase()) {
        return Some(lower.to_string());
    }
    LANGUAGE_TO_ISO
        .iter()
        .find(|(k, _)| *k == lower)
        .map(|(_, v)| v.to_string())
}

/// The only language values this app stores, in priority order
/// (xml-utils.ts:141).
pub const CANONICAL_LANGUAGES: [&str; 3] = ["English", "Japanese", "Chinese"];

const LANGUAGE_ALIASES: [(&str, &[&str]); 3] = [
    ("English", &["english", "en", "eng"]),
    ("Japanese", &["japanese", "ja", "jpn", "jp"]),
    ("Chinese", &["chinese", "zh", "zho", "chi", "cn"]),
];

/// Resolve language tags to one canonical name by **priority order, not input
/// order** (xml-utils.ts:166-185): each candidate reduces to its primary
/// subtag (`split(/[-_]/)[0]`), then the first canonical language whose
/// aliases are seen wins.
pub fn resolve_language_name(candidates: &[Option<String>]) -> Option<String> {
    let mut seen = std::collections::HashSet::new();
    for raw in candidates {
        let Some(raw) = raw else { continue };
        let lowered = raw.to_lowercase();
        let norm = js_trim(&lowered);
        // 'en-US' and 'zh_Hans' both reduce to their primary subtag.
        let norm = norm.split(['-', '_']).next().unwrap_or("");
        if !norm.is_empty() {
            seen.insert(norm.to_string());
        }
    }
    if seen.is_empty() {
        return None;
    }
    for (name, aliases) in LANGUAGE_ALIASES {
        if aliases.iter().any(|a| seen.contains(*a)) {
            return Some(name.to_string());
        }
    }
    None
}

/// JS `String.prototype.trim()` — trims the JS WhiteSpace + LineTerminator
/// set, which differs from Rust's `char::is_whitespace` in that it also drops
/// U+FEFF (and Rust's set is otherwise the same for practical input).
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| {
        matches!(
            c,
            '\u{0009}'..='\u{000D}'
                | '\u{0020}'
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_order_and_illegal_strip() {
        assert_eq!(escape_xml("a<b&c\"d'e"), "a&lt;b&amp;c&quot;d&#39;e");
        assert_eq!(escape_xml("a\u{00}b\u{1F}c\u{7F}"), "abc");
        assert_eq!(escape_xml("\u{0B}"), "");
    }

    #[test]
    fn decode_named_then_numeric() {
        assert_eq!(decode_xml_entities("&lt;&amp;&gt;").unwrap(), "<&>");
        assert_eq!(decode_xml_entities("&#65;&#x41;").unwrap(), "AA");
        assert_eq!(decode_xml_entities("&amp;lt;").unwrap(), "&lt;");
        assert_eq!(decode_xml_entities("&lt;").unwrap(), "<");
        assert_eq!(
            decode_xml_entities("&notanentity;").unwrap(),
            "&notanentity;"
        );
        assert_eq!(decode_xml_entities("&#x1F600;").unwrap(), "\u{1F600}");
    }

    #[test]
    fn decode_range_error_string() {
        let err = decode_xml_entities("&#x110000;").unwrap_err();
        assert_eq!(err, "Invalid code point 1114112");
    }

    #[test]
    fn iso_and_names() {
        assert_eq!(to_iso_language(Some("Japanese")).as_deref(), Some("ja"));
        assert_eq!(to_iso_language(Some("jpn")).as_deref(), Some("ja"));
        assert_eq!(to_iso_language(Some("  ZH ")).as_deref(), Some("zh"));
        assert_eq!(to_iso_language(Some("translated")), None);
        assert_eq!(to_iso_language(Some("")), None);
        let cands = vec![Some("translated".into()), Some("english".into())];
        assert_eq!(resolve_language_name(&cands).as_deref(), Some("English"));
        let cands = vec![Some("japanese".into()), Some("english".into())];
        assert_eq!(resolve_language_name(&cands).as_deref(), Some("English"));
        let cands = vec![Some("japanese".into())];
        assert_eq!(resolve_language_name(&cands).as_deref(), Some("Japanese"));
        let cands = vec![Some("speechless".into())];
        assert_eq!(resolve_language_name(&cands), None);
    }
}
