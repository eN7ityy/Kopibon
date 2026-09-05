//! SC-02 — the removal triple guard (04-parity-ledger P0): each guard proven
//! with ZERO deletions against the REAL 1.x worker, plus row-count invariants
//! before/after. Happy path (exactly one row + artists deleted) is covered by
//! scanner_differential scan 3.

#[path = "scanner_fixture.rs"]
mod scanner_fixture;

mod common;

use common::{init, js_scan, normalize_numbers, empty_scratch};
use kopibon_core::metadata::mappers::SystemClock;
use kopibon_core::scanner::{run_scan, ScanOptions, ScanState};
use serde_json::{json, Value};
use std::path::Path;

fn rust_scan(scratch: &Path, library_root: &Path, thumbnail_dir: &Path) -> Value {
    let mut conn = rusqlite::Connection::open(scratch.join("db.sqlite")).expect("open rust db");
    let clock = SystemClock;
    let control = kopibon_core::scanner::AtomicControl::new();
    control.set(ScanState::Scanning);
    let r = run_scan(
        &mut conn,
        &ScanOptions {
            library_root,
            thumbnail_dir,
        },
        &clock,
        &control,
        &mut |_| {},
    )
    .expect("rust run_scan")
    .expect("completes");
    json!({
        "total": r.total,
        "newItems": r.new_items,
        "removedItems": r.removed_items,
        "errors": r.errors,
        "cancelled": r.cancelled,
        "removalSkippedReason": r.removal_skipped_reason,
    })
}

fn init_db(scratch: &Path) {
    let _db = kopibon_core::db::Db::open(&scratch.join("db.sqlite")).expect("rust db init");
}

/// Seed on the Rust side from JSON-shaped statements (same shape the JS
/// execSql op takes), converting params to rusqlite values.
fn seed_json(scratch: &Path, statements: &[Value]) {
    let conn = rusqlite::Connection::open(scratch.join("db.sqlite")).expect("open for seed");
    for stmt in statements {
        let params: Vec<rusqlite::types::Value> = stmt["params"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|v| match v {
                        Value::Null => rusqlite::types::Value::Null,
                        Value::Bool(b) => rusqlite::types::Value::Integer(*b as i64),
                        Value::Number(n) => n
                            .as_i64()
                            .map(rusqlite::types::Value::Integer)
                            .unwrap_or(rusqlite::types::Value::Real(n.as_f64().expect("num"))),
                        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
                        _ => rusqlite::types::Value::Null,
                    })
                    .collect()
            })
            .unwrap_or_default();
        conn.execute(stmt["sql"].as_str().expect("sql"), rusqlite::params_from_iter(params.iter()))
            .expect("exec seed");
    }
}

fn stmt_json(sql: &str, params: Vec<Value>) -> Value {
    json!({ "sql": sql, "params": params })
}

fn row_count(scratch: &Path, table: &str) -> i64 {
    let conn = rusqlite::Connection::open(scratch.join("db.sqlite")).expect("open count");
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .expect("count")
}

fn js_row_count(js_dir: &Path, table: &str) -> i64 {
    let dump = common::js_repo_op("dumpTables", &json!({ "tables": [table] }), js_dir)
        .expect("JS dump");
    dump[table].as_array().expect("rows").len() as i64
}

