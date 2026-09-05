//! SC-QA (04 §7): search-query.ts port — the real test file's cases ported
//! case-for-case, plus a differential fuzz against the live module via
//! repo_harness (negationTerm / queryHasField / buildSearchQuery /
//! matchDimEntries).

mod common;

use common::{init, js_repo_op};
use kopibon_core::nhentai::query::{
    build_search_query, match_dim_entries, negation_term, query_has_field, BlockedEntry,
    GalleryFacts, SearchDefaults,
};
use serde_json::json;

fn entry(type_: &str, value: &str, mode: &str) -> BlockedEntry {
    BlockedEntry {
        type_: type_.to_string(),
        value: value.to_string(),
        mode: mode.to_string(),
    }
}

// ─── Ported cases (search-query.test.ts) ────────────────────────────────────

#[test]
fn negation_term_cases() {
    let term = negation_term(&entry("tag", "big breasts", "exclude")).expect("term");
    assert_eq!(term, "-tag:\"big breasts\"");

    // quotes only values that contain whitespace
    assert_eq!(
        negation_term(&entry("artist", "artistname", "exclude")).expect("term"),
        "-artist:artistname"
    );
    // bare negation for free text
    assert_eq!(negation_term(&entry("text", "vanilla", "exclude")).expect("term"), "-vanilla");
    // strips embedded quotes rather than escaping them
    assert_eq!(
        negation_term(&entry("tag", "big\" breasts", "exclude")).expect("term"),
        "-tag:\"big breasts\""
    );
    // null for an empty value
    assert_eq!(negation_term(&entry("tag", "  ", "exclude")), None);
    assert_eq!(negation_term(&entry("tag", "\"\"", "exclude")), None);
}

#[test]
fn query_has_field_cases() {
    assert!(query_has_field("language:japanese", "language"));
    assert!(query_has_field("tag:a language:japanese", "language"));
    assert!(query_has_field("-language:english", "language"));
    // does not match a field name inside a word
    assert!(!query_has_field("uploaded", "uploaded"));
    assert!(!query_has_field("the uploaded movie", "uploaded"));
    assert!(!query_has_field("downloads:x", "oads"));
    // false for an unrelated query
    assert!(!query_has_field("vanilla", "language"));
}

#[test]
fn build_search_query_cases() {
    // typed query + defaults
    assert_eq!(
        build_search_query(
            "  sailor moon  ",
            &SearchDefaults {
                language: Some("english".into()),
                ..Default::default()
            },
            &[]
        ),
        "sailor moon language:english"
    );
    // default search only when nothing typed
    assert_eq!(
        build_search_query(
            "",
            &SearchDefaults {
                default_query: Some("full color".into()),
                language: Some("english".into()),
                ..Default::default()
            },
            &[]
        ),
        "full color language:english"
    );
    // does not override a filter the user typed explicitly
    assert_eq!(
        build_search_query(
            "language:japanese",
            &SearchDefaults {
                language: Some("english".into()),
                ..Default::default()
            },
            &[]
        ),
        "language:japanese"
    );
    // numeric + date filter forms
    let q = build_search_query(
        "",
        &SearchDefaults {
            min_pages: Some(10.2),
            min_favorites: Some(100.0),
            uploaded_within_days: Some(7.0),
            ..Default::default()
        },
        &[]
    );
    assert_eq!(q, "pages:>10 favorites:>=100 uploaded:<7d");
    // zero / negative thresholds ignored
    let q = build_search_query(
        "",
        &SearchDefaults {
            min_pages: Some(0.0),
            min_favorites: Some(-5.0),
            uploaded_within_days: Some(0.0),
            ..Default::default()
        },
        &[]
    );
    assert_eq!(q, "");
    // exclude entries become negations; dim entries never do
    let q = build_search_query(
        "",
        &SearchDefaults::default(),
        &[
            entry("tag", "netorare", "exclude"),
            entry("artist", "bad artist", "dim"),
            entry("text", "scat", "exclude"),
        ],
    );
    assert_eq!(q, "-tag:netorare -scat");
    // identical negations deduped
    let q = build_search_query(
        "",
        &SearchDefaults::default(),
        &[
            entry("tag", "netorare", "exclude"),
            entry("tag", "NETORARE", "exclude"),
        ],
    );
    assert_eq!(q, "-tag:netorare");
    // everything empty
    assert_eq!(build_search_query("", &SearchDefaults::default(), &[]), "");
    // defaults and blocks alone
    let q = build_search_query(
        "",
        &SearchDefaults {
            default_query: Some("english".into()),
            language: Some("english".into()),
            ..Default::default()
        },
        &[]
    );
    assert_eq!(q, "english language:english", "bare default does not suppress the language default");
    // default query treated as terms: bare keyword does not suppress language
    let q = build_search_query(
        "",
        &SearchDefaults {
            default_query: Some("full color".into()),
            language: Some("english".into()),
            ..Default::default()
        },
        &[]
    );
    assert_eq!(q, "full color language:english");
}

