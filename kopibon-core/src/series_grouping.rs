//! Port of `src/main/services/series-grouping.ts` — the decisions behind
//! series grouping, kept free of the database.
//!
//! The one component that needed a real engine is `titleCollator`:
//! `new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })` is
//! ICU collation at primary strength with numeric ordering. This port uses the
//! `icu_collator` crate (ICU4X — the same Unicode CLDR tables V8's Intl runs
//! on) with `Strength::Primary` (= sensitivity 'base') and
//! `numeric_ordering = true`. Parity against V8 is fuzz-tested
//! (`series_grouping_differential.rs`); divergences, if any surface, get a
//! 04-parity-ledger row rather than a hand-rolled approximation.

use std::cmp::Ordering;
use std::collections::HashMap;

use icu_collator::options::{CollatorOptions, Strength};
use icu_collator::preferences::CollationNumericOrdering;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};

use crate::metadata::xml_utils::js_trim;

/// Members required before a group is shown as a series
/// (series-grouping.ts:26).
pub const DEFAULT_MIN_SERIES_MEMBERS: i64 = 2;

/// The widest run of missing volumes still reported as a gap (:36).
const MAX_REPORTED_GAP: i64 = 10;

/// Series names that name nothing (:45-55).
pub const UNGROUPABLE_NAMES: [&str; 9] = [
    "", "-", "?", "n/a", "na", "none", "null", "unknown", "unspecified",
];

/// The part of a library item that grouping cares about (:83-87).
#[derive(Debug, Clone)]
pub struct SeriesMember {
    pub id: i64,
    pub series_index: Option<f64>,
    pub title: String,
}

fn collator() -> &'static CollatorBorrowed<'static> {
    static COLLATOR: std::sync::OnceLock<Box<CollatorBorrowed<'static>>> = std::sync::OnceLock::new();
    let boxed: &CollatorBorrowed<'static> = COLLATOR.get_or_init(|| {
        let mut prefs = CollatorPreferences::default();
        // numeric: true (series-grouping.ts:89)
        prefs.numeric_ordering = Some(CollationNumericOrdering::True);
        let mut options = CollatorOptions::default();
        // sensitivity: 'base' — primary strength only.
        options.strength = Some(Strength::Primary);
        Box::new(
            Collator::try_new(prefs, options).expect("root collation data must be available"),
        )
    });
    boxed
}

/// `titleCollator.compare(a, b)` (:89, :103-108, :209).
pub fn compare_titles(a: &str, b: &str) -> Ordering {
    collator().compare(a, b)
}

/// `String.prototype.toLowerCase()` for the tag-key case folding. Per-char
/// mapping: JS has no contextual (final-sigma) rule, so `str::to_lowercase`'s
/// context handling must not leak in here.
fn js_to_lowercase(s: &str) -> String {
    s.chars().flat_map(char::to_lowercase).collect()
}

/// Trim a series name, returning null when nothing is left (:62-65).
pub fn normalise_series_name(name: Option<&str>) -> Option<String> {
    let trimmed = js_trim(name.unwrap_or(""));
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Whether a name should ever form a group (:75-78).
pub fn is_groupable_series_name(name: Option<&str>) -> bool {
    match normalise_series_name(name) {
        Some(n) => !UNGROUPABLE_NAMES.contains(&js_to_lowercase(&n).as_str()),
        None => false,
    }
}

/// Reading order: by volume, then by title (:99-110). Stable sort — JS
/// `Array.prototype.sort` is stable (ES2019) and so is `sort_by`.
pub fn sort_series_members(members: &mut [SeriesMember]) {
    members.sort_by(|a, b| {
        match (a.series_index, b.series_index) {
            (None, None) => compare_titles(&a.title, &b.title),
            // Members with no volume sort last rather than first (:96-98).
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(ai), Some(bi)) => {
                // A shared volume number is decided by the title (:106-108).
                if ai != bi {
                    ai.partial_cmp(&bi).unwrap_or(Ordering::Equal)
                } else {
                    compare_titles(&a.title, &b.title)
                }
            }
        }
    });
}

/// Which member's cover stands for the group (:121-133).
#[derive(Debug)]
pub enum Cover {
    /// A hand-picked image, which wins over a member cover.
    Path(String),
    /// The member whose cover to draw, resolved through any override.
    Member(i64),
}

