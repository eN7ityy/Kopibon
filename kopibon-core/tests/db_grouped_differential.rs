//! DB-03/DB-04/DB-05 — grouped view, series group lifecycle and startup
//! maintenance, differential against the REAL TypeScript repos
//! (repo_harness.mjs bundles library.repo.ts / series.repo.ts /
//! startup-maintenance.ts and opens a scratch copy via KOPIBON_DATA_DIR).
//!
//! The live production DB is never opened: every run works on a fresh temp
//! copy of the byte copy (10-test-plan §8 rule 2).

mod common;

use common::{init, js_repo_op, normalize_numbers, scrub_timestamps, scratch_from};
use kopibon_core::db::search::LibraryFilterParams;
use kopibon_core::metadata::mappers::FixedClock;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn production_copy() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../testdata/db/production-copy.sqlite")
}

fn leak_params(v: &Value) -> LibraryFilterParams<'static> {
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
    LibraryFilterParams {
        search_query: if search.is_empty() { None } else { Some(search) },
        artist_filters: get_arr("artistFilters"),
        series_filters: get_arr("seriesFilters"),
        tag_filters: get_arr("tagFilters"),
        show_unmatched_only: v
            .get("showUnmatchedOnly")
            .and_then(|x| x.as_bool())
            .unwrap_or(false),
    }
}

// ─── DB-03: the grouped view on the real library ────────────────────────────

#[test]
fn db03_find_paginated_grouped_parity() {
    init();
    let scratch = scratch_from(&production_copy(), "grouped");
    let db = kopibon_core::db::Db::open(&scratch.join("db.sqlite")).expect("open");

    let cases: Vec<(Value, usize, usize, &str)> = vec![
        (json!({}), 0, 15, "added"),
        (json!({}), 15, 15, "added"),
        (json!({}), 0, 15, "title"),
        (json!({}), 0, 15, "artist"),
        // Search: the series branch's FILTER clauses and the item branch must
        // agree with the flat view about what matched.
        (json!({"searchQuery": "maid"}), 0, 20, "added"),
        (json!({"searchQuery": "a"}), 0, 20, "artist"),
        (json!({"searchQuery": "50%"}), 0, 20, "title"),
        (json!({"tagFilters": ["maid"]}), 0, 20, "added"),
        (json!({"showUnmatchedOnly": true}), 0, 20, "added"),
        (json!({"searchQuery": "の"}), 0, 20, "added"),
        // minMembers override: groups of >= 3 only.
        (json!({}), 0, 15, "added"),
    ];

    for (i, (params, offset, limit, sort)) in cases.iter().enumerate() {
        let min_members = if i == cases.len() - 1 { Some(3) } else { None };
        let input = json!({
            "params": params,
            "offset": offset,
            "limit": limit,
            "sortField": sort,
            "minMembers": min_members,
        });
        let js = js_repo_op("findPaginatedGrouped", &input, &scratch)
            .unwrap_or_else(|e| panic!("JS findPaginatedGrouped case {i}: {e}"));

        let p = leak_params(params);
        let (rows, total, galleries) = kopibon_core::db::library::find_paginated_grouped(
            &db, &p, *offset, *limit, Some(sort), min_members,
        )
        .expect("rust find_paginated_grouped");

        let rs = json!({
            "rows": rows,
            "total": total,
            "galleries": galleries,
        });
        assert_eq!(
            normalize_numbers(&rs),
            normalize_numbers(&js),
            "findPaginatedGrouped diverged on case {i}: {input}"
        );
    }
    std::fs::remove_dir_all(&scratch).ok();
}

