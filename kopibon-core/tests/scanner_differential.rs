//! SC-01 — scanner differential against the REAL 1.x worker
//! (library-scanner.worker.ts, run as an actual worker_thread by
//! scan_harness.mjs) on a synthesised library: walk rules, extraction
//! parity (docinfo, XMP nested/flat, ComicInfo incl. entities and legacy
//! markers), queue lifecycle, thumbnail scheme, removal happy path and
//! second-scan incrementality.
//!
//! PDF thumbnails run at the plan §6 interim baseline: the JS worker runs
//! with pdftoppm unavailable ("absent, as on a poppler-less 1.x install")
//! until the rasteriser escalation (Q-S4) is decided.

#[path = "scanner_fixture.rs"]
mod scanner_fixture;

mod common;

use common::{init, js_scan, normalize_numbers, empty_scratch};
use kopibon_core::metadata::mappers::SystemClock;
use kopibon_core::scanner::{run_scan, ScanOptions, ScanState};
use serde_json::{json, Value};
use std::path::Path;

/// Run one Rust-side scan against `scratch`. Returns the result (None on
/// cancel — not exercised here) and the collected events.
fn rust_scan(
    scratch: &Path,
    library_root: &Path,
    thumbnail_dir: &Path,
) -> (Option<kopibon_core::scanner::ScanResult>, Vec<Value>) {
    let mut conn = rusqlite::Connection::open(scratch.join("db.sqlite")).expect("open rust db");
    let events = std::sync::Mutex::new(Vec::<Value>::new());
    let clock = SystemClock;
    let control = kopibon_core::scanner::AtomicControl::new();
    control.set(ScanState::Scanning);
    let t0 = std::time::Instant::now();
    let result = {
        let events_ref = &events;
        let mut emit = |e: kopibon_core::scanner::ScanEvent| {
            eprintln!("  rust event at {:?}: {:?}", t0.elapsed(), match &e { kopibon_core::scanner::ScanEvent::Progress { current, .. } => format!("progress {current}"), other => format!("{other:?}")[..20].to_string() });
            events_ref.lock().expect("events lock").push(event_json(&e));
        };
        run_scan(
            &mut conn,
            &ScanOptions {
                library_root,
                thumbnail_dir,
            },
            &clock,
            &control,
            &mut emit,
        )
        .expect("rust run_scan")
    };
    (result, events.into_inner().expect("events"))
}

fn event_json(e: &kopibon_core::scanner::ScanEvent) -> Value {
    use kopibon_core::scanner::ScanEvent;
    match e {
        ScanEvent::Progress { current, total, status } => {
            json!({"type": "progress", "current": current, "total": total, "status": status})
        }
        ScanEvent::NewItems { items } => json!({
            "type": "newItems",
            "items": items.iter().map(|i| json!({"id": i.id, "title": i.title, "artist": i.artist})).collect::<Vec<_>>(),
        }),
        ScanEvent::Paused => json!({"type": "paused"}),
        ScanEvent::Cancelled => json!({"type": "cancelled"}),
        ScanEvent::Error { message } => json!({"type": "error", "message": message}),
    }
}

fn result_json(r: &kopibon_core::scanner::ScanResult) -> Value {
    json!({
        "total": r.total,
        "newItems": r.new_items,
        "removedItems": r.removed_items,
        "errors": r.errors,
        "cancelled": r.cancelled,
        "removalSkippedReason": r.removal_skipped_reason,
    })
}

