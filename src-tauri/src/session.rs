//! Phase B exit criterion (3) — scripted full real-data session.
//!
//! The user's click path, headless: settings → search → download → scan →
//! convert → sync → viewer, with events as the only freshness mechanism (no
//! polling anywhere in the loop). It runs against a scratch data dir plus a
//! **copy** of the golden corpus (`/mnt/bragi/Kavita/DoujinsTest/`, read
//! only — the source files are never moved, renamed, or written), and every
//! step drives the same core/shell functions the Tauri command handlers call
//! (not re-implementations), so a green session means the shipped paths work.
//!
//! Two tests:
//!
//! - `session_offline` (always runs): settings round-trip, scan of the
//!   golden copy, CBZ page read (viewer), PDF→CBZ conversion with
//!   `keep_original`, blocked-list query building. Fully hermetic.
//! - `session_live` (`#[ignore]`, needs `KOPBON_LIVE_SESSION=1` + network):
//!   live gallery fetch for golden id 527302, real 16-page CDN download,
//!   scan of the download, and — only when `NHENTAI_API_KEY` is set — a live
//!   metadata sync. Run: `cargo test -p kopibon session_live -- --ignored`.

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use kopibon_core::db::connection::open_connection;
    use kopibon_core::metadata::mappers::{Clock, SystemClock};
    use kopibon_core::scanner::{run_scan, NoControl, ScanEvent, ScanOptions};

    use crate::library::cbz_read_page;
    use crate::state::AppState;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    const GOLDEN_DIR: &str = "/mnt/bragi/Kavita/DoujinsTest";
    const GOLDEN_PDF: &str = "Kaijou Gentei Omakebon [nhentai-527302].pdf";
    const LIVE_GALLERY_ID: i64 = 527302;

    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "kopibon-session-{tag}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }

    /// Copy the golden corpus into the scratch library and backdate mtimes
    /// past the scanner's 5 s concurrent-download guard.
    fn seed_golden_copy(root: &std::path::Path) -> Vec<String> {
        std::fs::create_dir_all(root).expect("library root");
        let mut names = Vec::new();
        for entry in std::fs::read_dir(GOLDEN_DIR).expect("golden corpus mounted") {
            let entry = entry.expect("dir entry");
            let name = entry.file_name().to_string_lossy().to_string();
            std::fs::copy(entry.path(), root.join(&name)).expect("copy golden file");
            names.push(name);
        }
        assert_eq!(names.len(), 3, "three golden fixtures");
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        let times = std::fs::FileTimes::new()
            .set_accessed(old)
            .set_modified(old);
        for name in &names {
            std::fs::File::options()
                .write(true)
                .open(root.join(name))
                .expect("open copy")
                .set_times(times)
                .expect("backdate copy");
        }
        names
    }

    fn scan_tree(
        conn: &mut rusqlite::Connection,
        library_root: &std::path::Path,
        thumb_dir: &std::path::Path,
    ) -> (
        Vec<(i64, String, String)>,
        kopibon_core::scanner::ScanResult,
    ) {
        let options = ScanOptions {
            library_root,
            thumbnail_dir: thumb_dir,
        };
        let mut fresh = Vec::new();
        let outcome = run_scan(conn, &options, &SystemClock, &NoControl, &mut |event| {
            if let ScanEvent::NewItems { items } = event {
                for item in items {
                    fresh.push((item.id, item.title, item.artist));
                }
            }
        })
        .expect("scan runs");
        (fresh, outcome.expect("scan completes"))
    }

    #[test]
    fn session_offline() {
        let dir = scratch_dir("offline");
        let state = AppState::open(dir.clone()).expect("scratch state opens");
        let library_root = dir.join("library");

        // 1. settings — the session's library path round-trips.
        state
            .db
            .with_writer(|conn| {
                kopibon_core::db::settings::set(
                    conn,
                    "libraryPath",
                    &library_root.to_string_lossy(),
                )?;
                kopibon_core::db::settings::set(conn, "downloadConcurrency", "3")
            })
            .expect("settings persist");
        let stored = state
            .db
            .with_reader(|conn| kopibon_core::db::settings::get(conn, "libraryPath"))
            .expect("settings read");
        assert_eq!(stored.as_deref(), Some(library_root.to_str().unwrap()));

        // 2. scan — golden copy lands as rows, purely via events.
        seed_golden_copy(&library_root);
        let db_path = dir.join("db.sqlite");
        let mut conn = open_connection(&db_path).expect("own scan connection");
        let thumb_dir = dir.join("thumbs");
        std::fs::create_dir_all(&thumb_dir).expect("thumb dir");
        let (fresh, result) = scan_tree(&mut conn, &library_root, &thumb_dir);
        assert_eq!(result.new_items, 3, "all three golden files ingest");
        assert_eq!(
            fresh.len(),
            3,
            "every item arrives as an event, never a poll"
        );
        assert!(
            fresh.iter().any(|(_, t, _)| t.contains("Kaijou")),
            "PDF item present: {fresh:?}"
        );
        let thumbs: Vec<_> = std::fs::read_dir(&thumb_dir)
            .expect("thumbs readable")
            .filter_map(|e| e.ok())
            .collect();
        assert!(thumbs.len() >= 3, "covers built for every item");

        // 3. viewer — first page of a scanned CBZ decodes as JPEG.
        let rows = state
            .db
            .with_reader(kopibon_core::db::library_write::find_all_items)
            .expect("rows readable");
        assert_eq!(rows.len(), 3);
        let cbz_row = rows
            .iter()
            .find(|v| {
                v.get("filePath")
                    .and_then(|p| p.as_str())
                    .unwrap_or("")
                    .ends_with(".cbz")
            })
            .expect("a scanned cbz row");
        let cbz_abs = library_root.join(cbz_row["filePath"].as_str().unwrap());
        let page = cbz_read_page(&cbz_abs, 0)
            .expect("page reads")
            .expect("page exists");
        assert!(page.starts_with(&[0xFF, 0xD8, 0xFF]), "JPEG magic");

        // 4. convert — the golden PDF becomes a valid CBZ, original kept.
        let pdf_row = rows
            .iter()
            .find(|v| v["filePath"].as_str().unwrap_or("").ends_with(".pdf"))
            .expect("the golden pdf row");
        let pdf_rel = pdf_row["filePath"].as_str().unwrap().to_string();
        let pdf_id = pdf_row["id"].as_i64().unwrap();
        state
            .db
            .with_writer(|conn| {
                kopibon_core::db::conversion::enqueue(conn, &pdf_rel, Some(pdf_id), true)
            })
            .expect("convert enqueued");
        let mut conn = open_connection(&db_path).expect("own convert connection");
        let (queue_id, stored) = kopibon_core::db::conversion::claim_next(&mut conn)
            .expect("claim runs")
            .expect("row claimed");
        assert_eq!(stored, pdf_rel);
        let root_str = library_root.to_string_lossy().to_string();
        let mut item = kopibon_core::conversion::fetch_item(&conn, &stored)
            .expect("fetch runs")
            .expect("item resolves");
        // Mirror the job (library_jobs.rs): the worker gets the RESOLVED
        // absolute path (library.ipc.ts:3151), never the stored relative one.
        item.file_path = kopibon_core::download::resolve_library_path(&stored, root_str.trim())
            .to_string_lossy()
            .to_string();
        let options = kopibon_core::conversion::worker_cbz::ConvertOptions {
            user_data_dir: &dir,
            library_root: root_str.trim(),
            keep_original: true,
            manga_direction: "ltr".to_string(),
            originals_root: "",
            thumbnail_dir: Some(&thumb_dir),
        };
        let mut lines = Vec::new();
        kopibon_core::conversion::convert_one(
            &mut conn,
            &item,
            &options,
            &SystemClock,
            &mut |line: String| lines.push(line),
        )
        .expect("pdf converts");
        kopibon_core::conversion::mark_completed(&conn, queue_id, SystemClock.now_ms() / 1000)
            .expect("completion marks");
        let cbz_abs = library_root.join(pdf_rel.replace(".pdf", ".cbz"));
        assert!(cbz_abs.is_file(), "converted cbz lands in the library");
        // keep_original archives the source under _originals/<artist> (the
        // CBZ takes its place) — it is never deleted.
        let archived = library_root.join("_originals").join("shaa").join(
            pdf_rel
                .rsplit('/')
                .next()
                .unwrap_or("Kaijou Gentei Omakebon [nhentai-527302].pdf"),
        );
        assert!(archived.is_file(), "original archived, not deleted");
        let archive = std::fs::File::open(&cbz_abs).expect("open converted cbz");
        let mut zip = zip::ZipArchive::new(archive).expect("valid zip");
        assert!(
            zip.by_name("ComicInfo.xml").is_ok(),
            "converted cbz carries metadata"
        );

        // 5. search — a blocked term is negated out of the built query.
        state
            .db
            .with_writer(|conn| {
                kopibon_core::db::blocked::add(conn, "tag", "sessionblockedtag", "exclude")
                    .map(|_| ())
            })
            .expect("blocked term added");
        let mut sunk = Vec::new();
        let mut sink = |record: crate::envelope::LogRecord| sunk.push(record.message);
        let outcome = crate::commands::search::build_query_impl(
            &state,
            &[serde_json::json!("shaa")],
            &mut sink,
        )
        .expect("query builds");
        let query = outcome["data"]["query"].as_str().unwrap_or("");
        assert!(query.contains("shaa"), "user term kept: {query}");
        assert!(
            query.contains("-tag:sessionblockedtag"),
            "blocked term negated: {query}"
        );

        // The golden source is untouched (read-only corpus rule).
        let golden_pdf = std::path::Path::new(GOLDEN_DIR).join(GOLDEN_PDF);
        assert!(golden_pdf.is_file(), "golden source still in place");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    #[ignore = "live nhentai + CDN; run with KOPBON_LIVE_SESSION=1"]
    fn session_live() {
        if std::env::var("KOPBON_LIVE_SESSION").is_err() {
            println!("session_live skipped (KOPBON_LIVE_SESSION unset)");
            return;
        }
        let dir = scratch_dir("live");
        let state = AppState::open(dir.clone()).expect("scratch state opens");
        let library_root = dir.join("library-dl");
        std::fs::create_dir_all(&library_root).expect("download root");
        let clock = SystemClock;
        let now = clock.now_ms();

        // 1. search — live gallery fetch for the golden id.
        let transport = crate::auth::UreqTransport::new();
        let mut client = kopibon_core::nhentai::ApiClient::new(transport, false, now);
        let response = client
            .get_gallery(LIVE_GALLERY_ID, &clock)
            .expect("gallery fetch runs")
            .expect("gallery found");
        assert_eq!(response.status, 200);
        let gallery: serde_json::Value = serde_json::from_str(&response.body).expect("json body");
        assert_eq!(gallery["id"].as_i64(), Some(LIVE_GALLERY_ID));
        assert!(
            !gallery
                .pointer("/title/pretty")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .is_empty(),
            "live title present"
        );

        // 2. download — the real 16-page CDN pull into the scratch root.
        let mut conn = open_connection(&dir.join("db.sqlite")).expect("own connection");
        let queue_id =
            kopibon_core::db::download::insert(&conn, LIVE_GALLERY_ID, "cbz", Some(0), None)
                .expect("queue insert");
        let claimed = kopibon_core::download::dequeue_next(&conn, &clock).expect("dequeue runs");
        assert!(claimed.is_some(), "row dequeued");
        let (_, gallery_id, output_format) = claimed.unwrap();
        assert_eq!(gallery_id, LIVE_GALLERY_ID);
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .build()
            .into();
        let page_fetch = |url: &str| {
            let response = agent
                .get(url)
                .header("User-Agent", kopibon_core::nhentai::CLIENT_USER_AGENT)
                .call()
                .map_err(|e| {
                    kopibon_core::download::pipeline::PageFetchError::Other(e.to_string())
                })?;
            if response.status().as_u16() == 404 {
                return Err(kopibon_core::download::pipeline::PageFetchError::NotFound);
            }
            if !response.status().is_success() {
                return Err(kopibon_core::download::pipeline::PageFetchError::Other(
                    format!("HTTP {}", response.status().as_u16()),
                ));
            }
            let bytes = response.into_body().read_to_vec().map_err(|e| {
                kopibon_core::download::pipeline::PageFetchError::Other(e.to_string())
            })?;
            Ok(bytes)
        };
        let mut progress_events = 0usize;
        let mut notify = |_: kopibon_core::download::pipeline::DownloadProgress| {
            progress_events += 1;
        };
        let mut sleep = |ms: i64| {
            std::thread::sleep(std::time::Duration::from_millis(ms.max(0) as u64));
        };
        let mut cdn = kopibon_core::download::cdn::CdnState::new();
        let flags = kopibon_core::download::pipeline::ActiveFlags::new();
        let root_str = library_root.to_string_lossy().to_string();
        kopibon_core::download::pipeline::download_item(
            &mut conn,
            &mut client,
            &mut cdn,
            queue_id,
            gallery_id,
            &output_format,
            &flags,
            &root_str,
            &dir,
            &clock,
            &mut sleep,
            &mut notify,
            &page_fetch,
        );
        let completed =
            kopibon_core::db::download::find_by_status(&conn, "completed").expect("status read");
        assert!(
            completed.iter().any(|v| v["id"].as_i64() == Some(queue_id)),
            "queue row completed"
        );
        assert!(
            progress_events > 0,
            "progress flowed via callback, not polling"
        );

        // 3. scan — the pipeline already entered the download in the library
        // (Step 9), so a re-scan must ingest nothing new: idempotent ingest,
        // no duplicate rows, freshness still purely event-driven.
        let row_id: i64 = state
            .db
            .with_reader(|conn| {
                conn.query_row(
                    "SELECT id FROM library_item WHERE gallery_id = ?",
                    [LIVE_GALLERY_ID],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())
            })
            .expect("pipeline entered the download");
        let thumb_dir = dir.join("thumbs");
        std::fs::create_dir_all(&thumb_dir).expect("thumb dir");
        // The downloader writes fresh files; wait out the 5 s mtime guard.
        std::thread::sleep(std::time::Duration::from_secs(6));
        let (fresh, result) = scan_tree(&mut conn, &library_root, &thumb_dir);
        assert_eq!(result.new_items, 0, "re-scan ingests nothing new");
        assert!(fresh.is_empty(), "no duplicate NewItems");
        let row_count: i64 = state
            .db
            .with_reader(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM library_item WHERE gallery_id = ?",
                    [LIVE_GALLERY_ID],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())
            })
            .expect("row counted");
        assert_eq!(row_count, 1, "exactly one row for the download");
        let item_id = row_id;

        // 4. sync — live metadata refresh when a key is available.
        match std::env::var("NHENTAI_API_KEY")
            .ok()
            .filter(|k| !k.is_empty())
        {
            Some(key) => {
                let row_path: String = state
                    .db
                    .with_reader(|conn| {
                        conn.query_row(
                            "SELECT file_path FROM library_item WHERE id = ?",
                            [item_id],
                            |r| r.get(0),
                        )
                        .map_err(|e| e.to_string())
                    })
                    .expect("row readable");
                let cmd = kopibon_core::sync::worker::SyncCommand {
                    item_id,
                    nhentai_id: LIVE_GALLERY_ID,
                    file_path: &row_path,
                    format: "cbz",
                    api_key: Some(&key),
                    series_name: None,
                    series_index: None,
                };
                let transport = crate::auth::UreqTransport::new();
                let outcome =
                    kopibon_core::sync::worker::sync_item(&transport, &cmd, &clock, 0, &mut sleep);
                match outcome {
                    kopibon_core::sync::worker::SyncOutcome::Success { gallery, .. } => {
                        assert_eq!(gallery["id"].as_i64(), Some(LIVE_GALLERY_ID));
                    }
                    kopibon_core::sync::worker::SyncOutcome::Error { message } => {
                        panic!("live sync failed: {message}");
                    }
                }
            }
            None => println!("live sync skipped (NHENTAI_API_KEY unset)"),
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