/// A small tree: two readable files under `visible/`, one under `blocked/`.
fn build_guard_tree(base: &Path) -> std::path::PathBuf {
    let root = base.join("library");
    let visible = root.join("visible");
    let blocked = root.join("blocked");
    std::fs::create_dir_all(&visible).expect("mkdir visible");
    std::fs::create_dir_all(&blocked).expect("mkdir blocked");
    let page = scanner_fixture::cover_jpeg(200, 300);
    scanner_fixture::build_cbz(
        &visible.join("a.cbz"),
        "<ComicInfo><Title>A</Title></ComicInfo>",
        std::slice::from_ref(&page),
    )
    .expect("cbz a");
    scanner_fixture::build_cbz(
        &visible.join("b.cbz"),
        "<ComicInfo><Title>B</Title></ComicInfo>",
        std::slice::from_ref(&page),
    )
    .expect("cbz b");
    scanner_fixture::build_cbz(
        &blocked.join("c.cbz"),
        "<ComicInfo><Title>C</Title></ComicInfo>",
        std::slice::from_ref(&page),
    )
    .expect("cbz c");
    // Backdate: files younger than 5 s trip processFile's recently-modified
    // skip (a download-concurrency guard), which would make the row counts
    // here nondeterministic.
    let base_ms = 1_700_000_000_000_i64;
    for (i, p) in [
        visible.join("a.cbz"),
        visible.join("b.cbz"),
        blocked.join("c.cbz"),
    ]
    .iter()
    .enumerate()
    {
        scanner_fixture::set_mtime(p, base_ms + (i as i64) * 60_000);
    }
    root
}

fn scan_input(root: &Path, thumbs: &Path) -> Value {
    json!({
        "libraryRoot": root.to_string_lossy(),
        "thumbnailDir": thumbs.to_string_lossy(),
        "noPdftoppm": true,
    })
}

