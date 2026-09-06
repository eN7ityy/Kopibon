//! Phase B exit criterion (2) — freshness without polling.
//!
//! The renderer holds the library grid open with zero steady-state IPC: no
//! timers, no pollers, no background threads fire while the user idles, and
//! when a scan lands, `library:newItems` plus its covers reach the UI within
//! 2 s. These tests pin the shell side of that contract on scratch dirs:
//!
//! 1. `idle_state_is_quiet` — an open state with no commands in flight
//!    appends nothing to the ring or the log file over ~1.2 s.
//! 2. `scan_new_items_arrive_within_budget` — a two-item CBZ library emits
//!    its first `NewItems` batch < 2 s after the scan starts.
//! 3. `cover_thumbnail_builds_within_budget` — the per-cover shell cost
//!    (`build_thumbnail_for`) stays far inside the 2 s cover budget.
//!
//! The Tauri-side emit latency (event → webview) is renderer territory and
//! is covered by `contract:bridge`; what is pinned here is that the shell
//! never makes the renderer wait on polling or slow cover builds.

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Instant;

    use kopibon_core::db::connection::open_connection;
    use kopibon_core::metadata::mappers::SystemClock;
    use kopibon_core::scanner::{run_scan, NoControl, ScanEvent, ScanOptions};

    use crate::library::build_thumbnail_for;
    use crate::log::records_to_json;
    use crate::state::AppState;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "kopibon-freshness-{tag}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }

    /// A tiny valid JPEG (same shape as the core `scanner_fixture` helper).
    fn cover_jpeg(width: u32, height: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(width, height, image::Rgba([180, 40, 40, 255]));
        let mut buf = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut buf, image::ImageFormat::Jpeg)
            .expect("encode jpeg");
        buf.into_inner()
    }

    /// Minimal single-page CBZ: ComicInfo.xml + one JPEG page (same shape as
    /// `build_cbz` in the core scanner fixture).
    fn write_cbz(path: &std::path::Path, page: &[u8]) {
        let file = std::fs::File::create(path).expect("create cbz");
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("ComicInfo.xml", options).expect("comicinfo");
        zip.write_all(b"<ComicInfo/>").expect("write comicinfo");
        zip.start_file("page-0.jpg", options).expect("page");
        zip.write_all(page).expect("write page");
        zip.finish().expect("finish cbz");
    }

    #[test]
    fn idle_state_is_quiet() {
        let dir = scratch_dir("idle");
        let state = AppState::open(dir.clone()).expect("scratch state opens");
        let ring_before = state.logger.ring_buffer().len();
        let log_path = state.logger.log_dir().join("app.log");
        let file_before = std::fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);
        std::thread::sleep(std::time::Duration::from_millis(1200));
        assert_eq!(
            state.logger.ring_buffer().len(),
            ring_before,
            "no background thread logs at idle (steady-state IPC = 0)"
        );
        let file_after = std::fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);
        assert_eq!(file_after, file_before, "log file silent at idle");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn scan_new_items_arrive_within_budget() {
        let dir = scratch_dir("scan");
        let state = AppState::open(dir.clone()).expect("scratch state opens");
        let root = dir.join("library").join("artistA");
        std::fs::create_dir_all(&root).expect("library tree");
        let page = cover_jpeg(400, 600);
        write_cbz(&root.join("First [nhentai-111111].cbz"), &page);
        write_cbz(&root.join("Second [nhentai-222222].cbz"), &page);
        // The scanner skips files modified < 5 s ago (concurrent-download
        // guard, process.rs:249) — backdate fixtures past the guard.
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        let times = std::fs::FileTimes::new()
            .set_accessed(old)
            .set_modified(old);
        for name in ["First [nhentai-111111].cbz", "Second [nhentai-222222].cbz"] {
            std::fs::File::options()
                .write(true)
                .open(root.join(name))
                .expect("open fixture")
                .set_times(times)
                .expect("backdate fixture");
        }

        let db_path = dir.join("db.sqlite");
        let mut conn = open_connection(&db_path).expect("own scan connection");
        let thumb_dir = dir.join("thumbs");
        std::fs::create_dir_all(&thumb_dir).expect("thumb dir");
        let options = ScanOptions {
            library_root: &dir.join("library"),
            thumbnail_dir: &thumb_dir,
        };
        let started = Instant::now();
        let mut first_new_items_at: Option<std::time::Duration> = None;
        let mut new_item_total = 0usize;
        let outcome = run_scan(
            &mut conn,
            &options,
            &SystemClock,
            &NoControl,
            &mut |event| {
                if let ScanEvent::NewItems { items } = event {
                    if first_new_items_at.is_none() {
                        first_new_items_at = Some(started.elapsed());
                    }
                    new_item_total += items.len();
                }
            },
        )
        .expect("scan runs");
        let first = first_new_items_at.expect("scan emits a NewItems batch");
        assert_eq!(
            new_item_total, 2,
            "both items arrive via events, not polling"
        );
        assert!(
            first.as_millis() < 2000,
            "first NewItems in {}ms, budget 2000ms (09 §Phase B exit 2)",
            first.as_millis()
        );
        let result = outcome.expect("scan completes");
        assert_eq!(result.new_items, 2);
        // The ring stays usable as the event audit trail, not a poll source.
        let _ = records_to_json(&state.logger.ring_buffer());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cover_thumbnail_builds_within_budget() {
        let dir = scratch_dir("cover");
        let state = AppState::open(dir.clone()).expect("scratch state opens");
        let source = dir.join("page.jpg");
        std::fs::write(&source, cover_jpeg(1275, 1650)).expect("source page");
        let started = Instant::now();
        let thumb = build_thumbnail_for(&dir, &state.db, &source, "cover-target.cbz")
            .expect("thumbnail builds");
        let elapsed = started.elapsed();
        assert!(
            std::path::Path::new(&thumb).is_file(),
            "thumbnail lands on disk"
        );
        assert!(
            elapsed.as_millis() < 2000,
            "cover built in {}ms, budget 2000ms (09 §Phase B exit 2)",
            elapsed.as_millis()
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