/// Table dump from the Rust scratch DB (rowid order), timestamps scrubbed.
fn dump_rust(scratch: &Path, tables: &[&str], scrub: &[&str]) -> Value {
    let conn = rusqlite::Connection::open(scratch.join("db.sqlite")).expect("open");
    let mut out = serde_json::Map::new();
    for t in tables {
        let mut stmt = conn
            .prepare(&format!("SELECT * FROM {t} ORDER BY rowid"))
            .expect("prepare");
        let cols: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let rows = stmt
            .query_map([], |r| {
                let mut o = serde_json::Map::new();
                for (i, c) in cols.iter().enumerate() {
                    let v: rusqlite::types::Value = r.get(i).expect("col");
                    o.insert(
                        c.clone(),
                        match v {
                            rusqlite::types::Value::Null => Value::Null,
                            rusqlite::types::Value::Integer(i) => json!(i),
                            rusqlite::types::Value::Real(f) => json!(f),
                            rusqlite::types::Value::Text(t) => json!(t),
                            rusqlite::types::Value::Blob(_) => Value::Null,
                        },
                    );
                }
                Ok(Value::Object(o))
            })
            .expect("query");
        let list: Vec<Value> = rows.filter_map(|r| r.ok()).collect();
        let mut list = Value::from(list);
        common::scrub_timestamps(&mut list, scrub);
        out.insert((*t).to_string(), list);
    }
    Value::Object(out)
}

const SCAN_TABLES: &[&str] = &[
    "library_item",
    "library_item_artist",
    "gallery",
    "library_scan_log",
    "scan_queue",
];
const SCRUB_COLS: &[&str] = &[
    "added_at",
    "updated_at",
    "created_at",
    "scanned_at",
    // Per-side thumbnail dirs and scan-instant upload dates: role-equal, not
    // instant-equal (plan §6 tolerance; pdf-lib's fabricated CreationDate).
    "thumbnail_path",
    "upload_date",
];

/// Flatten the newItems event stream (batch boundaries are timing-dependent;
/// their contents and order are not).
fn flatten_new_items(events: &[Value]) -> Vec<Value> {
    events
        .iter()
        .filter(|e| e["type"] == "newItems")
        .flat_map(|e| e["items"].as_array().cloned().unwrap_or_default())
        .collect()
}

fn assert_scan_parity(js: &Value, rs_result: &Option<kopibon_core::scanner::ScanResult>, rs_events: &[Value], stage: &str) {
    // Complete result parity.
    let js_result = js
        .get("result")
        .cloned()
        .expect("JS scan must complete");
    assert_eq!(
        normalize_numbers(&result_json(rs_result.as_ref().expect("rust completes"))),
        normalize_numbers(&js_result),
        "{stage}: complete result diverged"
    );
    // newItems: flattened sequence equal; every batch within BATCH_SIZE.
    let rs_items = flatten_new_items(rs_events);
    let js_items = flatten_new_items(
        js["events"].as_array().expect("JS events"),
    );
    assert_eq!(rs_items, js_items, "{stage}: newItems diverged");
    for e in rs_events.iter().chain(js_events(js)) {
        if e["type"] == "newItems" {
            assert!(
                e["items"].as_array().expect("items").len() <= 25,
                "{stage}: batch exceeds 25: {e}"
            );
        }
    }
}

fn js_events(js: &Value) -> &[Value] {
    js["events"].as_array().expect("JS events")
}

