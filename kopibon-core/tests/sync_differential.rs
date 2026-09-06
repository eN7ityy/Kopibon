//! SY-01 — batch sync tests (07 §4): retry ladder on the scripted transport
//! (429 not counted against attempts, backoff ladder), 90%-of-limit pacing
//! with the work-time subtraction, cooperative cancel, per-item guards, the
//! main-side commit (library row + full gallery cache enrichment) and the
//! series-preservation rule.

mod common;

use kopibon_core::metadata::mappers::FixedClock;
use kopibon_core::nhentai::http::{RequestDef, ResponseDef, Transport};
use serde_json::{json, Value};
use std::io::Write;
use std::sync::Mutex;

// ─── Scripted transport ──────────────────────────────────────────────────────

struct Scripted {
    responses: Mutex<Vec<Result<ResponseDef, String>>>,
    requests: Mutex<Vec<RequestDef>>,
}

impl Transport for Scripted {
    fn send(&self, request: &RequestDef) -> Result<ResponseDef, String> {
        self.requests.lock().unwrap().push(request.clone());
        self.responses.lock().unwrap().remove(0)
    }
}

fn ok(body: String) -> Result<ResponseDef, String> {
    Ok(ResponseDef {
        status: 200,
        status_text: "OK".into(),
        headers: vec![],
        body,
    })
}

fn status429(retry_after: Option<&str>) -> Result<ResponseDef, String> {
    Ok(ResponseDef {
        status: 429,
        status_text: "Too Many Requests".into(),
        headers: retry_after
            .map(|v| vec![("Retry-After".to_string(), v.to_string())])
            .unwrap_or_default(),
        body: String::new(),
    })
}

fn err(status: u16, text: &str) -> Result<ResponseDef, String> {
    Ok(ResponseDef {
        status,
        status_text: text.into(),
        headers: vec![],
        body: String::new(),
    })
}

fn gallery_json(id: i64) -> Value {
    json!({
        "id": id,
        "media_id": "999888",
        "title": {"english": "Synced English", "japanese": "同期タイトル", "pretty": "Synced Pretty"},
        "cover": {"path": "cover.jpg", "width": 1, "height": 2},
        "thumbnail": {"path": "thumb.jpg", "width": 1, "height": 2},
        "scanlator": "",
        "upload_date": 1_600_000_000,
        "tags": [
            {"id": 1, "type": "artist", "name": "Sync Artist"},
            {"id": 2, "type": "language", "name": "translated"},
            {"id": 3, "type": "language", "name": "english"},
            {"id": 4, "type": "group", "name": "Sync Group"},
            {"id": 5, "type": "parody", "name": "Sync Parody"}
        ],
        "num_pages": 3,
        "num_favorites": 7,
        "pages": []
    })
}

/// A tiny valid CBZ the sync rewrites in place.
fn make_cbz(path: &std::path::Path) {
    let file = std::fs::File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
    zip.start_file("ComicInfo.xml", opts).unwrap();
    zip.write_all(b"<ComicInfo><Title>Old</Title></ComicInfo>").unwrap();
    zip.start_file("0001.jpg", opts).unwrap();
    zip.write_all(b"jpgbytes").unwrap();
    zip.finish().unwrap();
}

