//! MA-01 — Mapper differential: the 58 cases of
//! `src/main/services/metadata/mappers.test.ts` re-run as a differential
//! against live 1.x on the real template files (10-test-plan §7). ComicInfo
//! and XMP artefacts compare byte-exact; `/Keywords` and docinfo compare as
//! token/string values, with the D6 producer deviation expected on the Info
//! dict (the XMP `pdf:Producer` is byte-parity and stays verbatim).

mod common;

use serde_json::{json, Value};

/// Fixed write-moment for the XMP volatile fields (07-metadata-spec §9).
const NOW_MS: i64 = 1788566452000; // 2026-09-05T00:00:52Z

fn base_meta() -> Value {
    // meta() from mappers.test.ts:29: makeFileMetadata({ title: 'A Title',
    // artists: ['artist'], pageCount: 10, ...over })
    json!({
        "title": "A Title",
        "artists": ["artist"],
        "pageCount": 10
    })
}

fn meta_over(over: Value) -> Value {
    let mut m = base_meta();
    if let (Some(base), Some(extra)) = (m.as_object_mut(), over.as_object()) {
        for (k, v) in extra {
            base.insert(k.clone(), v.clone());
        }
    }
    m
}

#[test]
fn ma01_comicinfo_structure_and_kavita_rules() {
    let cases = vec![
        // — structure —
        meta_over(json!({})),
        meta_over(json!({
            "title": "T & U", "seriesName": "S & V", "artists": ["A & B"],
            "tags": ["x & y"], "description": "sum & more", "publisher": "P & Q"
        })),
        // — Kavita field rules —
        meta_over(json!({"title": "Solo", "seriesIndex": 1})),
        meta_over(json!({"seriesName": "Real Series", "seriesIndex": 7})),
        meta_over(json!({
            "title": "Seijo no Mita Yume", "seriesName": "Seijo no Mita Yume", "seriesIndex": 1
        })),
        meta_over(json!({"seriesName": "   ", "seriesIndex": 2})),
        meta_over(json!({"seriesName": "S", "seriesIndex": 2})),
        meta_over(json!({"artists": ["one", "two"]})),
        meta_over(json!({"artists": [], "groups": ["A Circle"]})),
        meta_over(json!({"artists": []})),
        meta_over(json!({"groups": ["Circle"], "publisher": "Other"})),
        meta_over(json!({"pageCount": 143})),
        meta_over(json!({"pageCount": 0})),
        meta_over(json!({"galleryId": 123})),
        meta_over(json!({"galleryId": null})),
        meta_over(json!({"galleryId": 0})),
        meta_over(json!({"parodies": ["P"]})),
        meta_over(json!({"parodies": ["A", "B"]})),
        meta_over(json!({"categories": ["doujinshi"], "parodies": ["blue archive"]})),
        meta_over(json!({"categories": ["doujinshi"], "parodies": ["A", "B"]})),
        // — LocalizedSeries and StoryArc —
        meta_over(json!({"title": "Pretty", "titleJapanese": "日本語"})),
        meta_over(json!({
            "title": "Vol 2", "titleJapanese": "第二巻",
            "seriesName": "A Series", "seriesIndex": 2
        })),
        meta_over(json!({"seriesName": "A Series", "seriesIndex": 3})),
        meta_over(json!({"seriesIndex": 1})),
        // — release date (fixed instants; both processes run TZ=Asia/Tokyo) —
        meta_over(json!({"releaseDate": "2021-03-04T15:00:00.000Z"})), // 2021-03-05 local
        meta_over(json!({"releaseDate": "2021-01-01T00:00:00.000Z"})),
        // — language —
        meta_over(json!({"language": "english"})),
        meta_over(json!({"languageTags": ["translated", "english"]})),
        meta_over(json!({"language": "translated"})),
        meta_over(json!({"language": "rewrite"})),
        meta_over(json!({"language": "speechless"})),
        meta_over(json!({"language": "nonsense"})),
        meta_over(json!({"language": "jpn"})),
        meta_over(json!({"language": "eng"})),
        meta_over(json!({"language": "zh-Hans"})),
        // — template-author fields —
        meta_over(json!({
            "mediaId": 12345, "favorites": 900,
            "coverUrl": "https://t.nhentai.net/x/cover.jpg", "titleEnglish": "English Title"
        })),
        // — escape/illegal-character stress on every text field —
        meta_over(json!({
            "title": "T <tag> & \"q\" 'a'",
            "description": "line1\nline2\r\n\ttab — em dash — 漢字",
            "artists": ["ann\u{0008}bell"], "tags": ["\u{7F}del\u{1F}"]
        })),
    ];

    for meta in &cases {
        let input = json!({"meta": meta});
        common::assert_differential("buildComicInfoXml", &input);
    }
}

