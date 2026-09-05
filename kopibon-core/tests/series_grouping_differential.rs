//! Sprint-0 (WP-A5 completion) — series-grouping.ts port parity:
//! the `Intl.Collator(numeric, base)` probe (fuzz), member sort order,
//! volume gaps, merged facts and cover pick against the real TS module via
//! `tests/differential/repo_harness.mjs`.
//!
//! The collator is the highest-risk component: V8 runs ICU with the host's
//! CLDR; the Rust side runs ICU4X's compiled root tables. Sign-level parity
//! over a seeded fuzz corpus is the gate; any divergence gets a
//! 04-parity-ledger row (not a silent approximation).

mod common;

use common::{init, js_repo_op, normalize_numbers};
use serde_json::{json, Value};
use std::cmp::Ordering;

/// Deterministic xorshift so failures reproduce.
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
    const ALPHABETS: &[&str] = &[
        "abcdefghijABCIJ0123456789",
        " -_.()[]/|:;,+~'\"&%",
        "éàüßñçåøæ",
        "あいうえおかきく漢字巻",
        "٠١٢٣4567", // Arabic-Indic + ASCII digits
    ];
    let len = rng.below(16);
    let mut s = String::new();
    for _ in 0..len {
        let alphabet = ALPHABETS[rng.below(ALPHABETS.len())];
        let bytes = alphabet.chars().collect::<Vec<_>>();
        s.push(bytes[rng.below(bytes.len())]);
    }
    s
}

#[test]
fn collator_sign_parity_fuzz() {
    init();
    let cases = std::env::var("FUZZ_CASES")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(3000);
    let mut rng = Rng(0x5EED_2026_0905);

    // Pairs include both directions and duplicates so Equal, Less and
    // Greater all occur; deterministic corner pairs are prepended.
    let mut pairs: Vec<(String, String)> = vec![
        ("a10b".into(), "a2b".into()),
        ("Vol. 2".into(), "Vol. 10".into()),
        ("title".into(), "title ".into()),
        ("x-y".into(), "xy".into()),
        ("1a".into(), "01a".into()),
        ("ß".into(), "ss".into()),
        ("の".into(), "ん".into()),
    ];
    for _ in 0..cases {
        let a = fuzz_string(&mut rng);
        let b = if rng.below(4) == 0 {
            // Mutations of `a` hit the numeric/ignorable edges harder.
            let mut chars: Vec<char> = a.chars().collect();
            if !chars.is_empty() {
                let pos = rng.below(chars.len());
                chars.insert(pos, if rng.below(2) == 0 { '0' } else { '-' });
            }
            chars.into_iter().collect()
        } else {
            fuzz_string(&mut rng)
        };
        pairs.push((a, b));
    }

    let input = json!({ "pairs": pairs });
    let js: Vec<i64> = serde_json::from_value(
        js_repo_op("collatorCompareBatch", &input, std::path::Path::new("/nonexistent")).expect("JS collator batch"),
    )
    .expect("array");

    assert_eq!(js.len(), pairs.len(), "harness returned every pair");
    let mut diffs = Vec::new();
    for (i, ((a, b), js_sign)) in pairs.iter().zip(js.iter()).enumerate() {
        let expected = match crate_compare(a, b) {
            Ordering::Less => -1,
            Ordering::Equal => 0,
            Ordering::Greater => 1,
        };
        if expected != *js_sign {
            diffs.push(format!("#{i} {a:?} vs {b:?}: rust={expected} js={js_sign}"));
            if diffs.len() >= 10 {
                break;
            }
        }
    }
    assert!(
        diffs.is_empty(),
        "collator sign divergences ({}+ shown of {} pairs):\n{}",
        diffs.len(),
        pairs.len(),
        diffs.join("\n")
    );
}

fn crate_compare(a: &str, b: &str) -> Ordering {
    kopibon_core::series_grouping::compare_titles(a, b)
}

#[test]
fn sort_series_members_parity_fuzz() {
    init();
    let mut rng = Rng(0xC0FFEE);
    let mut cases: Vec<Value> = Vec::new();
    for _ in 0..40 {
        let n = 1 + rng.below(12);
        let members: Vec<Value> = (0..n)
            .map(|i| {
                let index = match rng.below(4) {
                    0 => Value::Null,
                    1 => json!(rng.below(12) as f64),
                    2 => json!((rng.next() % 1000) as f64 / 10.0),
                    _ => json!(rng.below(5) as i64), // ties on purpose
                };
                json!({
                    "id": i,
                    "seriesIndex": index,
                    "title": fuzz_string(&mut rng),
                })
            })
            .collect();
        cases.push(json!({ "members": members }));
    }

    for (i, case) in cases.iter().enumerate() {
        let js = js_repo_op("sortSeriesMembers", case, std::path::Path::new("/nonexistent"))
            .unwrap_or_else(|e| panic!("JS sortSeriesMembers case {i}: {e}"));
        let mut members: Vec<kopibon_core::series_grouping::SeriesMember> = case["members"]
            .as_array()
            .expect("members")
            .iter()
            .map(|m| kopibon_core::series_grouping::SeriesMember {
                id: m["id"].as_i64().unwrap_or(0),
                series_index: m["seriesIndex"].as_f64(),
                title: m["title"].as_str().unwrap_or("").to_string(),
            })
            .collect();
        kopibon_core::series_grouping::sort_series_members(&mut members);
        let rs: Vec<Value> = members
            .iter()
            .map(|m| json!({"id": m.id, "seriesIndex": m.series_index, "title": m.title}))
            .collect();
        assert_eq!(
            normalize_numbers(&Value::from(rs)),
            normalize_numbers(&js),
            "sortSeriesMembers diverged on case {i}: {case}"
        );
    }
}