#[test]
fn match_dim_entries_cases() {
    let facts = GalleryFacts {
        title: Some("Great Teacher Onizuka"),
        tags: &[
            ("tag".into(), "Vanilla".into()),
            ("artist".into(), "someone".into()),
            ("language".into(), "english".into()),
        ],
    };
    // tag name + type match
    let m = match_dim_entries(&facts, &[entry("tag", "vanilla", "dim")]);
    assert_eq!(m.len(), 1);
    // exclude entries ignored
    assert!(match_dim_entries(&facts, &[entry("tag", "vanilla", "exclude")]).is_empty());
    // type must match, not just the name
    assert!(match_dim_entries(&facts, &[entry("group", "vanilla", "dim")]).is_empty());
    // exact on the name, not substring
    assert!(match_dim_entries(&facts, &[entry("tag", "van", "dim")]).is_empty());
    // case insensitive
    let m = match_dim_entries(&facts, &[entry("tag", "VANILLA", "dim")]);
    assert_eq!(m.len(), 1);
    // free text: substring of the title
    let m = match_dim_entries(&facts, &[entry("text", "teacher", "dim")]);
    assert_eq!(m.len(), 1);
    // every match, so the UI can say why
    let m = match_dim_entries(
        &facts,
        &[
            entry("text", "onizuka", "dim"),
            entry("language", "english", "dim"),
            entry("tag", "nomatch", "dim"),
        ],
    );
    assert_eq!(m.len(), 2);
}

// ─── Differential fuzz against the live module ──────────────────────────────

#[test]
fn query_differential_fuzz() {
    init();
    let scratch = std::path::Path::new("/nonexistent");
    let mut rng = Rng(0x51EE_2026);
    const TOKENS: &[&str] = &[
        "vanilla", "big breasts", "netorare", "VANILLA", "lang", "japanese", "english", "x",
        " rape ", "grape", "full color", "50%", "a_b", "zwei wörter", "\"quoted\"", "-",
        "uploaded", "pages", "favorites", ":5", "タグ", "アーティスト", "d", "7",
    ];
    const TYPES: &[&str] = &["tag", "artist", "group", "parody", "character", "language", "text"];
    const MODES: &[&str] = &["exclude", "dim"];

    for _ in 0..150 {
        let user_query = fuzz_string(&mut rng);
        let defaults = json!({
            "defaultQuery": maybe_fuzz(&mut rng),
            "sort": maybe_fuzz(&mut rng),
            "language": maybe_fuzz(&mut rng),
            "minPages": fuzz_number(&mut rng),
            "minFavorites": fuzz_number(&mut rng),
            "uploadedWithinDays": fuzz_number(&mut rng),
        });
        let mut blocked = Vec::new();
        for _ in 0..rng.below(5) {
            blocked.push(json!({
                "type": TYPES[rng.below(TYPES.len())],
                "value": TOKENS[rng.below(TOKENS.len())],
                "mode": MODES[rng.below(MODES.len())],
            }));
        }
        let input = json!({
            "userQuery": user_query,
            "defaults": defaults,
            "blocked": blocked,
        });
        let js = js_repo_op("buildSearchQuery", &input, scratch).expect("JS buildSearchQuery");
        let defaults_r = SearchDefaults {
            default_query: opt_string(&defaults["defaultQuery"]),
            sort: opt_string(&defaults["sort"]),
            language: opt_string(&defaults["language"]),
            min_pages: opt_f64(&defaults["minPages"]),
            min_favorites: opt_f64(&defaults["minFavorites"]),
            uploaded_within_days: opt_f64(&defaults["uploadedWithinDays"]),
        };
        let blocked_r: Vec<BlockedEntry> = blocked
            .iter()
            .map(|b| BlockedEntry {
                type_: b["type"].as_str().unwrap_or("").to_string(),
                value: b["value"].as_str().unwrap_or("").to_string(),
                mode: b["mode"].as_str().unwrap_or("").to_string(),
            })
            .collect();
        let rs = build_search_query(&user_query, &defaults_r, &blocked_r);
        assert_eq!(
            rs, js,
            "buildSearchQuery diverged: {input}"
        );

        // matchDimEntries on the same entries.
        let facts = json!({
            "title": TOKENS[rng.below(TOKENS.len())],
            "tags": [
                {"type": "tag", "name": "vanilla"},
                {"type": "artist", "name": "Rape Face"},
                {"type": "language", "name": "english"},
            ],
        });
        let dim_input = json!({ "facts": facts, "blocked": blocked });
        let js_dim = js_repo_op("matchDimEntries", &dim_input, scratch).expect("JS matchDim");
        let facts_r = GalleryFacts {
            title: facts["title"].as_str(),
            tags: &[
                ("tag".to_string(), "vanilla".to_string()),
                ("artist".to_string(), "Rape Face".to_string()),
                ("language".to_string(), "english".to_string()),
            ],
        };
        let rs_dim = match_dim_entries(&facts_r, &blocked_r);
        assert_eq!(
            kopibon_core::nhentai::query::dim_matches_json(&rs_dim),
            js_dim,
            "matchDimEntries diverged: {dim_input}"
        );
    }
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

fn fuzz_string(rng: &mut Rng) -> String {
    let len = rng.below(20);
    let pool = "abZ09 \"-_:._%タグ語 ";
    let chars: Vec<char> = pool.chars().collect();
    (0..len).map(|_| chars[rng.below(chars.len())]).collect()
}

fn maybe_fuzz(rng: &mut Rng) -> serde_json::Value {
    if rng.below(3) == 0 {
        serde_json::Value::Null
    } else {
        json!(fuzz_string(rng))
    }
}

fn fuzz_number(rng: &mut Rng) -> serde_json::Value {
    match rng.below(4) {
        0 => serde_json::Value::Null,
        1 => json!(0),
        2 => json!(rng.below(30) as f64 / 2.0),
        _ => json!(1 + rng.below(50)),
    }
}

fn opt_string(v: &serde_json::Value) -> Option<String> {
    v.as_str().map(|s| s.to_string())
}

fn opt_f64(v: &serde_json::Value) -> Option<f64> {
    v.as_f64()
}