#[test]
fn ma01_xmp_rules() {
    let cases = vec![
        meta_over(json!({})),
        meta_over(json!({"title": "T & U", "allTags": ["x & y"]})),
        meta_over(json!({"language": "english"})),
        meta_over(json!({"language": "translated"})),
        meta_over(json!({"seriesName": "S"})),
        meta_over(json!({"seriesName": "S", "seriesIndex": 3})),
        meta_over(json!({"seriesName": "S", "seriesIndex": 2.5})),
        meta_over(json!({"tags": ["a"], "allTags": ["a", "artist name", "english"]})),
        meta_over(json!({"galleryId": null})),
        meta_over(json!({"galleryId": 0})),
        meta_over(json!({"galleryId": 527302, "releaseDate": "2024-08-28T12:42:28.000Z"})),
        // Series block with escaped values and authorSort reversal.
        meta_over(json!({
            "seriesName": "A & B Series", "seriesIndex": 12,
            "artists": ["First Last"], "title": "The Title"
        })),
    ];
    for meta in &cases {
        let input = json!({"meta": meta, "now": NOW_MS});
        common::assert_differential("buildXmpXml", &input);
        common::assert_differential("xmpContext", &input);
    }
}

#[test]
fn ma01_keyword_tokens_and_docinfo() {
    let cases = vec![
        meta_over(json!({
            "allTags": ["tag one"], "galleryId": 42, "seriesName": "S",
            "seriesIndex": 2, "language": "English", "groups": ["Circle"]
        })),
        meta_over(json!({"languageTags": ["translated", "english"]})),
        meta_over(json!({})),
        meta_over(json!({"galleryId": 0})),
        meta_over(json!({"seriesIndex": 0})),
        meta_over(json!({"seriesIndex": 2.5})),
        meta_over(json!({"seriesIndex": 1e21})),
        meta_over(json!({"groups": [], "publisher": "Publisher Only"})),
        meta_over(json!({"title": "T & U", "artists": ["A", "B"]})),
    ];
    for meta in &cases {
        let input = json!({"meta": meta});
        common::assert_differential("buildKeywordTokens", &input);
        // DocInfo: D6 — the port's Producer is "Kopibon 2.x" (semantic level);
        // every other field is value-identical.
        let js = common::js_op("buildDocInfo", &input).expect("JS buildDocInfo");
        let rs = common::rust_op("buildDocInfo", &input).expect("Rust buildDocInfo");
        for key in ["title", "author", "keywords"] {
            assert_eq!(
                js.get(key),
                rs.get(key),
                "docinfo.{key} diverged for meta {meta}"
            );
        }
        assert_eq!(
            js.get("producer").and_then(|v| v.as_str()),
            Some("pikepdf 10.8.0")
        );
        assert_eq!(
            rs.get("producer").and_then(|v| v.as_str()),
            Some("Kopibon 2.x")
        );
    }
}

