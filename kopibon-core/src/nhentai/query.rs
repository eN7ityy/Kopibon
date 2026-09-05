//! search-query.ts port — query composition and blocked-value matching.
//! Pure: no Electron, DB or network. The query string is the one place where
//! a mistake is invisible (a malformed filter silently returns the wrong
//! galleries), so it is the differentially-tested surface of the client.

use serde_json::{json, Value};

/// The nhentai tag types that can be blocked, plus a free-text phrase
/// (search-query.ts:17).
pub const BLOCKED_TYPES: [&str; 7] = [
    "tag", "artist", "group", "parody", "character", "language", "text",
];

/// A blocked entry (search-query.ts:21-26).
#[derive(Debug, Clone, PartialEq)]
pub struct BlockedEntry {
    pub type_: String,
    pub value: String,
    /// 'exclude' | 'dim'
    pub mode: String,
}

/// Search defaults (search-query.ts:27-39).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SearchDefaults {
    pub default_query: Option<String>,
    pub sort: Option<String>,
    pub language: Option<String>,
    pub min_pages: Option<f64>,
    pub min_favorites: Option<f64>,
    pub uploaded_within_days: Option<f64>,
}

/// quoteIfNeeded (:51-54): quote only on whitespace; embedded `"` stripped,
/// never escaped (no documented escape in the syntax).
fn quote_if_needed(value: &str) -> String {
    let cleaned = value.replace('"', "");
    let cleaned = cleaned.trim();
    // /\s/.test — JS \s (includes U+FEFF, excludes U+0085).
    let has_ws = cleaned.chars().any(crate::metadata::xml_utils::is_js_whitespace);
    if has_ws {
        format!("\"{cleaned}\"")
    } else {
        cleaned.to_string()
    }
}

/// negationTerm (:57-62): `-value` for text, `-{type}:{value}` otherwise;
/// null when the cleaned value is empty.
pub fn negation_term(entry: &BlockedEntry) -> Option<String> {
    let value = quote_if_needed(&entry.value);
    if value.is_empty() {
        return None;
    }
    if entry.type_ == "text" {
        Some(format!("-{value}"))
    } else {
        Some(format!("-{}:{}", entry.type_, value))
    }
}

/// queryHasField (:74-76): term-boundary `(^|\s)-?{field}:` case-insensitive
/// — a default never overrides what the user typed.
pub fn query_has_field(query: &str, field: &str) -> bool {
    let re = regex::Regex::new(&format!(r"(?i)(^|\s)-?{field}:")).expect("valid pattern");
    re.is_match(query)
}

/// buildSearchQuery (:87-134): user terms first (or defaultQuery only when
/// nothing typed), then defaults, then deduped `exclude` negations. `dim`
/// entries never become negations (:123).
pub fn build_search_query(
    user_query: &str,
    defaults: &SearchDefaults,
    blocked: &[BlockedEntry],
) -> String {
    let typed = user_query.trim();
    // The default search stands in only when nothing was typed.
    let base_owned;
    let base = if !typed.is_empty() {
        typed
    } else {
        base_owned = defaults.default_query.as_deref().unwrap_or("").trim();
        base_owned
    };

    let mut terms: Vec<String> = Vec::new();
    if !base.is_empty() {
        terms.push(base.to_string());
    }

    if let Some(language) = &defaults.language {
        if !language.is_empty() && !query_has_field(base, "language") {
            terms.push(format!("language:{}", quote_if_needed(language)));
        }
    }
    if let Some(min_pages) = defaults.min_pages {
        // `!= null && > 0` — NaN is neither, matching the TS guard shape.
        if min_pages > 0.0 && !query_has_field(base, "pages") {
            terms.push(format!("pages:>{}", js_floor(min_pages)));
        }
    }
    if let Some(min_favorites) = defaults.min_favorites {
        if min_favorites > 0.0 && !query_has_field(base, "favorites") {
            terms.push(format!("favorites:>={}", js_floor(min_favorites)));
        }
    }
    if let Some(days) = defaults.uploaded_within_days {
        if days > 0.0 && !query_has_field(base, "uploaded") {
            terms.push(format!("uploaded:<{}d", js_floor(days)));
        }
    }

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for entry in blocked {
        if entry.mode != "exclude" {
            continue;
        }
        let Some(term) = negation_term(entry) else {
            continue;
        };
        let key = term.to_lowercase();
        if seen.insert(key) {
            terms.push(term);
        }
    }

    terms.join(" ").trim().to_string()
}

/// JS Math.floor → i64 string (values are integral in practice; f64 floor
/// keeps the TS arithmetic on non-integers).
fn js_floor(v: f64) -> String {
    let f = v.floor();
    if f == f.trunc() && f.abs() < 9.007_199_254_740_992e15 {
        format!("{}", f as i64)
    } else {
        crate::metadata::js_number::js_to_string(f)
    }
}

/// What is known about a gallery when deciding whether to dim it (:139-145).
#[derive(Debug, Clone, Default)]
pub struct GalleryFacts<'a> {
    pub title: Option<&'a str>,
    pub tags: &'a [(String, String)], // (type, name)
}

/// Which `dim` entries a gallery matches (:163-185). Returns every match so
/// the UI can say *why*. Tag comparison is case-insensitive and exact on the
/// name; `text` is a case-insensitive substring of the title.
pub fn match_dim_entries(facts: &GalleryFacts<'_>, blocked: &[BlockedEntry]) -> Vec<(String, String)> {
    let mut matches = Vec::new();
    let title = facts.title.unwrap_or("").to_lowercase();
    for entry in blocked {
        if entry.mode != "dim" {
            continue;
        }
        let needle = entry.value.trim().to_lowercase();
        if needle.is_empty() {
            continue;
        }
        if entry.type_ == "text" {
            if title.contains(&needle) {
                matches.push((entry.type_.clone(), entry.value.clone()));
            }
            continue;
        }
        let hit = facts
            .tags
            .iter()
            .any(|(tag_type, tag_name)| {
                tag_type == &entry.type_ && tag_name.trim().to_lowercase() == needle
            });
        if hit {
            matches.push((entry.type_.clone(), entry.value.clone()));
        }
    }
    matches
}

/// JSON shape used by the differential harness (DimMatch).
pub fn dim_matches_json(matches: &[(String, String)]) -> Value {
    Value::Array(
        matches
            .iter()
            .map(|(t, v)| json!({ "type": t, "value": v }))
            .collect(),
    )
}