#[test]
fn helper_parity_fixed_and_fuzz() {
    init();
    let scratch = std::path::Path::new("/nonexistent");

    // findVolumeGaps — fixed corners with node-verified expectations.
    let gap_cases: Vec<Value> = vec![
        json!([]),
        json!([3.0]),
        json!([1.0, 4.0, null]),
        json!([1.0, 1.5, 4.0]),
        json!([21.0, 99.0]),
        json!([1.0, 2.0]),
        json!([0.0, 12.0]),
        json!([-5.0, -2.0]),
        json!([2.0, 2.0, 6.0]),
        json!([10.5, null, 11.0]),
    ];
    for case in &gap_cases {
        let js = js_repo_op("findVolumeGaps", &json!({ "indexes": case }), scratch).expect("JS gaps");
        let rs = kopibon_core::series_grouping::find_volume_gaps(
            &case
                .as_array()
                .expect("array")
                .iter()
                .map(|v| v.as_f64())
                .collect::<Vec<_>>(),
        );
        assert_eq!(
            Value::from(rs),
            js,
            "findVolumeGaps diverged on {case}"
        );
    }

    // mergeSeriesFacts — insertion-order / case-fold / language-override edges.
    let fact_cases = vec![
        json!([]),
        json!([
            { "format": "PDF", "language": "eng", "customLanguage": null, "primaryArtist": "A", "customTags": "x, y" },
            { "format": "cbz", "language": "english", "customLanguage": "English", "primaryArtist": "a", "customTags": "X,Y, z" }
        ]),
        json!([
            { "format": null, "language": null, "customLanguage": null, "primaryArtist": null, "customTags": null },
            { "format": "  ", "language": "", "customLanguage": "  ", "primaryArtist": "  B  ", "customTags": "," }
        ]),
        json!([
            { "format": "pdf", "language": "jp", "customLanguage": "JP", "primaryArtist": "same", "customTags": "タグ" },
            { "format": "pdf", "language": "jp", "customLanguage": "", "primaryArtist": "same", "customTags": "タグ,別" }
        ]),
    ];
    for case in &fact_cases {
        let js = js_repo_op("mergeSeriesFacts", &json!({ "members": case }), scratch)
            .expect("JS facts");
        let members: Vec<kopibon_core::series_grouping::FactsMember<'_>> = case
            .as_array()
            .expect("array")
            .iter()
            .map(|m| kopibon_core::series_grouping::FactsMember {
                format: m["format"].as_str(),
                language: m["language"].as_str(),
                custom_language: m["customLanguage"].as_str(),
                primary_artist: m["primaryArtist"].as_str(),
                custom_tags: m["customTags"].as_str(),
            })
            .collect();
        let rs = kopibon_core::series_grouping::merge_series_facts(&members);
        let rs_json = json!({
            "format": rs.format,
            "artists": rs.artists,
            "languages": rs.languages,
            "tags": rs.tags,
        });
        assert_eq!(rs_json, js, "mergeSeriesFacts diverged on {case}");
    }

    // pickSeriesCover — override fall-through edges.
    let members = json!([
        { "id": 1, "seriesIndex": 2.0, "title": "b" },
        { "id": 2, "seriesIndex": 1.0, "title": "a" },
        { "id": 3, "seriesIndex": null, "title": "z" }
    ]);
    let cover_cases = vec![
        json!({ "members": members, "coverItemId": null, "coverPath": null }),
        json!({ "members": members, "coverItemId": 99, "coverPath": null }),
        json!({ "members": members, "coverItemId": 2, "coverPath": null }),
        json!({ "members": members, "coverItemId": 2, "coverPath": " /img.png " }),
        json!({ "members": members, "coverItemId": 2, "coverPath": "   " }),
        json!({ "members": members, "coverItemId": 0, "coverPath": null }),
    ];
    for case in &cover_cases {
        let js = js_repo_op("pickSeriesCover", case, scratch).expect("JS cover");
        let parsed_members: Vec<kopibon_core::series_grouping::SeriesMember> = case["members"]
            .as_array()
            .expect("members")
            .iter()
            .map(|m| kopibon_core::series_grouping::SeriesMember {
                id: m["id"].as_i64().unwrap_or(0),
                series_index: m["seriesIndex"].as_f64(),
                title: m["title"].as_str().unwrap_or("").to_string(),
            })
            .collect();
        let rs = kopibon_core::series_grouping::pick_series_cover(
            &parsed_members,
            case["coverItemId"].as_i64(),
            case["coverPath"].as_str(),
        );
        let rs_json = match rs {
            Some(kopibon_core::series_grouping::Cover::Path(p)) => json!({ "coverPath": p }),
            Some(kopibon_core::series_grouping::Cover::Member(id)) => json!({ "memberId": id }),
            None => Value::Null,
        };
        assert_eq!(rs_json, js, "pickSeriesCover diverged on {case}");
    }

    // normalise/isGroupable — the ungroupable list.
    for name in [
        "", "  ", "-", "?", "N/A", " None ", "null", "UNKNOWN", "unspecified", "na", "Dolls",
        "0", "?!",
    ] {
        let js_g = js_repo_op("isGroupableSeriesName", &json!({ "name": name }), scratch)
            .expect("JS groupable");
        assert_eq!(
            kopibon_core::series_grouping::is_groupable_series_name(Some(name)),
            js_g,
            "isGroupableSeriesName diverged on {name:?}"
        );
        let js_n = js_repo_op("normaliseSeriesName", &json!({ "name": name }), scratch)
            .expect("JS normalise");
        assert_eq!(
            Value::from(kopibon_core::series_grouping::normalise_series_name(Some(name))),
            js_n,
            "normaliseSeriesName diverged on {name:?}"
        );
    }
}