pub fn pick_series_cover(
    members: &[SeriesMember],
    cover_item_id: Option<i64>,
    cover_path: Option<&str>,
) -> Option<Cover> {
    // The path override is checked first (:125-126).
    if let Some(path) = normalise_series_name(cover_path) {
        return Some(Cover::Path(path));
    }

    // `chosen != null` is a loose check in TS — a 0 id is a real choice — so
    // this must be Option, not a truthiness test.
    if let Some(chosen) = cover_item_id {
        if members.iter().any(|m| m.id == chosen) {
            return Some(Cover::Member(chosen));
        }
    }

    let mut sorted = members.to_vec();
    sort_series_members(&mut sorted);
    sorted.first().map(|first| Cover::Member(first.id))
}

/// Whole volume numbers absent from the middle of a run (:145-162).
pub fn find_volume_gaps(indexes: &[Option<f64>]) -> Vec<i64> {
    // Number.isInteger: finite with a zero fractional part. Set-dedupe, then
    // sort — same result the TS `[...new Set(...)].sort()` produces.
    let mut whole: Vec<i64> = indexes
        .iter()
        .filter_map(|i| {
            i.filter(|n| n.is_finite() && n.fract() == 0.0)
                .map(|n| n as i64)
        })
        .collect();
    whole.sort_unstable();
    whole.dedup();
    if whole.len() < 2 {
        return Vec::new();
    }

    let mut gaps = Vec::new();
    for pair in whole.windows(2) {
        let (from, to) = (pair[0], pair[1]);
        let missing = to - from - 1;
        // A jump wider than MAX_REPORTED_GAP is a second numbering block (:156-158).
        if missing <= 0 || missing > MAX_REPORTED_GAP {
            continue;
        }
        for v in from + 1..to {
            gaps.push(v);
        }
    }
    gaps
}

/// A member as far as the aggregated header is concerned (:167-173).
pub struct FactsMember<'a> {
    pub format: Option<&'a str>,
    pub language: Option<&'a str>,
    pub custom_language: Option<&'a str>,
    pub primary_artist: Option<&'a str>,
    pub custom_tags: Option<&'a str>,
}

/// What a series card / panel header shows (:175-183).
#[derive(Debug, Default, PartialEq)]
pub struct SeriesFacts {
    pub format: Option<String>,
    pub artists: Vec<String>,
    pub languages: Vec<String>,
    pub tags: Vec<String>,
}

/// Count occurrences, then order by count and break ties alphabetically
/// (:192-211). The tiebreak is what makes this stable across member order.
fn by_frequency(values: Vec<String>) -> Vec<String> {
    // Keyed case-insensitively (:196-197); the first spelling seen is displayed.
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut display: HashMap<String, String> = HashMap::new();

    for value in values {
        let trimmed = js_trim(&value);
        if trimmed.is_empty() {
            continue;
        }
        let key = js_to_lowercase(trimmed);
        display.entry(key.clone()).or_insert_with(|| trimmed.to_string());
        *counts.entry(key).or_insert(0) += 1;
    }

    let mut entries: Vec<(String, usize)> = counts.into_iter().collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| compare_titles(&a.0, &b.0)));
    entries
        .into_iter()
        .map(|(key, _)| display.get(&key).cloned().unwrap_or_default())
        .collect()
}