#[test]
fn sc01_full_scan_parity_and_incremental() {
    init();
    let base = std::env::temp_dir().join(format!("scan-fixture-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).expect("mkdir fixture");
    let fixture = scanner_fixture::build_extraction_fixture(&base).expect("fixture");

    // Scratch DBs pre-migrated: the worker's openWorkerConnection does NOT
    // run migrations (the main process does that in 1.x), so the JS side
    // initialises through the real TS initDatabase via a repo op, and the
    // Rust side through the same migrator via Db::open.
    let js_dir = empty_scratch("scan-js");
    let rs_dir = empty_scratch("scan-rs");
    common::js_repo_op("execSql", &json!({ "statements": [] }), &js_dir)
        .expect("JS initDatabase");
    {
        let _db = kopibon_core::db::Db::open(&rs_dir.join("db.sqlite")).expect("rust db");
    }
    let js_thumb = base.join("thumbs-js");
    let rs_thumb = base.join("thumbs-rs");
    std::fs::create_dir_all(&js_thumb).ok();
    std::fs::create_dir_all(&rs_thumb).ok();

    let scan_input = json!({
        "libraryRoot": fixture.root.to_string_lossy(),
        "thumbnailDir": js_thumb.to_string_lossy(),
        "noPdftoppm": true,
    });

    // ── Scan 1: everything new ─────────────────────────────────────────────
    let js1 = js_scan(&scan_input, &js_dir).expect("JS scan 1");
    let (rs1, rs1_events) = rust_scan(&rs_dir, &fixture.root, &rs_thumb);
    assert_scan_parity(&js1, &rs1, &rs1_events, "scan 1");

    // Full DB state parity: rows, artists, gallery stubs, scan log, queue.
    let rs_dump1 = dump_rust(&rs_dir, SCAN_TABLES, SCRUB_COLS);
    // The dump of the JS side goes through repo_harness (execSql/dumpTables).
    let js_tables = js_dump(&js_dir, SCAN_TABLES, SCRUB_COLS);
    assert_eq!(
        normalize_numbers(&rs_dump1),
        normalize_numbers(&js_tables),
        "scan 1 DB state diverged"
    );

    // ── Scan 2: incremental — mtime+size skip touches nothing ─────────────
    let js2 = js_scan(&scan_input, &js_dir).expect("JS scan 2");
    let (rs2, rs2_events) = rust_scan(&rs_dir, &fixture.root, &rs_thumb);
    assert_scan_parity(&js2, &rs2, &rs2_events, "scan 2");
    assert_eq!(
        flatten_new_items(&rs2_events),
        Vec::<Value>::new(),
        "scan 2 must emit no new items (incremental skip)"
    );
    let rs_dump2 = dump_rust(&rs_dir, SCAN_TABLES, SCRUB_COLS);
    let js_tables2 = js_dump(&js_dir, SCAN_TABLES, SCRUB_COLS);
    assert_eq!(
        normalize_numbers(&rs_dump2),
        normalize_numbers(&js_tables2),
        "scan 2 DB state diverged"
    );
    // No churn: the item/artist/gallery tables are identical to scan 1 (the
    // scan log legitimately gains one row per run).
    assert_eq!(
        normalize_numbers(rs_dump1.get("library_item").expect("rows")),
        normalize_numbers(rs_dump2.get("library_item").expect("rows")),
        "scan 2 must not churn library_item rows"
    );
    assert_eq!(
        normalize_numbers(rs_dump1.get("gallery").expect("rows")),
        normalize_numbers(rs_dump2.get("gallery").expect("rows")),
        "scan 2 must not churn gallery rows"
    );

    // ── Scan 3: removal happy path — delete one file of N ─────────────────
    std::fs::remove_file(fixture.root.join("artistB/nested/keywords_gallery.pdf"))
        .expect("delete fixture file");
    let js3 = js_scan(&scan_input, &js_dir).expect("JS scan 3");
    let (rs3, rs3_events) = rust_scan(&rs_dir, &fixture.root, &rs_thumb);
    assert_scan_parity(&js3, &rs3, &rs3_events, "scan 3 (removal)");
    let rs3 = rs3.expect("result");
    assert_eq!(rs3.new_items, 0);
    assert_eq!(rs3.removed_items, 1, "exactly one row removed");
    assert!(rs3.removal_skipped_reason.is_none(), "no guard may trip");

    // Row-level check: the removed row and its artist rows are gone on both.
    let rs_dump3 = dump_rust(&rs_dir, SCAN_TABLES, SCRUB_COLS);
    let js_tables3 = js_dump(&js_dir, SCAN_TABLES, SCRUB_COLS);
    assert_eq!(
        normalize_numbers(&rs_dump3),
        normalize_numbers(&js_tables3),
        "scan 3 DB state diverged"
    );

    std::fs::remove_dir_all(&base).ok();
    std::fs::remove_dir_all(&js_dir).ok();
    std::fs::remove_dir_all(&rs_dir).ok();
}

fn js_dump(js_dir: &Path, tables: &[&str], scrub: &[&str]) -> Value {
    let v = common::js_repo_op(
        "dumpTables",
        &json!({ "tables": tables }),
        js_dir,
    )
    .expect("JS dump");
    let mut v = v;
    common::scrub_timestamps(&mut v, scrub);
    v
}
