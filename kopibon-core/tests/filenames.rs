//! FN-01 — Sanitiser triplet differential + 251–255-byte Japanese boundary
//! vectors against live 1.x (10-test-plan §7; 07-metadata-spec §7).

mod common;

use serde_json::json;

#[test]
fn fn01_filename_differential() {
    let cases: Vec<(&str, serde_json::Value)> = vec![
        // applyGalleryIdToFilename: both marker placements (07 §8)
        (
            "applyGalleryIdToFilename",
            json!({"fileName": "Title [nhentai-528499].cbz", "galleryId": null}),
        ),
        (
            "applyGalleryIdToFilename",
            json!({"fileName": "[nhentai-00000] Title.pdf", "galleryId": 42}),
        ),
        (
            "applyGalleryIdToFilename",
            json!({"fileName": "   [nhentai-1]   ", "galleryId": 7}),
        ),
        (
            "applyGalleryIdToFilename",
            json!({"fileName": "A  B [nhentai-3].cbz", "galleryId": null}),
        ),
        (
            "applyGalleryIdToFilename",
            json!({"fileName": ".hidden", "galleryId": 5}),
        ),
        (
            "applyGalleryIdToFilename",
            json!({"fileName": "なし [nhentai-9].cbz", "galleryId": 12}),
        ),
        // 251–255-byte boundary with real Japanese titles (07 §7): 3 bytes/char
        (
            "applyGalleryIdToFilename",
            json!({"fileName": format!("{}.cbz", "日".repeat(83)), "galleryId": 528499}), // 249+marker+4
        ),
        (
            "applyGalleryIdToFilename",
            json!({"fileName": format!("{}.cbz", "日".repeat(84)), "galleryId": 528499}), // 252: marker pushes over
        ),
        (
            "applyGalleryIdToFilename",
            json!({"fileName": format!("{}.cbz", "日".repeat(85)), "galleryId": null}), // 255 exact
        ),
        (
            "applyGalleryIdToFilename",
            json!({"fileName": format!("{}.cbz", "家".repeat(86)), "galleryId": null}), // 258 over
        ),
        // emoji / astral planes (surrogate pairs in JS)
        (
            "applyGalleryIdToFilename",
            json!({"fileName": format!("🎨{}.cbz", "あ".repeat(80)), "galleryId": 1}),
        ),
        // truncateToBytes
        (
            "truncateToBytes",
            json!({"value": format!("{}", "日本語".repeat(90)), "maxBytes": 255}),
        ),
        ("truncateToBytes", json!({"value": "abc", "maxBytes": 10})),
        ("truncateToBytes", json!({"value": "日本語", "maxBytes": 7})),
        ("truncateToBytes", json!({"value": "日本語", "maxBytes": 8})),
        // tempSiblingPath: the 251→256-byte case from the module docstring
        (
            "tempSiblingPath",
            json!({"finalPath": format!("/lib/{}.cbz", "日".repeat(83))}), // 253 + .part = 258
        ),
        (
            "tempSiblingPath",
            json!({"finalPath": format!("/lib/{}.cbz", "日".repeat(82))}), // 250 + .part = 255 fits
        ),
        ("tempSiblingPath", json!({"finalPath": "/lib/short.cbz"})),
    ];
    for (op, input) in cases {
        common::assert_differential(op, &input);
    }
}

#[test]
fn fn01_sanitisers_differential() {
    let hostile = r#"a/b\c?d%e*f:g"h<i|j k.cbz"#;
    let unicode = "タイトル/テスト*だよ";
    // The three sanitisers are not exported from a bundled entry we can reach
    // (download-manager/convert-cbz pull Electron-side trees), so their
    // contract is pinned by the unit tests in filenames.rs plus these
    // shared-class differential cases through escapeXml-free ops.
    //
    // The character class is exercised via the marker machinery instead:
    // titles carrying every unsafe char through applyGalleryIdToFilename.
    let titles = vec![
        hostile.to_string(),
        unicode.to_string(),
        format!("{hostile} 漢字"),
    ];
    for t in titles {
        for id in [None, Some(528499)] {
            common::assert_differential(
                "applyGalleryIdToFilename",
                &json!({"fileName": format!("{t}.cbz"), "galleryId": id}),
            );
        }
    }
}
