//! CR-01 — simulated crash recovery across all four queues (10-test-plan §6):
//! a hard kill mid-batch leaves each queue in a documented interrupted state;
//! the boot sequence (startup maintenance + download reconcile, in the
//! 03-data-model §10.7 order) must recover, and a SECOND pass must be
//! idempotent. Runs under `--test-threads=1`.

mod common;

use kopibon_core::metadata::mappers::FixedClock;
use serde_json::{json, Value};
use std::path::PathBuf;

struct Env {
    dir: PathBuf,
    conn: rusqlite::Connection,
    data_dir: PathBuf,
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn env(name: &str) -> Env {
    let dir = std::env::temp_dir().join(format!("cr-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("mkdir");
    let db = kopibon_core::db::Db::open(&dir.join("db.sqlite")).expect("db");
    drop(db);
    let conn = rusqlite::Connection::open(dir.join("db.sqlite")).expect("conn");
    let data_dir = dir.join("data");
    std::fs::create_dir_all(&data_dir).expect("data");
    Env {
        dir,
        conn,
        data_dir,
    }
}

/// The reboot sequence, in the documented order (index.ts:189-212;
/// 03-data-model §10.7): maintenance sweep → sync requeue → download
/// reconcile (before the pump).
fn boot(env: &Env) -> kopibon_core::db::maintenance::MaintenanceResult {
    let mut conn = rusqlite::Connection::open(env.dir.join("db.sqlite")).expect("open");
    let clock = FixedClock(1_700_000_000_000);
    let maintenance =
        kopibon_core::db::maintenance::run_startup_maintenance(&mut conn, &clock, 0);
    kopibon_core::download::reconcile_interrupted(&conn, &env.data_dir).expect("reconcile");
    maintenance
}

fn counts(env: &Env) -> Value {
    let c = |sql: &str| -> i64 {
        env.conn
            .query_row(sql, [], |r| r.get(0))
            .unwrap_or(0)
    };
    json!({
        "scan_queue": c("SELECT COUNT(*) FROM scan_queue"),
        "download_queued": c("SELECT COUNT(*) FROM download_queue WHERE status = 'queued'"),
        "download_downloading": c("SELECT COUNT(*) FROM download_queue WHERE status = 'downloading'"),
        "download_converting": c("SELECT COUNT(*) FROM download_queue WHERE status = 'converting'"),
        "download_completed": c("SELECT COUNT(*) FROM download_queue WHERE status = 'completed'"),
        "download_failed": c("SELECT COUNT(*) FROM download_queue WHERE status = 'failed'"),
        "download_pages": c("SELECT COUNT(*) FROM download_page"),
        "conversion_pending": c("SELECT COUNT(*) FROM conversion_queue WHERE status = 'pending'"),
        "conversion_converting": c("SELECT COUNT(*) FROM conversion_queue WHERE status = 'converting'"),
        "conversion_completed": c("SELECT COUNT(*) FROM conversion_queue WHERE status = 'completed'"),
        "conversion_failed": c("SELECT COUNT(*) FROM conversion_queue WHERE status = 'failed'"),
        "sync_pending": c("SELECT COUNT(*) FROM sync_queue WHERE status = 'pending'"),
        "sync_syncing": c("SELECT COUNT(*) FROM sync_queue WHERE status = 'syncing'"),
        "orphan_artists": c("SELECT COUNT(*) FROM library_item_artist WHERE library_item_id NOT IN (SELECT id FROM library_item)"),
    })
}

/// Seed every queue with its crash-state debris.
fn seed_crash_state(env: &Env) {
    let conn = &env.conn;
    // scan_queue: mid-scan debris incl. a stuck 'failed' row (wiped at boot).
    conn.execute("INSERT INTO scan_queue (file_path, status) VALUES ('/lib/a.pdf', 'scanning')", []).unwrap();
    conn.execute("INSERT INTO scan_queue (file_path, status) VALUES ('/lib/b.pdf', 'failed')", []).unwrap();

    // download_queue: one mid-download (with page rows + scratch), one
    // mid-conversion (with page rows), one user-intent queued row.
    for (gid, status) in [(1, "downloading"), (2, "converting"), (3, "queued")] {
        conn.execute(
            "INSERT INTO download_queue (gallery_id, status) VALUES (?, ?)",
            rusqlite::params![gid, status],
        )
        .unwrap();
        let qid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO download_page (queue_id, page_number, url, status) VALUES (?, 1, 'u', 'done')",
            [qid],
        )
        .unwrap();
    }
    let scratch = env.data_dir.join("download-tmp/1");
    std::fs::create_dir_all(&scratch).unwrap();
    std::fs::write(scratch.join("0001.jpg"), b"debris").unwrap();

    // conversion_queue: mid-crash 'converting' (resets) + history (kept).
    conn.execute("INSERT INTO conversion_queue (file_path, status) VALUES ('/lib/x.pdf', 'converting')", []).unwrap();
    conn.execute("INSERT INTO conversion_queue (file_path, status) VALUES ('/lib/y.pdf', 'completed')", []).unwrap();
    conn.execute("INSERT INTO conversion_queue (file_path, status) VALUES ('/lib/z.pdf', 'failed')", []).unwrap();

    // sync_queue: a stranded 'syncing' row (requeued at boot).
    conn.execute(
        "INSERT INTO library_item (file_path, primary_artist, added_at, updated_at) VALUES ('/lib/s.cbz', 'a', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO sync_queue (library_item_id, status, started_at) VALUES ((SELECT MAX(id) FROM library_item), 'syncing', 100)",
        [],
    )
    .unwrap();

    // An orphaned artist row (swept by the boot transaction).
    conn.execute(
        "INSERT INTO library_item_artist (library_item_id, artist_name) VALUES (424242, 'ghost')",
        [],
    )
    .unwrap();
}

#[test]
fn cr01_all_four_queues_recover_and_idempotent() {
    common::init();
    let mut env = env("all");

    seed_crash_state(&env);
    let before = counts(&env);

    // ── Pass 1: the reboot sequence ────────────────────────────────────────
    let maintenance = boot(&env);

    let after = counts(&env);

    // scan_queue: wiped outright (also un-sticks 'failed').
    assert_eq!(before["scan_queue"], 2);
    assert_eq!(after["scan_queue"], 0, "scan_queue wiped at boot");
    assert_eq!(maintenance.scan_queue_cleared, 2);
    // The maintenance transaction wipes the WHOLE download_page table (its
    // documented boot behaviour); the download reconcile then finds none.
    assert_eq!(maintenance.download_pages_cleared, 3);

    // download_queue: interrupted rows → queued, page rows wiped, scratch
    // purged; queued/completed rows untouched.
    assert_eq!(after["download_queued"], 3, "downloading+converting requeued");
    assert_eq!(after["download_downloading"], 0);
    assert_eq!(after["download_converting"], 0);
    assert_eq!(after["download_pages"], 0, "page rows are re-created per attempt");
    assert!(!env.data_dir.join("download-tmp/1").exists(), "scratch purged");

    // conversion_queue: 'converting' → 'pending' ONLY; history untouched.
    assert_eq!(after["conversion_pending"], 1);
    assert_eq!(after["conversion_converting"], 0);
    assert_eq!(after["conversion_completed"], 1, "completed rows are history");
    assert_eq!(after["conversion_failed"], 1, "failed rows are history");

    // sync_queue: 'syncing' → 'pending', started_at NULL.
    assert_eq!(after["sync_pending"], 1);
    assert_eq!(after["sync_syncing"], 0);
    let started: Option<i64> = env
        .conn
        .query_row("SELECT started_at FROM sync_queue", [], |r| r.get(0))
        .unwrap();
    assert_eq!(started, None);

    // Orphaned artists swept.
    assert_eq!(after["orphan_artists"], 0);

    // ── Pass 2: idempotent — a second boot changes nothing ─────────────────
    let maintenance2 = boot(&env);
    let after2 = counts(&env);
    assert_eq!(after, after2, "the second boot is a no-op");
    assert_eq!(maintenance2.scan_queue_cleared, 0);
    assert_eq!(maintenance2.download_pages_cleared, 0);
    assert_eq!(maintenance2.orphaned_artists_removed, 0);
    assert_eq!(maintenance2.sync_requeued, 0);

    // The recovered rows are claimable on each engine.
    let claimed = kopibon_core::conversion::claim_next(&mut env.conn).unwrap();
    assert!(claimed.is_some(), "the recovered conversion row is claimable");
    let sync = kopibon_core::db::sync::claim_next(&mut env.conn).unwrap();
    assert!(sync.is_some(), "the requeued sync row is claimable");
    let download = kopibon_core::download::dequeue_next(&env.conn, &FixedClock(1_700_000_000_000)).unwrap();
    assert!(download.is_some(), "the requeued download is claimable");

    // ── "Run twice in a row" (CR-01): a SECOND crash + boot also recovers ──
    // Simulate crashing again mid-claim on all three engines, then reboot.
    env.conn
        .execute("UPDATE conversion_queue SET status = 'converting' WHERE status = 'pending'", [])
        .unwrap();
    env.conn
        .execute("UPDATE sync_queue SET status = 'syncing' WHERE status = 'pending'", [])
        .unwrap();
    env.conn
        .execute("UPDATE download_queue SET status = 'downloading' WHERE status = 'queued'", [])
        .unwrap();
    let _boot3 = boot(&env);
    let after3 = counts(&env);
    assert_eq!(after3["conversion_pending"], 1, "second crash also recovered");
    assert_eq!(after3["sync_pending"], 1);
    assert_eq!(after3["download_queued"], 3);
    assert_eq!(after3["download_pages"], 0);
    assert_eq!(after3["scan_queue"], 0);
}
