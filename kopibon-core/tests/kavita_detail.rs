//! Detail-lookup unit tests (kavita-client.ts:429-589 → `get_series`,
//! `find_chapter`, `find_series_detail` + the enum tables). Replay
//! transport only — no server. Live-server acceptance stays in
//! `kavita_acceptance.rs` (id-6 guards).

use kopibon_core::kavita::{
    library_type_name, manga_format_name, KavitaClient, KavitaConfig,
};
use kopibon_core::nhentai::http::{RequestDef, ResponseDef, Transport};
use std::sync::Mutex;

struct Replay {
    responses: Mutex<Vec<Result<ResponseDef, String>>>,
}

impl Transport for Replay {
    fn send(&self, request: &RequestDef) -> Result<ResponseDef, String> {
        let _ = request;
        self.responses.lock().unwrap().remove(0)
    }
}

fn ok(body: &str) -> Result<ResponseDef, String> {
    Ok(ResponseDef {
        status: 200,
        status_text: "OK".into(),
        headers: vec![],
        body: body.to_string(),
    })
}

fn client(responses: Vec<Result<ResponseDef, String>>) -> KavitaClient<'static, Replay> {
    let boxed: &'static Replay = Box::leak(Box::new(Replay {
        responses: Mutex::new(responses),
    }));
    KavitaClient::new(
        boxed,
        KavitaConfig::read(Some(("http://kavita.test", "k", "6"))),
    )
}

#[test]
fn enum_tables_match_1x() {
    assert_eq!(
        (0..6).map(library_type_name).collect::<Vec<_>>(),
        ["Manga", "Comic", "Book", "Image", "Light Novel", "Comic"]
    );
    assert_eq!(library_type_name(99), "");
    assert_eq!(library_type_name(-1), "");
    assert_eq!(
        (0..5).map(manga_format_name).collect::<Vec<_>>(),
        ["Image", "Archive", "Unknown", "EPUB", "PDF"]
    );
    assert_eq!(manga_format_name(99), "Unknown");
}

#[test]
fn get_series_maps_fields() {
    let c = client(vec![ok(
        r#"{"id":7,"name":"Teyvat","libraryId":6,"libraryName":"Doujin-Test","pages":42,"format":1,"lastChapterAdded":"2026-01-02T03:04:05","pagesRead":10,"totalReads":3}"#,
    )]);
    let d = c.get_series(7).expect("detail");
    assert_eq!(d.id, 7);
    assert_eq!(d.name, "Teyvat");
    assert_eq!(d.library_id, 6);
    assert_eq!(d.library_name, "Doujin-Test");
    assert_eq!(d.page_count, 42);
    assert_eq!(d.format, "Archive");
    assert_eq!(d.last_updated.as_deref(), Some("2026-01-02T03:04:05"));
    assert_eq!(d.pages_read, Some(10));
    assert_eq!(d.total_reads, Some(3));
    assert_eq!(d.chapter_id, None);
    // Envelope shape: optionals present here, no nulls anywhere.
    let v = d.to_value();
    assert_eq!(v["format"], serde_json::json!("Archive"));
    assert_eq!(v["lastUpdated"], serde_json::json!("2026-01-02T03:04:05"));
}

#[test]
fn get_series_defaults_and_null_is_none() {
    let c = client(vec![ok(r#"{"id":9}"#)]);
    let d = c.get_series(9).expect("detail");
    assert_eq!(d.name, "");
    assert_eq!(d.library_id, 0);
    assert_eq!(d.page_count, 0);
    assert_eq!(d.format, "Unknown");
    assert_eq!(d.last_updated, None);
    // Missing optionals are OMITTED, not null (structured-clone parity).
    let v = d.to_value();
    assert!(v.get("lastUpdated").is_none());
    assert!(v.get("chapterId").is_none());
    assert!(v.get("pagesRead").is_none());
}

#[test]
fn get_series_unreachable_is_none() {
    let c = client(vec![Err("boom".to_string())]);
    assert_eq!(c.get_series(1), None);
}

#[test]
fn find_chapter_matches_basename_case_insensitively() {
    let volumes = r#"[{"chapters":[
        {"id":11,"title":"Ch 1","files":[{"filePath":"C:\\Kavita\\lib\\ALPHA.cbz"}]},
        {"id":12,"title":"","files":[{"filePath":"/kavita/lib/other.cbz"}]}
    ]},{"chapters":[
        {"id":13,"files":[]}
    ]}]"#;
    let c = client(vec![ok(volumes)]);
    let hit = c.find_chapter(5, "/app/lib/alpha.CBZ").expect("hit");
    assert_eq!(hit.id, 11);
    assert_eq!(hit.title.as_deref(), Some("Ch 1"));
    // Count spans ALL volumes (3), not just up to the match.
    assert_eq!(hit.chapter_count, 3);
}

#[test]
fn find_chapter_miss_is_none() {
    let c = client(vec![ok(r#"[{"chapters":[{"id":1,"files":[{"filePath":"/x/a.cbz"}]}]}]"#)]);
    assert_eq!(c.find_chapter(5, "/app/lib/b.cbz"), None);
}

#[test]
fn find_series_detail_prefers_exact_match() {
    let search = r#"{"series":[
        {"seriesId":1,"name":"Teyvat Gravure Extra"},
        {"seriesId":2,"name":"Teyvat Gravure"}
    ]}"#;
    let detail = r#"{"id":2,"name":"Teyvat Gravure","pages":5,"format":4}"#;
    let c = client(vec![ok(search), ok(detail)]);
    let d = c
        .find_series_detail("Teyvat Gravure", "other title", None)
        .expect("detail");
    assert_eq!(d.id, 2);
    assert_eq!(d.format, "PDF");
}

#[test]
fn find_series_detail_falls_back_to_title_then_first_hit() {
    // Empty series name → title search; no exact match → first hit.
    let search = r#"{"series":[{"seriesId":8,"name":"Something Else"}]}"#;
    let detail = r#"{"id":8,"name":"Something Else","pages":1}"#;
    let c = client(vec![ok(search), ok(detail)]);
    let d = c
        .find_series_detail("  ", "lone title", None)
        .expect("detail");
    assert_eq!(d.id, 8);
}

#[test]
fn find_series_detail_no_match_is_none() {
    let c = client(vec![ok(r#"{"series":[]}"#), ok(r#"{"series":[]}"#)]);
    assert_eq!(c.find_series_detail("zzz", "yyy", None), None);
}

#[test]
fn find_series_detail_resolves_chapter() {
    let search = r#"{"series":[{"seriesId":3,"name":"S"}]}"#;
    let detail = r#"{"id":3,"name":"S","pages":9,"format":1}"#;
    let volumes = r#"[{"chapters":[
        {"id":31,"title":"5","files":[{"filePath":"/kavita/s/file.cbz"}]},
        {"id":32,"title":"6","files":[]}
    ]}]"#;
    let c = client(vec![ok(search), ok(detail), ok(volumes)]);
    let d = c
        .find_series_detail("S", "", Some("/app/s/FILE.cbz"))
        .expect("detail");
    assert_eq!(d.chapter_id, Some(31));
    assert_eq!(d.chapter_title.as_deref(), Some("5"));
    assert_eq!(d.chapter_count, Some(2));
    let v = d.to_value();
    assert_eq!(v["chapterId"], serde_json::json!(31));
}