#[test]
fn db03_series_facts_and_matching_members_parity() {
    init();
    let scratch = scratch_from(&production_copy(), "facts");

    // Candidate series: the biggest groups, plus whatever has typed gallery
    // tags, plus a mid-sized one — queried from the copy, not hardcoded.
    let conn = rusqlite::Connection::open_with_flags(
        scratch.join("db.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("open read-only");
    let ids: Vec<i64> = {
        let mut stmt = conn
            .prepare(
                "SELECT series_id FROM library_item WHERE series_id IS NOT NULL
                 GROUP BY series_id ORDER BY COUNT(*) DESC LIMIT 6",
            )
            .expect("prepare");
        stmt.query_map([], |r| r.get(0))
            .expect("query")
            .filter_map(|r| r.ok())
            .collect()
    };
    drop(conn);
    assert!(!ids.is_empty(), "production copy must hold linked series");

    for series_id in ids {
        for params in [
            json!({}),
            json!({"searchQuery": "a"}),
            json!({"tagFilters": ["maid"]}),
        ] {
            let input = json!({ "seriesId": series_id, "params": params });
            let js = js_repo_op("seriesFacts", &input, &scratch)
                .unwrap_or_else(|e| panic!("JS seriesFacts({series_id}, {params}): {e}"));
            let rs = kopibon_core::db::library::series_facts(
                &kopibon_core_db(&scratch),
                series_id,
                &leak_params(&params),
            )
            .expect("rust series_facts");
            assert_eq!(
                normalize_numbers(&Value::from(rs)),
                normalize_numbers(&js),
                "seriesFacts diverged: series {series_id} params {params}"
            );
        }

        let input = json!({ "seriesId": series_id, "params": {"searchQuery": "a"} });
        let js = js_repo_op("matchingMemberIds", &input, &scratch).expect("JS matching");
        let rs = kopibon_core::db::library::matching_member_ids(
            &kopibon_core_db(&scratch),
            series_id,
            &leak_params(&json!({"searchQuery": "a"})),
        )
        .expect("rust matching_member_ids");
        assert_eq!(
            Value::from(rs),
            js,
            "matchingMemberIds diverged: series {series_id}"
        );
    }
    std::fs::remove_dir_all(&scratch).ok();
}

fn kopibon_core_db(scratch: &Path) -> kopibon_core::db::Db {
    kopibon_core::db::Db::open(&scratch.join("db.sqlite")).expect("open rust db")
}

// ─── DB-04: the group lifecycle (backfillAll / resolveFor) ──────────────────

/// A synthetic library exercising every branch of the group lifecycle:
/// case-variant spellings, ungroupable names, a dissolved group, a manual
/// group, fractional indexes, already-linked and already-wrong links.
fn build_lifecycle_fixture(path: &Path) {
    let db = kopibon_core::db::Db::open(path).expect("create fixture");
    db.with_writer(|c| {
        for (i, (name, index)) in [
            (Some("Dolls"), Some(1.0)),
            (Some("dolls"), Some(2.0)),
            (Some("DOLLS"), None),
            (Some("Unknown"), None),
            (Some(""), None),
            (Some("  "), None),
            (None, None),
            (Some("Singleton"), None),
            (Some("Solvol"), Some(1.0)),
            (Some("Solvol"), Some(2.5)),
            (Some("Solvol"), Some(10.0)),
            (Some("Dissolved Saga"), Some(1.0)),
            (Some("Dissolved Saga"), Some(2.0)),
            (Some("Manual Saga"), Some(1.0)),
            (Some("Manual Saga"), Some(2.0)),
            (Some("Handmade"), Some(3.0)),
        ]
        .into_iter()
        .enumerate()
        {
            c.execute(
                "INSERT INTO library_item
                   (file_path, primary_artist, series_name, series_index, added_at, updated_at)
                 VALUES (?, 'artist', ?, ?, unixepoch(), unixepoch())",
                rusqlite::params![format!("/lib/item{i}.cbz"), name, index],
            )
            .map_err(|e| e.to_string())?;
        }
        // The dissolved + manual groups.
        c.execute(
            "INSERT INTO series (name, is_dissolved, created_at, updated_at) VALUES ('Dissolved Saga', 1, unixepoch(), unixepoch())",
            [],
        )
        .map_err(|e| e.to_string())?;
        c.execute(
            "INSERT INTO series (name, is_manual, created_at, updated_at) VALUES ('Manual Saga', 1, unixepoch(), unixepoch())",
            [],
        )
        .map_err(|e| e.to_string())?;
        // 'Handmade' item is already linked to a (wrong) group.
        c.execute(
            "INSERT INTO series (name, created_at, updated_at) VALUES ('Wrong', unixepoch(), unixepoch())",
            [],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .expect("seed fixture");
    let db2 = kopibon_core::db::Db::open(path).expect("reopen");
    db2.with_writer(|c| {
        let wrong: i64 = c
            .query_row("SELECT id FROM series WHERE name = 'Wrong'", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let handmade: i64 = c
            .query_row(
                "SELECT id FROM library_item WHERE series_name = 'Handmade'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        c.execute("UPDATE library_item SET series_id = ? WHERE id = ?", rusqlite::params![wrong, handmade])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .expect("wrong link");
}

#[test]
fn db04_backfill_and_resolve_differential() {
    init();
    let fixture = std::env::temp_dir().join(format!("lifecycle-fixture-{}.sqlite", std::process::id()));
    let _ = std::fs::remove_file(&fixture);
    build_lifecycle_fixture(&fixture);

    // backfillAll — JS on one copy, Rust on another.
    let js_dir = scratch_from(&fixture, "backfill-js");
    let js = js_repo_op("backfillAll", &json!({ "now": 1700000000000_i64 }), &js_dir)
        .expect("JS backfillAll");

    let rs_dir = scratch_from(&fixture, "backfill-rs");
    let now_s = 1700000000;
    let linked = {
        let mut conn = rusqlite::Connection::open(rs_dir.join("db.sqlite")).expect("open rust");
        kopibon_core::db::series::backfill_all(&mut conn, now_s).expect("rust backfill_all")
    };
    let rs = json!({
        "names": linked.names,
        "linked": linked.linked,
        "cleared": linked.cleared,
        "visibleGroups": linked.visible_groups,
    });

    // names: set equality (DISTINCT has no ORDER BY — plan order may differ);
    // counts: exact.
    let js_names = js["names"].as_array().expect("names");
    let mut js_sorted: Vec<String> = js_names
        .iter()
        .map(|v| v.as_str().unwrap_or_default().to_string())
        .collect();
    js_sorted.sort();
    let mut rs_sorted = linked.names.clone();
    rs_sorted.sort();
    assert_eq!(rs_sorted, js_sorted, "backfillAll names diverged");
    assert_eq!(rs["linked"], js["linked"], "backfillAll linked diverged");
    assert_eq!(rs["cleared"], js["cleared"], "backfillAll cleared diverged");
    assert_eq!(
        rs["visibleGroups"], js["visibleGroups"],
        "backfillAll visibleGroups diverged"
    );

    // Resulting linkage + series rows must agree row-for-row (timestamps
    // scrubbed: 1.x writes ms, the port seconds).
    let js_dump = js_repo_op(
        "dumpTables",
        &json!({ "tables": ["series", "library_item"] }),
        &js_dir,
    )
    .expect("JS dump");
    let rs_dump = dump_rust(&rs_dir, &["series", "library_item"]);
    assert_eq!(
        normalize_numbers(&scrubbed(&rs_dump)),
        normalize_numbers(&scrubbed(&js_dump)),
        "post-backfill state diverged"
    );

    // resolveFor — a pass over two Dolls members + the ''-named one.
    let ids: Vec<i64> = {
        let conn = rusqlite::Connection::open(rs_dir.join("db.sqlite")).expect("open");
        let mut stmt = conn.prepare("SELECT id FROM library_item ORDER BY id LIMIT 3").expect("q");
        stmt.query_map([], |r| r.get(0)).expect("map").filter_map(|r| r.ok()).collect()
    };
    let js_dir2 = scratch_from(&fixture, "resolve-js");
    // Bring the JS copy to the same post-backfill state first.
    js_repo_op("backfillAll", &json!({ "now": 1700000000000_i64 }), &js_dir2).expect("JS backfill 2");
    let resolve_ids = json!({ "itemIds": ids });
    let js_r = js_repo_op("resolveFor", &resolve_ids, &js_dir2).expect("JS resolveFor");
    let names_sorted_js = {
        let mut v: Vec<String> = js_r["names"]
            .as_array()
            .expect("names")
            .iter()
            .map(|x| x.as_str().unwrap_or_default().to_string())
            .collect();
        v.sort();
        v
    };
    let rs_r = {
        let mut conn = rusqlite::Connection::open(rs_dir.join("db.sqlite")).expect("open");
        // The Rust copy is already post-backfill, matching the JS copy.
        kopibon_core::db::series::resolve_for(&mut conn, &ids, now_s).expect("rust resolve_for")
    };
    let mut names_sorted_rs = rs_r.names.clone();
    names_sorted_rs.sort();
    assert_eq!(names_sorted_rs, names_sorted_js, "resolveFor names diverged");
    assert_eq!(Value::from(rs_r.linked), js_r["linked"], "resolveFor linked diverged");
    assert_eq!(Value::from(rs_r.cleared), js_r["cleared"], "resolveFor cleared diverged");
    assert_eq!(
        Value::from(rs_r.visible_groups),
        js_r["visibleGroups"],
        "resolveFor visibleGroups diverged"
    );

    std::fs::remove_dir_all(&js_dir).ok();
    std::fs::remove_dir_all(&rs_dir).ok();
    std::fs::remove_dir_all(&js_dir2).ok();
    std::fs::remove_file(&fixture).ok();
}

fn dump_rust(scratch: &Path, tables: &[&str]) -> Value {
    let conn = rusqlite::Connection::open(scratch.join("db.sqlite")).expect("open rust dump");
    let mut out = serde_json::Map::new();
    for t in tables {
        let mut stmt = conn
            .prepare(&format!("SELECT * FROM {t} ORDER BY rowid"))
            .expect("prepare dump");
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
            .expect("query dump");
        let list: Vec<Value> = rows.filter_map(|r| r.ok()).collect();
        out.insert((*t).to_string(), Value::from(list));
    }
    Value::Object(out)
}

fn scrubbed(v: &Value) -> Value {
    let mut v = v.clone();
    scrub_timestamps(
        &mut v,
        &[
            "created_at",
            "updated_at",
            "added_at",
            "completed_at",
            "started_at",
            "enqueued_at",
        ],
    );
    v
}

// ─── DB-05: the startup maintenance sweep ───────────────────────────────────

/// Debris in every swept table, in the documented states
/// (startup-maintenance.ts:9-25, :70-91).
fn build_maintenance_fixture(path: &Path, series_grouping: &str) {
    let db = kopibon_core::db::Db::open(path).expect("create fixture");
    let now = 1700000000000_i64;
    db.with_writer(|c| {
        // download_page debris (wiped outright).
        for i in 0..3 {
            c.execute(
                "INSERT INTO download_page (queue_id, page_number, url, status) VALUES (?, ?, ?, 'pending')",
                rusqlite::params![i + 1, i, format!("https://x/{i}.jpg")],
            )
            .map_err(|e| e.to_string())?;
        }
        // scan_queue debris incl. a stuck 'failed' (wiped outright).
        c.execute(
            "INSERT INTO scan_queue (file_path, status) VALUES ('/lib/a.pdf', 'failed')",
            [],
        )
        .map_err(|e| e.to_string())?;
        c.execute(
            "INSERT INTO scan_queue (file_path, status) VALUES ('/lib/b.pdf', 'scanning')",
            [],
        )
        .map_err(|e| e.to_string())?;

        // conversion_queue: only 'converting' resets; completed/failed are history.
        for (fp, status) in [
            ("/lib/c1.pdf", "converting"),
            ("/lib/c2.pdf", "completed"),
            ("/lib/c3.pdf", "failed"),
            ("/lib/c4.pdf", "pending"),
        ] {
            c.execute(
                "INSERT INTO conversion_queue (file_path, status) VALUES (?, ?)",
                rusqlite::params![fp, status],
            )
            .map_err(|e| e.to_string())?;
        }

        // download_queue: completed rows pruned, queued/failed kept as user
        // intent. completed_at: fresh, old, NULL — the retention branches.
        for (i, (status, completed_at)) in [
            ("completed", Some(now - 86_400_000)),
            ("completed", Some(now - 40 * 86_400_000)),
            ("completed", None),
            ("queued", None),
            ("failed", None),
        ]
        .into_iter()
        .enumerate()
        {
            c.execute(
                "INSERT INTO download_queue (gallery_id, status, completed_at) VALUES (?, ?, ?)",
                rusqlite::params![1000 + i as i64, status, completed_at],
            )
            .map_err(|e| e.to_string())?;
        }

        // Orphaned artist row (library_item_id 9999 does not exist).
        c.execute(
            "INSERT INTO library_item_artist (library_item_id, artist_name) VALUES (9999, 'ghost')",
            [],
        )
        .map_err(|e| e.to_string())?;

        // sync_queue: 'syncing' requeues; pending/completed untouched.
        c.execute(
            "INSERT INTO library_item (file_path, primary_artist, added_at, updated_at) VALUES ('/lib/s1.cbz', 'a', unixepoch(), unixepoch())",
            [],
        )
        .map_err(|e| e.to_string())?;
        c.execute(
            "INSERT INTO sync_queue (library_item_id, status, started_at) VALUES ((SELECT MAX(id) FROM library_item), 'syncing', 100)",
            [],
        )
        .map_err(|e| e.to_string())?;

        // Series relink material: three items sharing a name, none linked.
        for i in 0..3 {
            c.execute(
                "INSERT INTO library_item (file_path, primary_artist, series_name, added_at, updated_at) VALUES (?, 'a', 'Relink Saga', unixepoch(), unixepoch())",
                rusqlite::params![format!("/lib/r{i}.cbz")],
            )
            .map_err(|e| e.to_string())?;
        }

        c.execute(
            "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('seriesGrouping', ?, 1)",
            rusqlite::params![series_grouping],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .expect("seed maintenance fixture");
}

fn run_maintenance_case(series_grouping: &str, retention: Option<u32>) {
    let fixture = std::env::temp_dir().join(format!(
        "maintenance-fixture-{}-{series_grouping}-{}.sqlite",
        std::process::id(),
        retention.unwrap_or_default()
    ));
    let _ = std::fs::remove_file(&fixture);
    build_maintenance_fixture(&fixture, series_grouping);

    let now = 1700000000000_i64;
    let js_dir = scratch_from(&fixture, "maint-js");
    let js = js_repo_op(
        "runStartupMaintenance",
        &json!({ "now": now, "completedRetentionDays": retention }),
        &js_dir,
    )
    .expect("JS runStartupMaintenance");

    let rs_dir = scratch_from(&fixture, "maint-rs");
    let rs = {
        let mut conn = rusqlite::Connection::open(rs_dir.join("db.sqlite")).expect("open rust");
        let r = kopibon_core::db::maintenance::run_startup_maintenance(
            &mut conn,
            &FixedClock(now),
            retention.unwrap_or(0),
        );
        json!({
            "downloadPagesCleared": r.download_pages_cleared,
            "scanQueueCleared": r.scan_queue_cleared,
            "completedDownloadsPruned": r.completed_downloads_pruned,
            "orphanedArtistsRemoved": r.orphaned_artists_removed,
            "seriesLinked": r.series_linked,
            "syncRequeued": r.sync_requeued,
        })
    };
    assert_eq!(rs, js, "maintenance counters diverged ({series_grouping}, {retention:?})");

    // Row-level state after the sweep, both engines.
    let tables = [
        "download_page",
        "scan_queue",
        "conversion_queue",
        "download_queue",
        "library_item_artist",
        "sync_queue",
        "series",
        "library_item",
    ];
    let js_dump = js_repo_op("dumpTables", &json!({ "tables": tables }), &js_dir).expect("JS dump");
    let rs_dump = dump_rust(&rs_dir, &tables);
    assert_eq!(
        normalize_numbers(&scrubbed(&rs_dump)),
        normalize_numbers(&scrubbed(&js_dump)),
        "post-maintenance state diverged ({series_grouping}, {retention:?})"
    );

    std::fs::remove_dir_all(&js_dir).ok();
    std::fs::remove_dir_all(&rs_dir).ok();
    std::fs::remove_file(&fixture).ok();
}

#[test]
fn db05_startup_maintenance_sweep() {
    init();
    // Grouping on: relink runs.
    run_maintenance_case("true", None);
    // Grouping off: seriesLinked stays 0, linkage untouched.
    run_maintenance_case("false", None);
    // Retention window: only completed rows older than 30 days go.
    run_maintenance_case("false", Some(30));
}
