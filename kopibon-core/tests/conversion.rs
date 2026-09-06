//! CV-01 — conversion pipeline tests (06 §7): golden conversion through the
//! 8 ordered steps, the verify gate both ways, the count guard with the loud
//! lossy-fallback error (USER DECISION), original archiving with collisions,
//! queue semantics (stale rows, cancel), the resumable metadata job
//! (D-metadata-queue) and the originals restore/purge ordering.

#[path = "scanner_fixture.rs"]
mod scanner_fixture;

mod common;

use kopibon_core::metadata::mappers::FixedClock;
use kopibon_core::metadata::writers::comicinfo::{count_cbz_pages, read_entry};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::io::Write;

struct Env {
    dir: PathBuf,
    library_root: PathBuf,
    library_root_str: String,
    data_dir: PathBuf,
}

impl Env {
    fn library_root_str(&self) -> &str {
        &self.library_root_str
    }
    fn thumbnail_dir(&self) -> &Path {
        // accessor over the boxed path to keep lifetimes simple in tests
        Box::leak(self.data_dir.join("thumbnails").into_boxed_path())
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn env() -> (Env, rusqlite::Connection) {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "cv-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("mkdir");
    let db = kopibon_core::db::Db::open(&dir.join("db.sqlite")).expect("db");
    drop(db);
    let conn = rusqlite::Connection::open(dir.join("db.sqlite")).expect("conn");
    let library_root = dir.join("library");
    std::fs::create_dir_all(&library_root).expect("lib");
    let library_root_str = library_root.to_string_lossy().to_string();
    let data_dir = dir.join("data");
    let env = Env {
        dir,
        library_root,
        library_root_str,
        data_dir,
    };
    (env, conn)
}

fn options<'a>(e: &'a Env, keep_original: bool) -> kopibon_core::conversion::worker_cbz::ConvertOptions<'a> {
    kopibon_core::conversion::worker_cbz::ConvertOptions {
        user_data_dir: &e.data_dir,
        library_root: e.library_root_str(),
        keep_original,
        manga_direction: "YesAndRightToLeft".to_string(),
        originals_root: "",
        thumbnail_dir: Some(e.thumbnail_dir()),
    }
}

/// Seed a pdf library row + queue row; returns (queue_id, item_id).
fn seed_pdf(conn: &rusqlite::Connection, _e: &Env, rel_path: &str, keep_original: bool) -> (i64, i64) {
    conn
        .execute(
            "INSERT INTO library_item (file_path, primary_artist, format, gallery_id, custom_title, added_at, updated_at)
             VALUES (?, 'Test Artist', 'pdf', 777, 'Conv Title', unixepoch(), unixepoch())",
            rusqlite::params![rel_path],
        )
        .expect("item");
    let item_id = conn.last_insert_rowid();
    conn
        .execute(
            "INSERT INTO conversion_queue (file_path, library_item_id, keep_original, status) VALUES (?, ?, ?, 'pending')",
            rusqlite::params![rel_path, item_id, keep_original],
        )
        .expect("queue");
    (conn.last_insert_rowid(), item_id)
}