fn setup(db_name: &str) -> (tempdir::TempDirGuard, rusqlite::Connection) {
    let dir = std::env::temp_dir().join(format!("sync-{}-{db_name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let db = kopibon_core::db::Db::open(&dir.join("db.sqlite")).unwrap();
    drop(db);
    let conn = rusqlite::Connection::open(dir.join("db.sqlite")).unwrap();
    (tempdir::TempDirGuard(dir), conn)
}

mod tempdir {
    use std::path::PathBuf;
    pub struct TempDirGuard(pub PathBuf);
    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

static NEXT_GALLERY: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(1000);

fn seed_items(conn: &rusqlite::Connection, library_root: &std::path::Path, count: usize) -> Vec<i64> {
    let mut ids = Vec::new();
    for _i in 0..count {
        let gid = NEXT_GALLERY.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let rel = format!("Artist/item-{gid}.cbz");
        let abs = library_root.join(&rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        make_cbz(&abs);
        conn.execute(
            "INSERT INTO library_item (file_path, primary_artist, format, gallery_id, series_name, series_index, added_at, updated_at)
             VALUES (?, 'Artist', 'cbz', ?, 'Kept Series', 1.5, unixepoch(), unixepoch())",
            rusqlite::params![rel, gid],
        )
        .unwrap();
        ids.push(conn.last_insert_rowid());
    }
    ids
}

#[test]
fn sy01_retry_ladder_and_success_commit() {
    let (_guard, mut conn) = setup("ladder");
    let library_root = std::env::temp_dir().join(format!("sync-lib-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&library_root);
    std::fs::create_dir_all(&library_root).unwrap();
    let ids = seed_items(&conn, &library_root, 1);

    // API: 500, 500, then 200 — success on attempt 3.
    let transport = Scripted {
        responses: Mutex::new(vec![
            err(500, "Internal Server Error"),
            err(502, "Bad Gateway"),
            ok(gallery_json(1000).to_string()),
        ]),
        requests: Mutex::new(Vec::new()),
    };
    let sleeps = Mutex::new(Vec::new());
    let clock = FixedClock(1_000_000);
    let mut notify_events = Vec::new();

    let result = kopibon_core::sync::run_sync_batch(
        &mut conn,
        &transport,
        &ids,
        Some("k"),
        &library_root.to_string_lossy(),
        &|| false,
        &clock,
        0,
        &mut |ms| sleeps.lock().unwrap().push(ms),
        &mut |e| notify_events.push(e),
    )
    .unwrap();

    assert_eq!(result["succeeded"], json!(1));
    assert_eq!(result["failed"], json!(0));
    assert_eq!(result["total"], json!(1));
    // Backoff ladder 2000+1*1000, 2000+2*1000, then the 90% pacing interval
    // (keyed: ceil(60000/40) = 1500) — the item's work counts against it.
    assert_eq!(sleeps.lock().unwrap().as_slice(), &[3000, 4000, 1500]);

    // In-place rewrite: the ComicInfo inside the CBZ now carries the synced
    // metadata (title from pretty, language resolved past 'translated').
    let rel: String = conn
        .query_row("SELECT file_path FROM library_item WHERE id = ?", [ids[0]], |r| r.get(0))
        .unwrap();
    let ci = kopibon_core::metadata::writers::comicinfo::read_entry(
        &library_root.join(&rel),
        "ComicInfo.xml",
    )
    .unwrap();
    let ci_text = String::from_utf8_lossy(&ci);
    assert!(ci_text.contains("Synced Pretty"), "{ci_text}");
    assert!(
        ci_text.contains("<LanguageISO>en</LanguageISO>"),
        "language resolved by priority past 'translated': {ci_text}"
    );
    // Series preserved from OUR row (nhentai has none).
    assert!(ci_text.contains("Kept Series"), "{ci_text}");

    // Main-side commit: library row updated; gallery cache fully enriched.
    let row: (String, String, Option<i64>, String) = conn
        .query_row(
            "SELECT custom_title, custom_tags, page_count, publisher FROM library_item WHERE id = ?",
            [ids[0]],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(row.0, "Synced Pretty");
    assert!(row.1.contains("Sync Parody"));
    assert_eq!(row.2, Some(1), "page count re-derived from the rewritten file");
    assert_eq!(row.3, "Sync Group");
    let raw_json: String = conn
        .query_row("SELECT raw_json FROM gallery WHERE id = 1000", [], |r| r.get(0))
        .unwrap();
    assert!(raw_json.contains("Synced Japanese") || raw_json.contains("同期タイトル"));
    let japanese_title: Option<String> = conn
        .query_row("SELECT title_japanese FROM gallery WHERE id = 1000", [], |r| r.get(0))
        .unwrap();
    assert_eq!(japanese_title.as_deref(), Some("同期タイトル"), "the response's other fields persisted");

    // Progress after the item.
    assert_eq!(notify_events.len(), 1);
    assert_eq!(notify_events[0]["total"], json!(1));

    std::fs::remove_dir_all(&library_root).ok();
}

#[test]
fn sy01_429_not_counted_and_three_failures_error() {
    let (_guard, mut conn) = setup("r429");
    let library_root = std::env::temp_dir().join(format!("sync-lib2-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&library_root);
    std::fs::create_dir_all(&library_root).unwrap();
    let ids = seed_items(&conn, &library_root, 1);

    // 429×2 then 200 succeeds — a 429 does not hit the failure backoff. NOTE
    // (preserved quirk): the source comment claims "continue doesn't count as
    // an attempt", but the for-loop increments on continue, so a THIRD 429
    // exhausts the loop. The code is the parity contract; the plan's
    // "extend indefinitely" reading follows the comment, not the loop.
    let transport = Scripted {
        responses: Mutex::new(vec![
            status429(Some("1")),
            status429(Some("1")),
            ok(gallery_json(1000).to_string()),
        ]),
        requests: Mutex::new(Vec::new()),
    };
    let sleeps = std::rc::Rc::new(Mutex::new(Vec::new()));
    let sleeps_sink = sleeps.clone();
    let clock = FixedClock(1_000_000);
    let result = kopibon_core::sync::run_sync_batch(
        &mut conn,
        &transport,
        &ids,
        None,
        &library_root.to_string_lossy(),
        &|| false,
        &clock,
        100,
        &mut |ms| sleeps_sink.lock().unwrap().push(ms),
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(result["succeeded"], json!(1));
    let waits = sleeps.lock().unwrap().clone();
    // Two 429 waits then the pacing interval (anonymous, after a successful
    // item whose work-time didn't advance the fake clock).
    assert_eq!(waits.len(), 3);
    for w in &waits[..2] {
        assert!((1000..=2000).contains(w), "retry_after*1000 + jitter: {w}");
    }
    assert_eq!(waits[2], 3334, "pacing interval after the item");

    // 3 hard failures → the item fails; the queue row carries the error.
    let transport = Scripted {
        responses: Mutex::new(vec![
            err(500, "E1"),
            err(500, "E2"),
            err(500, "E3"),
        ]),
        requests: Mutex::new(Vec::new()),
    };
    let ids2 = seed_items(&conn, &library_root, 1);
    let result = kopibon_core::sync::run_sync_batch(
        &mut conn,
        &transport,
        &ids2,
        None,
        &library_root.to_string_lossy(),
        &|| false,
        &FixedClock(1_000_000),
        0,
        &mut |ms| sleeps.lock().unwrap().push(ms),
        &mut |_| {},
    )
    .unwrap();
    eprintln!("DBG run2: {result}");
    assert_eq!(result["failed"], json!(1));
    assert_eq!(result["total"], json!(1), "total is the requested batch size");
    let error: Option<String> = conn
        .query_row(
            "SELECT error_message FROM sync_queue WHERE library_item_id = ?",
            [ids2[0]],
            |r| r.get(0),
        )
        .unwrap();
    eprintln!("DBG run2 err: {error:?}");
    assert!(error.unwrap().contains("HTTP 500: E3"));
    std::fs::remove_dir_all(&library_root).ok();
}

#[test]
fn sy01_guards_cancel_and_pacing() {
    let (_guard, mut conn) = setup("guards");
    let library_root = std::env::temp_dir().join(format!("sync-lib3-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&library_root);
    std::fs::create_dir_all(&library_root).unwrap();
    let ids = seed_items(&conn, &library_root, 2);

    // A row with no gallery id → the guard message.
    conn.execute(
        "INSERT INTO library_item (file_path, primary_artist, format, added_at, updated_at)
         VALUES ('Artist/nogid.cbz', 'Artist', 'cbz', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let nogid = conn.last_insert_rowid();

    // Pacing: anonymous gallery limit 20/min → target 18 → interval ceil(60000/18).
    assert_eq!(kopibon_core::sync::pacing_interval_ms(false), 3334);
    // Keyed 45/min → target 40 (floor(40.5)=40) → 1500ms.
    assert_eq!(kopibon_core::sync::pacing_interval_ms(true), 1500);

    // All three items sync (transport answers each).
    let transport = Scripted {
        responses: Mutex::new(vec![
            ok(gallery_json(1000).to_string()),
            ok(gallery_json(1001).to_string()),
            ok(gallery_json(1002).to_string()),
        ]),
        requests: Mutex::new(Vec::new()),
    };
    let sleeps = Mutex::new(Vec::new());
    let clock = FixedClock(1_000_000);
    let mut all_ids = ids.clone();
    all_ids.push(nogid);
    let result = kopibon_core::sync::run_sync_batch(
        &mut conn,
        &transport,
        &all_ids,
        None,
        &library_root.to_string_lossy(),
        &|| false,
        &clock,
        0,
        &mut |ms| sleeps.lock().unwrap().push(ms),
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(result["succeeded"], json!(2));
    assert_eq!(result["failed"], json!(1));
    assert_eq!(result["total"], json!(3));

    // Pacing: the item's own work counts against the interval — sleeps are
    // the remaining part only. FixedClock does not advance, so the full
    // interval is slept here (no work time to subtract).
    let waits = sleeps.into_inner().unwrap();
    assert_eq!(waits, vec![3334, 3334], "anonymous 90% interval after each item");

    // The guard failed the nogid row with the documented message.
    let error: Option<String> = conn
        .query_row(
            "SELECT error_message FROM sync_queue WHERE library_item_id = ?",
            [nogid],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        error.as_deref(),
        Some("No nhentai id, or the file is in use")
    );

    // Cooperative cancel: pending rows stay pending.
    let ids3 = seed_items(&conn, &library_root, 1);
    let transport = Scripted {
        responses: Mutex::new(vec![]),
        requests: Mutex::new(Vec::new()),
    };
    let result = kopibon_core::sync::run_sync_batch(
        &mut conn,
        &transport,
        &ids3,
        None,
        &library_root.to_string_lossy(),
        &|| true,
        &FixedClock(1_000_000),
        0,
        &mut |_| {},
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(result["succeeded"], json!(0));
    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE status = 'pending'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pending, 1, "pending rows untouched by cancel");

    // Resume (empty ids) continues what is pending.
    let transport = Scripted {
        responses: Mutex::new(vec![ok(gallery_json(1003).to_string())]),
        requests: Mutex::new(Vec::new()),
    };
    let result = kopibon_core::sync::run_sync_batch(
        &mut conn,
        &transport,
        &[],
        None,
        &library_root.to_string_lossy(),
        &|| false,
        &FixedClock(1_000_000),
        0,
        &mut |_| {},
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(result["succeeded"], json!(1));
    assert_eq!(result["total"], json!(0), "resume reports the requested (empty) batch size");

    std::fs::remove_dir_all(&library_root).ok();
}