/// Adapter inputs from mappers.test.ts (:427-621) — the resulting FileMetadata
/// must be value-identical (JSON, numbers normalised) on both sides.
#[test]
fn ma01_adapters() {
    let gallery = json!({
        "id": 900,
        "title": {"english": "English Title", "japanese": "日本語", "pretty": "Pretty Title"},
        "tags": [
            {"type": "artist", "name": "The Artist"},
            {"type": "group", "name": "The Circle"},
            {"type": "category", "name": "doujinshi"},
            {"type": "tag", "name": "a tag"},
            {"type": "character", "name": "someone"},
            {"type": "parody", "name": "a parody"},
            {"type": "language", "name": "translated"},
            {"type": "language", "name": "english"}
        ],
        "uploadDate": 1600000000,
        "numPages": 20
    });

    let adapter_cases: Vec<(Value, Value)> = vec![
        // fileMetadataFromGallery — tag bucketing, title variants
        (
            json!({"op": "fileMetadataFromGallery", "gallery": gallery}),
            json!({}),
        ),
        (
            json!({"op": "fileMetadataFromGallery", "gallery": gallery}),
            json!({"seriesName": "A Series", "seriesIndex": 2}),
        ),
        // zero upload timestamp → no date
        (
            json!({"op": "fileMetadataFromGallery", "gallery": {
                "id": 1, "title": {"english": "e", "japanese": null, "pretty": "p"},
                "tags": [], "uploadDate": 0, "numPages": 1
            }}),
            json!({}),
        ),
        // fileMetadataFromLibraryItem — row artist vs artist tag
        (
            json!({"op": "fileMetadataFromLibraryItem", "row": {
                "primaryArtist": "Corrected",
                "rawTagsJson": "[{\"type\":\"artist\",\"name\":\"A\"},{\"type\":\"tag\",\"name\":\"t\"},{\"type\":\"language\",\"name\":\"japanese\"}]"
            }}),
            json!({}),
        ),
        // scanner stub → no release date, customTags as tags
        (
            json!({"op": "fileMetadataFromLibraryItem", "row": {
                "customTitle": "T", "customTags": "x, y", "uploadDate": 1750000000,
                "rawTagsJson": "[{\"type\":\"tag\",\"name\":\"x\"}]"
            }}),
            json!({}),
        ),
        // real row → release date; row language joins the candidates
        (
            json!({"op": "fileMetadataFromLibraryItem", "row": {
                "uploadDate": 1600000000, "customLanguage": "English",
                "rawTagsJson": "[{\"type\":\"artist\",\"name\":\"A\"},{\"type\":\"tag\",\"name\":\"t\"},{\"type\":\"language\",\"name\":\"japanese\"}]"
            }}),
            json!({}),
        ),
        // unparseable tag JSON → stub treatment
        (
            json!({"op": "fileMetadataFromLibraryItem", "row": {
                "rawTagsJson": "{oops", "customTags": "x"
            }}),
            json!({}),
        ),
        // Gallery #N fallback titles
        (
            json!({"op": "fileMetadataFromLibraryItem", "row": {"galleryId": 900}}),
            json!({}),
        ),
        (
            json!({"op": "fileMetadataFromLibraryItem", "row": {"id": 12}}),
            json!({}),
        ),
        (
            json!({"op": "fileMetadataFromLibraryItem", "row": {}}),
            json!({}),
        ),
        // fileMetadataFromPayload
        (
            json!({"op": "fileMetadataFromPayload", "payload": {
                "title": "T", "creators": [], "tags": [], "language": "jpn"
            }}),
            json!({}),
        ),
        (
            json!({"op": "fileMetadataFromPayload", "payload": {
                "title": "T", "creators": ["C"], "tags": ["a", "b"]
            }}),
            json!({}),
        ),
        (
            json!({"op": "fileMetadataFromPayload", "payload": {
                "title": "T", "creators": [], "tags": [], "date": "not-a-date"
            }}),
            json!({}),
        ),
        (
            json!({"op": "fileMetadataFromPayload", "payload": {
                "title": "T", "creators": [], "tags": [],
                "date": "2021-03-04T15:00:00.000Z"
            }}),
            json!({}),
        ),
        // "every entry point describes the same gallery the same way"
        (
            json!({"op": "fileMetadataFromGallery", "gallery": {
                "id": 900,
                "title": {"english": "English Title", "japanese": "日本語", "pretty": "Pretty Title"},
                "tags": gallery["tags"], "uploadDate": 1600000000, "numPages": 20,
                "seriesName": "S", "seriesIndex": 4
            }}),
            json!({}),
        ),
        (
            json!({"op": "fileMetadataFromLibraryItem", "row": {
                "galleryId": 900, "customTitle": "Pretty Title",
                "primaryArtist": "The Artist", "seriesName": "S", "seriesIndex": 4,
                "rawTagsJson": gallery["tags"].to_string()
            }}),
            json!({}),
        ),
        (
            json!({"op": "fileMetadataFromPayload", "payload": {
                "title": "Pretty Title", "creators": ["The Artist"], "tags": [],
                "nhentaiId": 900, "seriesName": "S", "seriesIndex": 4
            }}),
            json!({}),
        ),
        // edited-title override through the adapter (rewrites keep genre etc.)
        (
            json!({"op": "fileMetadataFromLibraryItem", "row": {
                "galleryId": 900, "customTitle": "Some Doujin",
                "primaryArtist": "The Artist", "seriesName": "A Series", "seriesIndex": 3,
                "rawTagsJson": gallery["tags"].to_string()
            }}),
            json!({"title": "Edited Title"}),
        ),
    ];

    for (input, over) in &adapter_cases {
        let mut full = input.clone();
        full["over"] = over.clone();
        // The adapter result feeds the writers identically on both sides.
        // Numbers normalise to f64 so `900` (JS JSON) equals `900.0` (Rust).
        let js_meta = common::js_op(input["op"].as_str().unwrap(), &full).expect("JS adapter");
        let rs_meta = common::rust_op(input["op"].as_str().unwrap(), &full).expect("Rust adapter");
        assert_eq!(
            common::normalize_numbers(&js_meta),
            common::normalize_numbers(&rs_meta),
            "adapter {} produced different metadata",
            input["op"].as_str().unwrap()
        );
        let ci = json!({"meta": js_meta});
        common::assert_differential("buildComicInfoXml", &ci);
    }
}