#[test]
fn cv01_golden_conversion_and_row_updates() {
    let (e, mut conn) = env();
    let jpeg = scanner_fixture::cover_jpeg(300, 420);
    let pdf_rel = "Test Artist/convert me.pdf";
    let pdf_abs = e.library_root.join(pdf_rel);
    std::fs::create_dir_all(pdf_abs.parent().unwrap()).expect("dir");
    scanner_fixture::build_image_pdf(&pdf_abs, &[jpeg.clone(), jpeg.clone(), jpeg.clone()]).expect("pdf");

    let (queue_id, item_id) = seed_pdf(&conn, &e, pdf_rel, true);
    let clock = FixedClock(1_700_000_000_000);

    // Claim, then run the worker through the pump's completion path.
    let (claimed_qid, claimed_path) = kopibon_core::conversion::claim_next(&mut conn)
        .unwrap()
        .expect("claim");
    assert_eq!(claimed_qid, queue_id);
    assert_eq!(claimed_path, pdf_rel);
    let mut item = kopibon_core::conversion::fetch_item(&conn, &claimed_path)
        .unwrap()
        .expect("item");
    item.queue_id = Some(claimed_qid);
    item.file_path = pdf_abs.to_string_lossy().to_string();

    let logs = std::sync::Mutex::new(Vec::<String>::new());
    let outcome = kopibon_core::conversion::convert_one(
        &mut conn,
        &item,
        &options(&e, true),
        &clock,
        &mut |m| logs.lock().unwrap().push(m),
    )
    .expect("conversion");

    // Output: same stem, .cbz, with all 3 pages and valid ComicInfo.
    let new_path = e.library_root.join("Test Artist/convert me.cbz");
    assert_eq!(outcome["newPath"].as_str(), Some(new_path.to_string_lossy().as_ref()));
    assert_eq!(count_cbz_pages(&new_path).unwrap(), 3);
    // ComicInfo first entry with non-empty title.
    let ci = read_entry(&new_path, "ComicInfo.xml").expect("ComicInfo");
    let ci_text = String::from_utf8_lossy(&ci);
    assert!(ci_text.contains("<Title>"), "{ci_text}");

    // Original archived under _originals/{artist}/, PDF moved (kept=true).
    let archived = e
        .library_root
        .join("_originals/Test Artist/convert me.pdf");
    assert!(archived.exists(), "original archived");
    assert!(!pdf_abs.exists(), "source moved");
    assert_eq!(
        outcome["originalPath"].as_str(),
        Some(archived.to_string_lossy().as_ref())
    );
    assert_eq!(outcome["originalKept"], json!(true));
    assert_eq!(outcome["forcedKeep"], json!(false));
    assert_eq!(outcome["lossless"], json!(true));

    // Scratch purged (step 7).
    assert!(!e.data_dir.join("convert-cbz").join(item_id.to_string()).exists());

    // Row updated: format cbz, page count counted from the file.
    let row: (String, String, Option<i64>) = conn
        .query_row(
            "SELECT file_path, format, page_count FROM library_item WHERE id = ?",
            [item_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(row.1, "cbz");
    assert_eq!(row.2, Some(3));
    let qrow = kopibon_core::db::conversion::claim_next(&mut conn).unwrap();
    assert!(qrow.is_none(), "queue drained");
    let status: String = conn
        .query_row("SELECT status FROM conversion_queue WHERE id = ?", [queue_id], |r| r.get(0))
        .unwrap();
    assert_eq!(status, "completed");
}

#[test]
fn cv01_verify_gate_and_missing_source() {
    let (e, conn) = env();
    let jpeg = scanner_fixture::cover_jpeg(300, 420);
    let pdf_rel = "Test Artist/broken.pdf";
    let pdf_abs = e.library_root.join(pdf_rel);
    std::fs::create_dir_all(pdf_abs.parent().unwrap()).unwrap();
    scanner_fixture::build_image_pdf(&pdf_abs, std::slice::from_ref(&jpeg)).unwrap();
    let (queue_id, _item) = seed_pdf(&conn, &e, pdf_rel, true);

    // Missing source (stale queue row): step 1 error names the path.
    let stale = kopibon_core::conversion::ConvertItem {
        queue_id: Some(queue_id),
        item_id: 999,
        file_path: "/nowhere/gone.pdf".to_string(),
        gallery_id: None,
        primary_artist: "A".into(),
        custom_title: None,
        custom_tags: None,
        custom_language: None,
        custom_date: None,
        series_name: None,
        series_index: None,
        publisher: None,
        language: None,
        description: None,
        upload_date: None,
        raw_tags_json: None,
    };
    let clock = FixedClock(1);
    let err = kopibon_core::conversion::worker_cbz::convert_to_cbz(
        &stale,
        &options(&e, true),
        &clock,
        &mut |_| {},
    )
    .unwrap_err();
    assert_eq!(err, "Source file not found: /nowhere/gone.pdf");

    // Verify gate: a truncated archive (page dropped) must fail.
    // Build a valid 2-page CBZ, then remove a page by rewriting.
    let cbz_path = e.dir.join("tampered.cbz");
    {
        let file = std::fs::File::create(&cbz_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
        zip.start_file("0001.jpg", opts).unwrap();
        zip.write_all(&jpeg).unwrap();
        zip.start_file("0003.jpg", opts).unwrap();
        zip.write_all(&jpeg).unwrap();
        zip.finish().unwrap();
    }
    // 2 images named 0001/0003 — sequential check fails.
    assert!(!kopibon_core::conversion::verify::verify_cbz(&cbz_path, 2));
    // ComicInfo not entry 0 → fail.
    let cbz_path2 = e.dir.join("ci-not-first.cbz");
    {
        let file = std::fs::File::create(&cbz_path2).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
        zip.start_file("0001.jpg", opts).unwrap();
        zip.write_all(&jpeg).unwrap();
        zip.start_file("ComicInfo.xml", opts).unwrap();
        zip.write_all(b"<ComicInfo><Title>T</Title></ComicInfo>").unwrap();
        zip.finish().unwrap();
    }
    assert!(!kopibon_core::conversion::verify::verify_cbz(&cbz_path2, 1));
    // Empty-title ComicInfo → fail.
    let cbz_path3 = e.dir.join("empty-title.cbz");
    {
        let file = std::fs::File::create(&cbz_path3).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
        zip.start_file("ComicInfo.xml", opts).unwrap();
        zip.write_all(b"<ComicInfo><Series>S</Series></ComicInfo>").unwrap();
        zip.start_file("0001.jpg", opts).unwrap();
        zip.write_all(&jpeg).unwrap();
        zip.finish().unwrap();
    }
    assert!(!kopibon_core::conversion::verify::verify_cbz(&cbz_path3, 1));
    // Valid archive → pass.
    let cbz_ok = e.dir.join("valid.cbz");
    {
        let file = std::fs::File::create(&cbz_ok).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
        zip.start_file("ComicInfo.xml", opts).unwrap();
        zip.write_all(b"<ComicInfo><Title>T</Title></ComicInfo>").unwrap();
        zip.start_file("0001.jpg", opts).unwrap();
        zip.write_all(&jpeg).unwrap();
        zip.finish().unwrap();
    }
    assert!(kopibon_core::conversion::verify::verify_cbz(&cbz_ok, 1));
    std::fs::remove_dir_all(&e.dir).ok();
}

#[test]
fn cv01_count_guard_loud_lossy_failure() {
    let (e, conn) = env();
    let jpeg = scanner_fixture::cover_jpeg(300, 420);
    let pdf_rel = "Test Artist/mismatch.pdf";
    let pdf_abs = e.library_root.join(pdf_rel);
    std::fs::create_dir_all(pdf_abs.parent().unwrap()).unwrap();
    // Two embedded images but a THREE-page document → count guard trips.
    scanner_fixture::build_image_pdf(&pdf_abs, std::slice::from_ref(&jpeg)).unwrap();
    // Pad the page tree to 3 by adding two empty page kids.
    {
        let mut doc = lopdf::Document::load(&pdf_abs).unwrap();
        let catalog_id = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
        let catalog = doc.get_object(catalog_id).unwrap().as_dict().unwrap().clone();
        let pages_id = catalog.get(b"Pages").unwrap().as_reference().unwrap();
        let pages_dict = doc.get_object(pages_id).unwrap().as_dict().unwrap().clone();
        let empty_page = doc.add_object(
            lopdf::Dictionary::from_iter([
                (b"Type".to_vec(), lopdf::Object::Name(b"Page".to_vec())),
                (b"Parent".to_vec(), lopdf::Object::Reference(pages_id)),
            ]),
        );
        let mut kids = pages_dict.get(b"Kids").unwrap().as_array().unwrap().clone();
        kids.push(lopdf::Object::Reference(empty_page));
        kids.push(lopdf::Object::Reference(empty_page));
        doc.set_object(
            pages_id,
            lopdf::Dictionary::from_iter([
                (b"Type".to_vec(), lopdf::Object::Name(b"Pages".to_vec())),
                (b"Kids".to_vec(), lopdf::Object::Array(kids)),
                (b"Count".to_vec(), lopdf::Object::Integer(3)),
            ]),
        );
        doc.save(&pdf_abs).unwrap();
    }

    let (_queue_id, _item) = seed_pdf(&conn, &e, pdf_rel, false);
    let mut logs = Vec::new();
    let scratch = e.data_dir.join("convert-cbz/probe");
    let err = kopibon_core::conversion::extract::extract_pdf_images(&pdf_abs, &scratch, &mut |m| {
        logs.push(m)
    })
    .unwrap_err();
    // USER DECISION: loud per-item error, source untouched.
    assert_eq!(
        err,
        "lossy fallback requires a rasteriser; source PDF left in place"
    );
    assert!(pdf_abs.exists(), "the source PDF is never deleted on the lossy path");
    assert!(!scratch.exists(), "extraction debris discarded");
    assert!(logs.iter().any(|l| l.contains("Count mismatch")));
}

#[test]
fn cv01_keep_original_false_deletes_lossless_source() {
    let (e, mut conn) = env();
    let jpeg = scanner_fixture::cover_jpeg(300, 420);
    let pdf_rel = "Test Artist/deleted.pdf";
    let pdf_abs = e.library_root.join(pdf_rel);
    std::fs::create_dir_all(pdf_abs.parent().unwrap()).unwrap();
    scanner_fixture::build_image_pdf(&pdf_abs, std::slice::from_ref(&jpeg)).unwrap();
    seed_pdf(&conn, &e, pdf_rel, false);

    let (claimed_qid, claimed_path) = kopibon_core::conversion::claim_next(&mut conn)
        .unwrap()
        .expect("claim");
    let mut item = kopibon_core::conversion::fetch_item(&conn, &claimed_path).unwrap().unwrap();
    item.queue_id = Some(claimed_qid);
    item.file_path = pdf_abs.to_string_lossy().to_string();
    let clock = FixedClock(1_700_000_000_000);
    kopibon_core::conversion::convert_one(&mut conn, &item, &options(&e, false), &clock, &mut |_| {})
        .expect("conversion");

    // keep_original=false + lossless → source deleted, nothing archived.
    assert!(!pdf_abs.exists());
    assert!(!e.library_root.join("_originals").exists());
}

#[test]
fn cv01_archive_collision_uniquifies() {
    let (e, mut conn) = env();
    let jpeg = scanner_fixture::cover_jpeg(300, 420);
    let pdf_rel = "Test Artist/collide.pdf";
    let pdf_abs = e.library_root.join(pdf_rel);
    std::fs::create_dir_all(pdf_abs.parent().unwrap()).unwrap();
    scanner_fixture::build_image_pdf(&pdf_abs, std::slice::from_ref(&jpeg)).unwrap();
    seed_pdf(&conn, &e, pdf_rel, true);

    // Pre-existing archived original with the same name.
    let archive_dir = e.library_root.join("_originals/Test Artist");
    std::fs::create_dir_all(&archive_dir).unwrap();
    std::fs::write(archive_dir.join("collide.pdf"), b"earlier copy").unwrap();

    let (claimed_qid, claimed_path) = kopibon_core::conversion::claim_next(&mut conn)
        .unwrap()
        .expect("claim");
    let mut item = kopibon_core::conversion::fetch_item(&conn, &claimed_path).unwrap().unwrap();
    item.queue_id = Some(claimed_qid);
    item.file_path = pdf_abs.to_string_lossy().to_string();
    let clock = FixedClock(1_700_000_000_000);
    let outcome = kopibon_core::conversion::convert_one(&mut conn, &item, &options(&e, true), &clock, &mut |_| {})
        .expect("conversion");

    // The earlier copy is untouched; the new one got -1.
    assert_eq!(
        std::fs::read(archive_dir.join("collide.pdf")).unwrap(),
        b"earlier copy".to_vec()
    );
    assert_eq!(
        outcome["originalPath"].as_str(),
        Some(archive_dir.join("collide-1.pdf").to_string_lossy().as_ref())
    );
    assert!(archive_dir.join("collide-1.pdf").exists());
}

#[test]
fn cv01_stale_queue_rows_skip_cleanly_and_cancel() {
    let (e, mut conn) = env();
    // A queue row whose library row no longer exists.
    conn
        .execute(
            "INSERT INTO conversion_queue (file_path, status) VALUES ('/lib/ghost.pdf', 'pending')",
            [],
        )
        .unwrap();
    // A row whose item is no longer pdf.
    conn
        .execute(
            "INSERT INTO library_item (file_path, primary_artist, format, added_at, updated_at)
             VALUES ('/lib/moved.cbz', 'A', 'cbz', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
    conn
        .execute(
            "INSERT INTO conversion_queue (file_path, library_item_id, status) VALUES ('/lib/moved.cbz', (SELECT MAX(id) FROM library_item), 'pending')",
            [],
        )
        .unwrap();

    let mut logs = Vec::new();
    let result = kopibon_core::conversion::run_conversion_batch(
        &mut conn,
        &[],
        true,
        &options(&e, true),
        &|| false,
        &FixedClock(1_700_000_000_000),
        &mut |m| logs.push(m),
    )
    .unwrap();
    assert_eq!(result["converted"], json!(0));
    assert_eq!(result["failed"], json!(0));
    // Both stale rows completed, not failed.
    let failed: i64 = conn
        .query_row("SELECT COUNT(*) FROM conversion_queue WHERE status = 'failed'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(failed, 0);

    // A fresh pending row; cancel before any claim leaves it pending.
    conn
        .execute(
            "INSERT INTO conversion_queue (file_path, library_item_id, status) VALUES ('/lib/still-there.pdf', NULL, 'pending')",
            [],
        )
        .unwrap();

    // Cancel before any claim: pending rows stay pending.
    let result = kopibon_core::conversion::run_conversion_batch(
        &mut conn,
        &[],
        true,
        &options(&e, true),
        &|| true,
        &FixedClock(1_700_000_000_000),
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(result["cancelled"], json!(true));
    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM conversion_queue WHERE status = 'pending'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(pending > 0, "pending rows untouched by cancel");
}

#[test]
fn cv01_metadata_job_resumable() {
    let (e, mut conn) = env();
    // The metadata_queue table exists (D-metadata-queue).
    let tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'metadata_queue'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(tables, 1);

    // A pdf row with a marker in the middle of the filename.
    conn
        .execute(
            "INSERT INTO library_item (file_path, primary_artist, format, gallery_id, added_at, updated_at)
             VALUES ('Test Artist/[nhentai-42] meta test.pdf', 'A', 'pdf', 42, unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
    let item_id = conn.last_insert_rowid();
    let pdf_abs = e.library_root.join("Test Artist/[nhentai-42] meta test.pdf");
    std::fs::create_dir_all(pdf_abs.parent().unwrap()).unwrap();
    scanner_fixture::build_image_pdf(&pdf_abs, &[scanner_fixture::cover_jpeg(40, 56)]).unwrap();
    conn
        .execute(
            "INSERT INTO metadata_queue (file_path, library_item_id, status) VALUES ('Test Artist/[nhentai-42] meta test.pdf', ?, 'pending')",
            [item_id],
        )
        .unwrap();

    // Cancel BEFORE any claim: nothing happens, pending stays.
    let result = kopibon_core::conversion::metadata_job::run_metadata_batch(
        &mut conn,
        &e.library_root_str,
        20,
        &|| true,
        &FixedClock(1),
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(result["cancelled"], json!(true));
    assert_eq!(result["total"], json!(1));

    // Run: the marker moves to the end, extension preserved.
    let result = kopibon_core::conversion::metadata_job::run_metadata_batch(
        &mut conn,
        &e.library_root_str,
        20,
        &|| false,
        &FixedClock(1),
        &mut |_| {},
    )
    .unwrap();
    let probe: Option<String> = conn.query_row("SELECT file_path FROM library_item", [], |r| r.get(0)).ok();
    eprintln!("DBG lib rows: {probe:?}");
    eprintln!("DBG meta result: {result}");
    assert_eq!(result["converted"], json!(1));
    let new_path: String = conn
        .query_row("SELECT file_path FROM library_item WHERE id = ?", [item_id], |r| r.get(0))
        .unwrap();
    assert_eq!(new_path, "Test Artist/meta test [nhentai-42].pdf");
    assert!(e.library_root.join(&new_path).exists());
    assert!(!pdf_abs.exists());

    // Crash simulation: 'converting' row → 'pending' (the maintenance reset)
    // and a rerun finishes the remainder.
    conn
        .execute(
            "INSERT INTO metadata_queue (file_path, library_item_id, status) VALUES ('/lib/never.pdf', NULL, 'converting')",
            [],
        )
        .unwrap();
    conn
        .execute(
            "UPDATE metadata_queue SET status = 'pending' WHERE status = 'converting'",
            [],
        )
        .unwrap();
    let result = kopibon_core::conversion::metadata_job::run_metadata_batch(
        &mut conn,
        &e.library_root_str,
        20,
        &|| false,
        &FixedClock(1),
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(result["failed"], json!(1), "missing row counts as failed");
    assert_eq!(result["errors"].as_array().unwrap().len(), 1);
}

#[test]
fn cv01_originals_walk_restore_purge() {
    let (e, conn) = env();
    // 1.x layout: _lossy sits at the TOP of the archive root.
    let archive = e.library_root.join("_originals");
    std::fs::create_dir_all(archive.join("Artist A")).unwrap();
    std::fs::create_dir_all(archive.join("_lossy/Artist B")).unwrap();
    std::fs::write(archive.join("Artist A/one.pdf"), b"pdf1").unwrap();
    std::fs::write(archive.join("_lossy/Artist B/two.pdf"), b"pdf2").unwrap();

    // Walk classifies the _lossy subtree separately.
    let info = kopibon_core::conversion::originals::scan_originals(&archive);
    assert_eq!(info["count"], json!(2));
    assert!(info["originals"].as_array().unwrap().iter().any(|v| v.as_str().unwrap().contains("one.pdf")));
    assert!(info["lossy"].as_array().unwrap().iter().any(|v| v.as_str().unwrap().contains("two.pdf")));

    // Restore: rel path with the leading _lossy segment stripped.
    let item_id: i64 = 1;
    conn
        .execute(
            "INSERT INTO library_item (file_path, primary_artist, format, added_at, updated_at)
             VALUES ('Artist B/two.cbz', 'Artist B', 'cbz', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
    let cbz = e.library_root.join("Artist B/two.cbz");
    std::fs::create_dir_all(cbz.parent().unwrap()).unwrap();
    std::fs::write(&cbz, b"cbz bytes").unwrap();

    kopibon_core::conversion::originals::restore_original(
        &conn,
        &archive.join("_lossy/Artist B/two.pdf"),
        &e.library_root,
        item_id,
    )
    .expect("restore");

    // PDF landed at Artist B/two.pdf (lossy segment stripped), CBZ deleted,
    // row back to pdf.
    assert!(e.library_root.join("Artist B/two.pdf").exists());
    assert!(!cbz.exists());
    let format: String = conn
        .query_row("SELECT format FROM library_item WHERE id = ?", [item_id], |r| r.get(0))
        .unwrap();
    assert_eq!(format, "pdf");

    // Never overwrite an existing target: place a file at the exact target.
    std::fs::create_dir_all(e.library_root.join("Artist A")).unwrap();
    std::fs::write(e.library_root.join("Artist A/one.pdf"), b"existing").unwrap();
    let err = kopibon_core::conversion::originals::restore_original(
        &conn,
        &archive.join("Artist A/one.pdf"),
        &e.library_root,
        item_id,
    )
    .unwrap_err();
    assert!(err.contains("already exists"));

    // Purge: default spares _lossy; includeLossy takes both.
    std::fs::write(archive.join("Artist A/keep.pdf"), b"p1").unwrap();
    std::fs::write(archive.join("_lossy/Artist B/drop.pdf"), b"p2").unwrap();
    let result = kopibon_core::conversion::originals::purge_originals(&archive, false);
    // one.pdf (whose restore collided) + keep.pdf go; _lossy is spared.
    assert_eq!(result["deleted"], json!(2), "lossy spared");
    assert!(archive.join("_lossy/Artist B/drop.pdf").exists());
    let result = kopibon_core::conversion::originals::purge_originals(&archive, true);
    assert_eq!(result["deleted"], json!(1), "includeLossy takes the rest");
    std::fs::remove_dir_all(&e.dir).ok();
}