#[test]
fn sc02_guard1_unreadable_directory() {
    init();
    let base = std::env::temp_dir().join(format!("removal-g1-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).expect("mkdir");
    let root = build_guard_tree(&base);

    // Guard 1: the blocked/ directory becomes unreadable mid-tree.
    let blocked = root.join("blocked");
    let mut perm = std::fs::metadata(&blocked).expect("stat").permissions();
    use std::os::unix::fs::PermissionsExt;
    perm.set_mode(0o000);
    std::fs::set_permissions(&blocked, perm).expect("chmod 000");

    let js_dir = empty_scratch("g1-js");
    let rs_dir = empty_scratch("g1-rs");
    common::js_repo_op("execSql", &json!({ "statements": [] }), &js_dir).expect("JS init");
    init_db(&rs_dir);
    let thumbs_js = base.join("thumbs-js");
    let thumbs_rs = base.join("thumbs-rs");
    std::fs::create_dir_all(&thumbs_js).ok();
    std::fs::create_dir_all(&thumbs_rs).ok();

    let input = scan_input(&root, &thumbs_js);
    let js = js_scan(&input, &js_dir).expect("JS scan");
    let rs = rust_scan(&rs_dir, &root, &thumbs_rs);

    std::fs::set_permissions(
        &blocked,
        {
            let mut p = std::fs::metadata(&blocked).expect("stat").permissions();
            p.set_mode(0o755);
            p
        },
    )
    .expect("chmod back");

    let js_reason = js["result"]["removalSkippedReason"]
        .as_str()
        .expect("guard 1 must trip on the JS side");
    assert_eq!(
        normalize_numbers(&rs),
        normalize_numbers(&js["result"]),
        "guard 1 result diverged"
    );
    assert!(rs["removalSkippedReason"].is_string(), "guard 1 must trip on the Rust side");
    assert!(
        js_reason.contains("could not be read"),
        "reason should name unreadable dirs: {js_reason}"
    );
    assert_eq!(rs["removedItems"], 0);
    assert_eq!(js["result"]["removedItems"], 0);

    // ZERO deletions: blocked/c.cbz's row (unseen this scan) must survive.
    // Two new rows (visible/a, visible/b) + the seeded ghost row below; here
    // no rows were seeded, so the scan created 2 — but the guard means the
    // pass was skipped entirely; assert via the reason + removedItems == 0.
    // (The ghost-row survival case is covered by guard 3's setup.)
    std::fs::remove_dir_all(&base).ok();
    std::fs::remove_dir_all(&js_dir).ok();
    std::fs::remove_dir_all(&rs_dir).ok();
}

#[test]
fn sc02_guard1_unseen_row_survives() {
    init();
    let base = std::env::temp_dir().join(format!("removal-g1b-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).expect("mkdir");
    let root = build_guard_tree(&base);

    // Seed a row for the file inside the soon-unreadable dir — the exact
    // scenario guard 1 exists for.
    let ghost_stat = std::fs::metadata(root.join("blocked/c.cbz")).expect("stat c");
    let stmts = vec![stmt_json(
        "INSERT INTO library_item (file_path, primary_artist, file_mtime, file_size, added_at, updated_at)
         VALUES ('blocked/c.cbz', 'artist', ?, ?, unixepoch(), unixepoch())",
        vec![
            json!(ghost_stat.modified().expect("mtime").duration_since(std::time::UNIX_EPOCH).expect("epoch").as_millis() as i64),
            json!(ghost_stat.len() as i64),
        ],
    )];
    let js_dir = empty_scratch("g1b-js");
    let rs_dir = empty_scratch("g1b-rs");
    common::js_repo_op("execSql", &json!({ "statements": [] }), &js_dir).expect("JS init");
    common::js_repo_op("execSql", &json!({ "statements": stmts }), &js_dir).expect("JS seed");
    init_db(&rs_dir);
    seed_json(&rs_dir, &stmts);

    let blocked = root.join("blocked");
    let mut perm = std::fs::metadata(&blocked).expect("stat").permissions();
    use std::os::unix::fs::PermissionsExt;
    perm.set_mode(0o000);
    std::fs::set_permissions(&blocked, perm).expect("chmod 000");

    let js_rows_before = js_row_count(&js_dir, "library_item");
    let rs_rows_before = row_count(&rs_dir, "library_item");
    assert_eq!(js_rows_before, 1);
    assert_eq!(rs_rows_before, 1);

    let thumbs_js = base.join("thumbs-js");
    let thumbs_rs = base.join("thumbs-rs");
    std::fs::create_dir_all(&thumbs_js).ok();
    std::fs::create_dir_all(&thumbs_rs).ok();

    let js = js_scan(&scan_input(&root, &thumbs_js), &js_dir).expect("JS scan");
    let rs = rust_scan(&rs_dir, &root, &thumbs_rs);

    let mut perm2 = std::fs::metadata(&blocked).expect("stat").permissions();
    perm2.set_mode(0o755);
    std::fs::set_permissions(&blocked, perm2).expect("chmod back");

    assert_eq!(js["result"]["removedItems"], 0, "zero deletions on JS side");
    assert_eq!(rs["removedItems"], 0, "zero deletions on Rust side");
    assert_eq!(normalize_numbers(&rs), normalize_numbers(&js["result"]));
    // The unseen row survived on both sides (2 visible files became new rows).
    assert_eq!(row_count(&rs_dir, "library_item"), rs_rows_before + 2);
    assert_eq!(js_row_count(&js_dir, "library_item"), js_rows_before + 2);

    std::fs::remove_dir_all(&base).ok();
    std::fs::remove_dir_all(&js_dir).ok();
    std::fs::remove_dir_all(&rs_dir).ok();
}

#[test]
fn sc02_guard2_count_collapse() {
    init();
    let base = std::env::temp_dir().join(format!("removal-g2-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).expect("mkdir");
    let root = build_guard_tree(&base);

    // The last scan saw 100 items; this scan discovers 3 — a >20% collapse
    // (vanished-mountpoint simulation via the log, per plan §11).
    let stmts = vec![stmt_json(
        "INSERT INTO library_scan_log (scanned_at, total_items, new_items, removed_items, errors_json)
         VALUES (100, 100, 0, 0, '[]')",
        vec![],
    )];
    let js_dir = empty_scratch("g2-js");
    let rs_dir = empty_scratch("g2-rs");
    common::js_repo_op("execSql", &json!({ "statements": [] }), &js_dir).expect("JS init");
    common::js_repo_op("execSql", &json!({ "statements": stmts }), &js_dir).expect("JS seed");
    init_db(&rs_dir);
    seed_json(&rs_dir, &stmts);

    let thumbs_js = base.join("thumbs-js");
    let thumbs_rs = base.join("thumbs-rs");
    std::fs::create_dir_all(&thumbs_js).ok();
    std::fs::create_dir_all(&thumbs_rs).ok();

    let js = js_scan(&scan_input(&root, &thumbs_js), &js_dir).expect("JS scan");
    let rs = rust_scan(&rs_dir, &root, &thumbs_rs);

    assert_eq!(normalize_numbers(&rs), normalize_numbers(&js["result"]));
    assert!(
        rs["removalSkippedReason"]
            .as_str()
            .expect("guard 2 must trip")
            .contains("Discovered 3 files but the last scan saw 100"),
        "reason should describe the collapse: {rs}"
    );
    assert_eq!(rs["removedItems"], 0);
    assert_eq!(js["result"]["removedItems"], 0);

    std::fs::remove_dir_all(&base).ok();
    std::fs::remove_dir_all(&js_dir).ok();
    std::fs::remove_dir_all(&rs_dir).ok();
}

#[test]
fn sc02_guard3_resolution_blowout() {
    init();
    let base = std::env::temp_dir().join(format!("removal-g3-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).expect("mkdir");
    let root = build_guard_tree(&base);

    // Three ghost rows against a 3-file tree: a removal pass would delete
    // 3 of 6 rows (50% > 20%) → guard 3 must trip.
    let stmts: Vec<Value> = (0..3)
        .map(|i| {
            stmt_json(
                &format!(
                    "INSERT INTO library_item (file_path, primary_artist, added_at, updated_at)
                     VALUES ('ghost{i}.cbz', 'artist', unixepoch(), unixepoch())"
                ),
                vec![],
            )
        })
        .collect();
    let js_dir = empty_scratch("g3-js");
    let rs_dir = empty_scratch("g3-rs");
    common::js_repo_op("execSql", &json!({ "statements": [] }), &js_dir).expect("JS init");
    common::js_repo_op("execSql", &json!({ "statements": stmts }), &js_dir).expect("JS seed");
    init_db(&rs_dir);
    let seeded: Vec<Value> = (0..3)
        .map(|i| {
            stmt_json(
                &format!(
                    "INSERT INTO library_item (file_path, primary_artist, added_at, updated_at)
                     VALUES ('ghost{i}.cbz', 'artist', unixepoch(), unixepoch())"
                ),
                vec![],
            )
        })
        .collect();
    seed_json(&rs_dir, &seeded);

    let js_rows_before = js_row_count(&js_dir, "library_item");
    let rs_rows_before = row_count(&rs_dir, "library_item");
    assert_eq!(js_rows_before, 3);
    assert_eq!(rs_rows_before, 3);

    let thumbs_js = base.join("thumbs-js");
    let thumbs_rs = base.join("thumbs-rs");
    std::fs::create_dir_all(&thumbs_js).ok();
    std::fs::create_dir_all(&thumbs_rs).ok();

    let js = js_scan(&scan_input(&root, &thumbs_js), &js_dir).expect("JS scan");
    let rs = rust_scan(&rs_dir, &root, &thumbs_rs);

    assert_eq!(normalize_numbers(&rs), normalize_numbers(&js["result"]));
    assert!(
        rs["removalSkippedReason"]
            .as_str()
            .expect("guard 3 must trip")
            .contains("would delete 3 of 6 items (over 20%)"),
        "reason should describe the blowout: {rs}"
    );
    assert_eq!(rs["removedItems"], 0);
    // Every ghost row survived.
    assert_eq!(row_count(&rs_dir, "library_item"), rs_rows_before + 3);
    assert_eq!(js_row_count(&js_dir, "library_item"), js_rows_before + 3);

    std::fs::remove_dir_all(&base).ok();
    std::fs::remove_dir_all(&js_dir).ok();
    std::fs::remove_dir_all(&rs_dir).ok();
}
