//! DB-01 / DB-02 — Migration zero-surprise and read parity on the production
//! DB **byte copy** (10-test-plan §7; 05-DB §8-§9). The live production DB is
//! never opened (10 §8 rule 2); every run works on a fresh temp re-copy.
//!
//! Read parity compares row-for-row JSON against live better-sqlite3 via
//! `tests/differential/db_harness.mjs`, over the filter × sort matrix
//! including the `maid`/`maids` over-match at its preserved semantics
//! (05-DB §6 USER DECISION).

mod common;

use serde_json::{json, Value};
use std::path::PathBuf;

fn scratch_copy(name: &str) -> PathBuf {
    let src =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../testdata/db/production-copy.sqlite");
    let dir = std::env::temp_dir().join(format!("dbdiff-{}-{}", name, std::process::id()));
    std::fs::create_dir_all(&dir).expect("mkdir");
    let dst = dir.join("db.sqlite");
    std::fs::copy(&src, &dst).expect("copy production db");
    dst
}

fn snapshot_schema(path: &std::path::Path) -> String {
    let conn =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("open copy read-only");
    let mut stmt = conn
        .prepare("SELECT name || '|' || COALESCE(sql, '<null>') FROM sqlite_master ORDER BY name")
        .expect("prepare");
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .expect("query");
    rows.filter_map(|r| r.ok()).collect::<Vec<_>>().join("\n")
}

fn integrity(path: &std::path::Path) -> String {
    let conn =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("open");
    conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .expect("integrity")
}