/// Union the members' metadata into the facts shown on a series (:214-227).
pub fn merge_series_facts(members: &[FactsMember<'_>]) -> SeriesFacts {
    // Insertion-ordered distinct set; only the size and the single element
    // matter for the format result.
    let mut formats: Vec<String> = Vec::new();
    for m in members {
        let f = js_trim(m.format.unwrap_or("")).to_lowercase();
        if !f.is_empty() && !formats.contains(&f) {
            formats.push(f);
        }
    }

    SeriesFacts {
        format: if formats.is_empty() {
            None
        } else if formats.len() == 1 {
            Some(formats.remove(0))
        } else {
            Some("mixed".to_string())
        },
        artists: by_frequency(members.iter().map(|m| m.primary_artist.unwrap_or("").to_string()).collect()),
        // customLanguage overrides language on an item (:222-224).
        languages: by_frequency(
            members
                .iter()
                .map(|m| {
                    let cl = js_trim(m.custom_language.unwrap_or(""));
                    if !cl.is_empty() {
                        cl.to_string()
                    } else {
                        m.language.unwrap_or("").to_string()
                    }
                })
                .collect(),
        ),
        tags: by_frequency(
            members
                .iter()
                .flat_map(|m| m.custom_tags.unwrap_or("").split(',').map(|s| s.to_string()))
                .collect(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collator_matches_node_smoke_cases() {
        // Ground truth: `new Intl.Collator(undefined, {numeric: true,
        // sensitivity: 'base'})` under node (locale en-US), captured 2026-09-05.
        let cases: &[(&str, &str, Ordering)] = &[
            ("a10b", "a2b", Ordering::Greater),
            ("Vol. 2", "Vol. 10", Ordering::Less),
            ("abc", "ABC", Ordering::Equal),
            ("café", "cafe", Ordering::Equal),
            ("x-y", "xy", Ordering::Less),
            ("title", "title ", Ordering::Less),
            ("(C97) [A] B", "(C97) [A] B2", Ordering::Less),
            ("2", "10", Ordering::Less),
            ("あ", "い", Ordering::Less),
            ("ß", "ss", Ordering::Equal),
            ("a_b", "ab", Ordering::Less),
            ("第2巻", "第10巻", Ordering::Less),
            ("e", "é", Ordering::Equal),
            ("a  b", "ab", Ordering::Less),
            ("1a", "01a", Ordering::Equal),
        ];
        for (a, b, expected) in cases {
            assert_eq!(compare_titles(a, b), *expected, "{a:?} vs {b:?}");
        }
    }

    #[test]
    fn volume_gaps_corners() {
        assert!(find_volume_gaps(&[]).is_empty());
        assert!(find_volume_gaps(&[Some(3.0)]).is_empty());
        assert_eq!(find_volume_gaps(&[Some(1.0), Some(4.0), None]), vec![2, 3]);
        // Fractional indexes are extras slotted between volumes; the integer
        // run 1→4 still reports its gap (node ground truth: [2,3]).
        assert_eq!(find_volume_gaps(&[Some(1.0), Some(1.5), Some(4.0)]), vec![2, 3]);
        // Wider than MAX_REPORTED_GAP is a numbering change, not a gap.
        assert!(find_volume_gaps(&[Some(21.0), Some(99.0)]).is_empty());
        // Nothing before the lowest or after the highest is reported — a
        // single member series has no interior gap at all.
        assert!(find_volume_gaps(&[Some(3.0)]).is_empty());
        assert_eq!(find_volume_gaps(&[Some(1.0), Some(2.0)]), Vec::<i64>::new());
    }

    #[test]
    fn member_sort_nulls_last_and_numeric() {
        let mut members = vec![
            SeriesMember { id: 1, series_index: None, title: "z".into() },
            SeriesMember { id: 2, series_index: Some(10.0), title: "b".into() },
            SeriesMember { id: 3, series_index: Some(2.0), title: "c".into() },
            SeriesMember { id: 4, series_index: None, title: "a".into() },
        ];
        sort_series_members(&mut members);
        let ids: Vec<i64> = members.iter().map(|m| m.id).collect();
        assert_eq!(ids, vec![3, 2, 4, 1]);
    }

    #[test]
    fn cover_falls_through_deleted_override() {
        let members = vec![
            SeriesMember { id: 1, series_index: Some(2.0), title: "b".into() },
            SeriesMember { id: 2, series_index: Some(1.0), title: "a".into() },
        ];
        // coverItemId pointing at a deleted member falls back to lowest volume.
        match pick_series_cover(&members, Some(99), None) {
            Some(Cover::Member(id)) => assert_eq!(id, 2),
            other => panic!("expected member cover, got {other:?}"),
        }
        // Path override wins outright.
        match pick_series_cover(&members, Some(1), Some("  /img.png  ")) {
            Some(Cover::Path(p)) => assert_eq!(p, "/img.png"),
            other => panic!("expected path cover, got {other:?}"),
        }
    }

    #[test]
    fn facts_merge_case_insensitive_most_used_first() {
        let facts = merge_series_facts(&[
            FactsMember { format: Some("PDF"), language: Some("eng"), custom_language: None, primary_artist: Some("A"), custom_tags: Some("x, y") },
            FactsMember { format: Some("cbz"), language: Some("english"), custom_language: Some("English"), primary_artist: Some("a"), custom_tags: Some("X,Y, z") },
            FactsMember { format: None, language: None, custom_language: None, primary_artist: Some("B"), custom_tags: None },
        ]);
        assert_eq!(facts.format.as_deref(), Some("mixed"));
        assert_eq!(facts.artists, vec!["A", "B"]);
        // 'eng' and 'english' are still two entries — knowing they are one
        // language is display formatting (series-grouping.ts:120-125).
        assert_eq!(facts.languages, vec!["eng", "English"]);
        assert_eq!(facts.tags, vec!["x", "y", "z"]);
    }
}