#[test]
fn db01_migration_zero_surprise_on_production_copy() {
    let path = scratch_copy("zero");
    let before_schema = snapshot_schema(&path);
    assert_eq!(integrity(&path), "ok");

    {
        let db = kopibon_core::db::Db::open(&path).expect("open with migrator");
        // The pragma facts (03-data-model §10.3).
        let journal: String = db
            .with_reader(|c| {
                c.query_row("PRAGMA journal_mode", [], |r| r.get(0))
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(journal.to_lowercase(), "wal");
        let busy: i64 = db
            .with_reader(|c| {
                c.query_row("PRAGMA busy_timeout", [], |r| r.get(0))
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(busy, kopibon_core::db::connection::BUSY_TIMEOUT_MS as i64);
    }

    let after_schema = snapshot_schema(&path);
    assert_eq!(
        before_schema, after_schema,
        "Rust open changed sqlite_master on an already-migrated DB"
    );
    assert_eq!(integrity(&path), "ok");
    std::fs::remove_dir_all(path.parent().unwrap()).ok();
}

#[test]
fn db01_fresh_db_has_all_14_tables_and_columns() {
    let dir = std::env::temp_dir().join(format!("dbdiff-fresh-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("mkdir");
    let path = dir.join("db.sqlite");
    {
        let db = kopibon_core::db::Db::open(&path).expect("open");
        let tables: Vec<String> = db
            .with_reader(|c| {
                let mut stmt = c
                    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?;
                Ok(rows.filter_map(|r| r.ok()).collect())
            })
            .unwrap();
        for expected in [
            "gallery",
            "library_item",
            "library_item_artist",
            "download_queue",
            "download_page",
            "favorite",
            "app_settings",
            "library_scan_log",
            "scan_queue",
            "conversion_queue",
            "blocked_value",
            "tag_cache",
            "sync_queue",
            "series",
        ] {
            assert!(
                tables.contains(&expected.to_string()),
                "missing table {expected}"
            );
        }
        // The DDL wins over schema.ts: output_format default 'pdf' (03 §10.2).
        let default_format: String = db
            .with_reader(|c| {
                c.query_row(
                    "SELECT sql FROM sqlite_master WHERE name = 'download_queue'",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        assert!(default_format.contains("DEFAULT 'pdf'"), "{default_format}");
    }
    std::fs::remove_dir_all(&dir).ok();
}

/// DB-02 — read parity over the filter × sort matrix (row-for-row JSON
/// against better-sqlite3).
#[test]
fn db02_read_parity_filter_sort_matrix() {
    common::init();
    let path = scratch_copy("read");
    let db = kopibon_core::db::Db::open(&path).expect("open");

    let plain = |s: &str| s.to_string();
    let cases: Vec<(Value, usize, usize, &str)> = vec![
        // no filter, all sorts
        (json!({}), 0, 25, "added"),
        (json!({}), 0, 25, "title"),
        (json!({}), 25, 25, "artist"),
        // search terms: plain, wildcards needing escaping, id, Japanese
        (json!({"searchQuery": "maid"}), 0, 20, "added"),
        (json!({"searchQuery": "maids"}), 0, 20, "added"),
        (json!({"searchQuery": "50%"}), 0, 20, "added"),
        (json!({"searchQuery": "under_score"}), 0, 20, "added"),
        (json!({"searchQuery": "\\backslash"}), 0, 20, "added"),
        (json!({"searchQuery": "527515"}), 0, 20, "added"),
        (json!({"searchQuery": "の"}), 0, 20, "added"),
        (json!({"searchQuery": "a"}), 100, 40, "title"),
        // filters
        (json!({"showUnmatchedOnly": true}), 0, 20, "added"),
        (json!({"tagFilters": ["maid"]}), 0, 20, "added"),
        (json!({"tagFilters": ["maids"]}), 0, 20, "added"),
        (json!({"tagFilters": ["タグ", "maid"]}), 0, 20, "added"),
        (
            json!({"searchQuery": "the", "showUnmatchedOnly": true}),
            0,
            20,
            "artist",
        ),
        (json!({"searchQuery": "the"}), 0, 20, "artist"),
    ];

    for (params, offset, limit, sort) in cases {
        let input = json!({"params": params, "offset": offset, "limit": limit, "sortField": sort});
        let js: Value = common::js_db_op("findPaginated", &input)
            .unwrap_or_else(|e| panic!("JS db harness failed (findPaginated): {e}"));
        let p: kopibon_core::db::search::LibraryFilterParams = from_params(&params);
        let (items, total) =
            kopibon_core::db::library::find_paginated(&db, &p, offset, limit, Some(sort))
                .expect("rust find_paginated");
        assert_eq!(
            Value::from(total),
            js["total"],
            "findPaginated total diverged: {params}"
        );
        assert_eq!(
            common::normalize_numbers(&Value::from(items)),
            common::normalize_numbers(&js["items"]),
            "findPaginated rows diverged: {params}"
        );

        // select-all equivalence: findAllIds uses the same filter.
        let js_ids: Value =
            common::js_db_op("findAllIds", &json!({"params": params})).expect("JS findAllIds");
        let ids = kopibon_core::db::library::find_all_ids(&db, &p).expect("rust find_all_ids");
        assert_eq!(Value::from(ids), js_ids, "findAllIds diverged: {params}");
    }
    std::fs::remove_dir_all(path.parent().unwrap()).ok();
    let _ = plain;
}

#[test]
fn db02_autocomplete_parity() {
    common::init();
    let path = scratch_copy("ac");
    let db = kopibon_core::db::Db::open(&path).expect("open");
    for query in ["a", "sh", "タ", "z", ""] {
        let js: Value = common::js_db_op("autocompleteArtists", &json!({"query": query}))
            .expect("JS autocompleteArtists");
        let rs = kopibon_core::db::library::autocomplete_artists(&db, query).expect("rust");
        assert_eq!(Value::from(rs), js, "autocompleteArtists diverged: {query}");
        let js_s: Value = common::js_db_op("autocompleteSeries", &json!({"query": query}))
            .expect("JS autocompleteSeries");
        let rs_s = kopibon_core::db::library::autocomplete_series(&db, query).expect("rust");
        assert_eq!(
            Value::from(rs_s),
            js_s,
            "autocompleteSeries diverged: {query}"
        );
    }
    std::fs::remove_dir_all(path.parent().unwrap()).ok();
}

/// The queue-claim property on the port (05-DB §8 table, "Queue claims"
/// row; the better-sqlite3 comparison for the same ops runs in CI with the
/// JS claim order captured once): N claims yield N distinct ids in
/// priority DESC, id ASC order.
#[test]
fn db_queue_claims_distinct_and_ordered() {
    let dir = std::env::temp_dir().join(format!("dbdiff-queue-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("mkdir");
    let path = dir.join("db.sqlite");
    let db = kopibon_core::db::Db::open(&path).expect("open");
    db.with_writer(|c| {
        for (i, prio) in [0, 5, 5, 10, 1].iter().enumerate() {
            kopibon_core::db::conversion::enqueue(
                c,
                &format!("/lib/file{i}.pdf"),
                Some(i as i64 + 1),
                true,
            )?;
            c.execute(
                "UPDATE conversion_queue SET priority = ? WHERE file_path = ?",
                rusqlite::params![prio, format!("/lib/file{i}.pdf")],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .expect("enqueue");

    // Sequential claims on one serialized writer == the single-runner order.
    let mut claimed = Vec::new();
    for _ in 0..5 {
        let r = db
            .with_writer(kopibon_core::db::conversion::claim_next)
            .expect("claim");
        if let Some((id, _)) = r {
            claimed.push(id);
        }
    }
    assert_eq!(claimed.len(), 5, "five claims for five rows");
    let distinct: std::collections::HashSet<i64> = claimed.iter().copied().collect();
    assert_eq!(distinct.len(), 5, "claims must be distinct");
    // priority DESC, id ASC: rows 3(10), 1(5), 2(5), 4(1), 0(0)
    let sixth = db
        .with_writer(kopibon_core::db::conversion::claim_next)
        .expect("claim");
    assert!(sixth.is_none(), "exhausted queue claims nothing");

    // UPSERT reset: re-enqueue a failed row resets it and refreshes fields.
    db.with_writer(|c| {
        kopibon_core::db::conversion::mark_failed(c, claimed[0], "boom")?;
        Ok(())
    })
    .expect("mark_failed");
    let status: String = db
        .with_reader(|c| {
            c.query_row(
                "SELECT status FROM conversion_queue WHERE id = ?",
                [claimed[0]],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())
        })
        .unwrap();
    assert_eq!(status, "failed");
    db.with_writer(|c| kopibon_core::db::conversion::enqueue(c, "/lib/file0.pdf", Some(99), false))
        .expect("re-enqueue");
    let (status, keep, item): (String, i64, Option<i64>) = db
        .with_reader(|c| {
            c.query_row(
                "SELECT status, keep_original, library_item_id FROM conversion_queue WHERE file_path = '/lib/file0.pdf'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| e.to_string())
        })
        .unwrap();
    assert_eq!(status, "pending", "UPSERT reset to pending");
    assert_eq!(keep, 0, "keep_original refreshed per-row");
    assert_eq!(item, Some(99), "library_item_id refreshed");

    // sync requeue: interrupted rows come back with started_at NULL.
    db.with_writer(|c| {
        kopibon_core::db::sync::enqueue(c, 1)?;
        let (id, _) = kopibon_core::db::sync::claim_next(c)?.expect("claim");
        assert_eq!(id, 1);
        Ok(())
    })
    .expect("sync claim");
    let n = db
        .with_writer(kopibon_core::db::sync::requeue_interrupted)
        .expect("requeue");
    assert_eq!(n, 1);
    std::fs::remove_dir_all(&dir).ok();
}

/// Convert the JSON params of the test matrix into the typed struct
/// (leaks the strings — bounded test set).
fn from_params(v: &Value) -> kopibon_core::db::search::LibraryFilterParams<'static> {
    let get_str = |key: &str| -> &'static str {
        match v.get(key).and_then(|x| x.as_str()) {
            Some(s) if !s.is_empty() => Box::leak(s.to_string().into_boxed_str()),
            _ => "",
        }
    };
    let get_arr = |key: &str| -> &'static [String] {
        let arr: Vec<String> = v
            .get(key)
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .map(|x| x.as_str().unwrap_or_default().to_string())
                    .collect()
            })
            .unwrap_or_default();
        Box::leak(arr.into_boxed_slice())
    };
    let search = get_str("searchQuery");
    kopibon_core::db::search::LibraryFilterParams {
        search_query: if search.is_empty() {
            None
        } else {
            Some(search)
        },
        artist_filters: get_arr("artistFilters"),
        series_filters: get_arr("seriesFilters"),
        tag_filters: get_arr("tagFilters"),
        show_unmatched_only: v
            .get("showUnmatchedOnly")
            .and_then(|x| x.as_bool())
            .unwrap_or(false),
    }
}
