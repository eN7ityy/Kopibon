//! DL-01 — download pipeline tests (03 §9): a real local fixture HTTP server
//! drives the page fetches (success, 404-then-success rotation, non-404
//! failure ladder, CDN demotion/re-promotion), canned API responses drive the
//! client, and the state machine / placeholder lifecycle / claim order /
//! crash reconciliation are asserted on the port's DB and artefacts.
//!
//! 1.x's own DownloadManager is Electron-bound (Notification, app paths), so
//! per plan 03 §9 these are state-machine + fixture-server tests on the port
//! rather than byte differentials; the CBZ artefact itself is already proven
//! byte-identical to yazl by WR-03.

mod common;

use kopibon_core::metadata::mappers::{Clock, FixedClock};
use kopibon_core::metadata::writers::comicinfo::count_cbz_pages;
use kopibon_core::nhentai::http::{RequestDef, ResponseDef, Transport};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use kopibon_core::download::cdn::CdnState;
use kopibon_core::download::pipeline::PageFetchError;

// ─── Fixture HTTP server (the scripted CDN) ─────────────────────────────────

/// Serves GETs from a route table keyed by path; unhandled paths → 500.
/// Counts hits per path so rotation and demotion tests can assert order.
struct FixtureServer {
    addr: std::net::SocketAddr,
    hits: Arc<Mutex<std::collections::HashMap<String, usize>>>,
}

impl FixtureServer {
    fn start(routes: Vec<(String, u16, Vec<u8>)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let hits: Arc<Mutex<std::collections::HashMap<String, usize>>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        let route_map: std::collections::HashMap<String, (u16, Vec<u8>)> = routes
            .into_iter()
            .map(|(path, status, body)| (path, (status, body)))
            .collect();
        let hits_server = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 4096];
                let read = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..read]).to_string();
                let path = req
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("/")
                    .to_string();
                *hits_server.lock().unwrap().entry(path.clone()).or_insert(0) += 1;
                let (status, body) = match route_map.get(&path) {
                    Some((s, b)) => (*s, b.clone()),
                    None => (500, b"unexpected".to_vec()),
                };
                let reason = match status {
                    200 => "OK",
                    404 => "Not Found",
                    500 => "Internal Server Error",
                    _ => "Error",
                };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(response.as_bytes()).ok();
                stream.write_all(&body).ok();
            }
        });
        FixtureServer { addr, hits }
    }

    fn hit_count(&self, path: &str) -> usize {
        self.hits.lock().unwrap().get(path).copied().unwrap_or(0)
    }
}

/// Minimal blocking HTTP/1.1 GET client — connects to the fixture server,
/// using only the path of the (https://…) URL the client builds. Production
/// uses reqwest; this stands in for it against a plaintext fixture.
struct MiniHttpClient {
    addr: std::net::SocketAddr,
}

impl MiniHttpClient {
    fn get(&self, url: &str) -> Result<(u16, Vec<u8>), String> {
        let path = match url.split_once("://") {
            Some((_, rest)) => match rest.find('/') {
                Some(i) => &rest[i..],
                None => "/",
            },
            None => url,
        };
        let mut stream = std::net::TcpStream::connect(self.addr).map_err(|e| e.to_string())?;
        let req = format!("GET {path} HTTP/1.1\r\nHost: fixture\r\nUser-Agent: Doujin-Downloader/1.0\r\nConnection: close\r\n\r\n");
        stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
        let mut response = Vec::new();
        stream.read_to_end(&mut response).map_err(|e| e.to_string())?;
        let header_end = response
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .ok_or("bad response")?;
        let header_text = String::from_utf8_lossy(&response[..header_end]).to_string();
        let status: u16 = header_text
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .ok_or("bad status")?;
        Ok((status, response[header_end + 4..].to_vec()))
    }
}

// ─── Scripted API responses ─────────────────────────────────────────────────

struct ScriptedApi {
    responses: Mutex<Vec<Result<ResponseDef, String>>>,
    pub requests: Mutex<Vec<RequestDef>>,
}

impl Transport for ScriptedApi {
    fn send(&self, request: &RequestDef) -> Result<ResponseDef, String> {
        self.requests.lock().unwrap().push(request.clone());
        self.responses.lock().unwrap().remove(0)
    }
}

fn api_ok(body: String) -> Result<ResponseDef, String> {
    Ok(ResponseDef {
        status: 200,
        status_text: "OK".into(),
        headers: vec![],
        body,
    })
}

fn gallery_json(gallery_id: i64, media_id: &str, pages: usize) -> Value {
    json!({
        "id": gallery_id,
        "media_id": media_id,
        "title": {"english": "English Title", "japanese": null, "pretty": "Pretty Title"},
        "cover": {"path": "cover.jpg", "width": 100, "height": 140},
        "thumbnail": {"path": "thumb.jpg", "width": 100, "height": 140},
        "scanlator": "",
        "upload_date": 1_600_000_000,
        "tags": [
            {"id": 1, "type": "artist", "name": "Test Artist"},
            {"id": 2, "type": "language", "name": "english"},
            {"id": 3, "type": "group", "name": "Test Group"},
            {"id": 4, "type": "tag", "name": "vanilla"}
        ],
        "num_pages": pages,
        "num_favorites": 12,
        "pages": (1..=pages).map(|i| json!({
            "number": i, "path": format!("{i}.jpg"), "width": 1280, "height": 1803,
            "thumbnail": "t.jpg", "thumbnail_width": 100, "thumbnail_height": 140
        })).collect::<Vec<_>>()
    })
}

fn jpeg_page() -> Vec<u8> {
    let img = image::RgbaImage::from_pixel(64, 90, image::Rgba([30, 90, 200, 255]));
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut buf, image::ImageFormat::Jpeg)
        .expect("jpeg");
    buf.into_inner()
}

/// Seed a queued download row + empty gallery, run one pipeline item.
struct TestSetup {
    dir: std::path::PathBuf,
    conn: rusqlite::Connection,
    server: FixtureServer,
    http: MiniHttpClient,
    gallery_id: i64,
    queue_id: i64,
    library_root: std::path::PathBuf,
}

impl Drop for TestSetup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

static NEXT_ID: AtomicUsize = AtomicUsize::new(0);

fn setup(pages: usize, routes: Vec<(String, u16, Vec<u8>)>, output_format: &str) -> TestSetup {
    let dir = std::env::temp_dir().join(format!(
        "dl-{}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("mkdir");
    let db = kopibon_core::db::Db::open(&dir.join("db.sqlite")).expect("db");
    drop(db);
    let conn = rusqlite::Connection::open(dir.join("db.sqlite")).expect("conn");

    let server = FixtureServer::start(routes);
    let http = MiniHttpClient { addr: server.addr };
    let library_root = dir.join("library");
    std::fs::create_dir_all(&library_root).expect("libdir");

    let mut setup = TestSetup {
        dir,
        conn,
        server,
        http,
        gallery_id: 555_001,
        queue_id: 0,
        library_root,
    };

    // Queue row + concurrency setting.
    setup
        .conn
        .execute(
            "INSERT INTO download_queue (gallery_id, output_format) VALUES (?, ?)",
            rusqlite::params![setup.gallery_id, output_format],
        )
        .expect("queue row");
    setup.queue_id = setup.conn.last_insert_rowid();
    // libraryPath setting (the pipeline reads the same key).
    setup
        .conn
        .execute(
            "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('libraryPath', ?, 1)",
            rusqlite::params![setup.library_root.to_string_lossy()],
        )
        .expect("libraryPath");
    let _ = pages;
    setup
}

fn page_fetch_of(http: &MiniHttpClient) -> impl Fn(&str) -> Result<Vec<u8>, PageFetchError> + '_ {
    move |url: &str| match http.get(url) {
        Ok((200, body)) => Ok(body),
        Ok((404, _)) => Err(PageFetchError::NotFound),
        Ok((status, _)) => Err(PageFetchError::Other(format!("HTTP {status}"))),
        Err(e) => Err(PageFetchError::Other(e)),
    }
}

fn run_pipeline(setup: &mut TestSetup, api: ScriptedApi, sleeps: &Mutex<Vec<i64>>, output_format: &str) -> Vec<kopibon_core::download::pipeline::DownloadProgress> {
    let clock = FixedClock(1_700_000_000_000);
    let mut client = kopibon_core::nhentai::ApiClient::new(api, false, clock.now_ms());
    client.sleep = Box::new(|_| {});
    let mut cdn = CdnState::new();
    let events = std::rc::Rc::new(Mutex::new(Vec::new()));
    let events_sink = events.clone();
    let mut notify = move |p: kopibon_core::download::pipeline::DownloadProgress| {
        events_sink.lock().unwrap().push(p);
    };
    let mut sleep_sink = |ms: i64| sleeps.lock().unwrap().push(ms);
    let fetch = page_fetch_of(&setup.http);
    kopibon_core::download::pipeline::download_item(
        &mut setup.conn,
        &mut client,
        &mut cdn,
        setup.queue_id,
        setup.gallery_id,
        output_format,
        &Default::default(),
        &setup.library_root.to_string_lossy(),
        &setup.dir,
        &clock,
        &mut sleep_sink,
        &mut notify,
        &fetch,
    );
    drop(notify);
    std::sync::Mutex::into_inner(
            std::rc::Rc::try_unwrap(events).map_err(|_| "sole owner").expect("sole owner"),
        )
        .unwrap_or_else(|e| e.into_inner())
}

fn qrow(setup: &TestSetup) -> Value {
    kopibon_core::db::download::find_by_id(&setup.conn, setup.queue_id)
        .expect("query")
        .expect("row")
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[test]
fn dl01_full_cbz_download_end_to_end() {
    let pages = 5;
    let jpeg = jpeg_page();
    let routes: Vec<(String, u16, Vec<u8>)> = (1..=pages)
        .map(|i| (format!("/galleries/123456/{i}.jpg"), 200u16, jpeg.clone()))
        .collect();
    let mut setup = setup(pages, routes, "cbz");

    let mut api_responses = vec![
        api_ok(serde_json::to_string(&gallery_json(setup.gallery_id, "123456", pages)).unwrap()),
    ];
    // The CDN config is served from the client script (1.x: /cdn endpoint).
    api_responses.push(api_ok(
        json!({"image_servers": ["i.fixture.invalid", ""], "thumb_servers": ["t.fixture.invalid"]})
            .to_string(),
    ));
    let api = ScriptedApi {
        responses: Mutex::new(api_responses),
        requests: Mutex::new(Vec::new()),
    };

    let sleeps = Mutex::new(Vec::new());
    let events = run_pipeline(&mut setup, api, &sleeps, "cbz");

    // Queue row completed; page rows dropped on completion.
    let row = qrow(&setup);
    assert_eq!(row["status"].as_str(), Some("completed"), "{row}");
    assert!(row["completed_at"].is_i64());
    assert!(
        kopibon_core::db::download::get_pages(&setup.conn, setup.queue_id)
            .unwrap()
            .is_empty(),
        "page bookkeeping dropped"
    );

    // Placeholder promoted: is_custom 0, real fields, relative path.
    let item: (i64, String, String, i64, Option<i64>, Option<String>) = setup
        .conn
        .query_row(
            "SELECT is_custom, file_path, format, file_size, page_count, custom_date FROM library_item WHERE gallery_id = ?",
            [setup.gallery_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .expect("lib row");
    assert_eq!(item.0, 0, "placeholder promoted");
    assert!(item.1.starts_with("Test Artist/"), "{}", item.1);
    assert!(item.1.ends_with("[nhentai-555001].cbz"), "marker suffix in the stored path");
    assert_eq!(item.2, "cbz");
    assert!(item.3 > 0, "file size recorded");
    // Page count counted FROM THE FILE (5), not from num_pages.
    assert_eq!(item.4, Some(5));
    // customDate from upload_date (2020-09-13 UTC).
    assert_eq!(item.5.as_deref(), Some("2020-09-13"));

    // The file exists on disk with the sanitiser-1 path + marker.
    let output = setup
        .library_root
        .join("Test Artist")
        .join("Pretty Title [nhentai-555001].cbz");
    assert!(output.exists(), "{output:?}");
    assert_eq!(count_cbz_pages(&output).unwrap(), 5);

    // Artists inserted from gallery tags.
    let artists: i64 = setup
        .conn
        .query_row(
            "SELECT COUNT(*) FROM library_item_artist WHERE library_item_id =
               (SELECT id FROM library_item WHERE gallery_id = ?)",
            [setup.gallery_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(artists, 1, "one artist tag");

    // Thumbnail exists under the download naming scheme (<galleryId>.jpg).
    assert!(setup.dir.join("thumbnails/555001.jpg").exists());

    // Terminal completed event with full totals.
    let last = events.last().expect("events");
    assert_eq!(last.status, "completed");
    assert_eq!(last.completed_pages, 5);
    assert_eq!(last.total_pages, 5);
    assert_eq!(last.percentage, 100);
    // A 'converting' event was emitted in between.
    assert!(events.iter().any(|e| e.status == "converting"));

    // Empty-CDN-entry filtering: the "" server was filtered before ordering —
    // every page hit came from the one real server.
    for i in 1..=pages {
        assert_eq!(setup.server.hit_count(&format!("/galleries/123456/{i}.jpg")), 1);
    }

    // Scratch dir purged in the finally block.
    assert!(!setup.dir.join("download-tmp/555001").exists());
}

#[test]
fn dl01_pdf_download_page_sizes_and_metadata() {
    let jpeg = jpeg_page();
    let routes: Vec<(String, u16, Vec<u8>)> = (1..=2)
        .map(|i| (format!("/galleries/123456/{i}.jpg"), 200u16, jpeg.clone()))
        .collect();
    let mut setup = setup(2, routes, "pdf");
    let api = ScriptedApi {
        responses: Mutex::new(vec![
            api_ok(serde_json::to_string(&gallery_json(setup.gallery_id, "123456", 2)).unwrap()),
            api_ok(
                json!({"image_servers": ["i.fixture.invalid"], "thumb_servers": []}).to_string(),
            ),
        ]),
        requests: Mutex::new(Vec::new()),
    };
    let sleeps = Mutex::new(Vec::new());
    let events = run_pipeline(&mut setup, api, &sleeps, "pdf");

    let row = qrow(&setup);
    assert_eq!(row["status"].as_str(), Some("completed"));
    let row = qrow(&setup);
    eprintln!("DBG pdf row: {}", row);
    let path = setup
        .library_root
        .join("Test Artist")
        .join("Pretty Title [nhentai-555001].pdf");
    assert!(path.exists());

    // Page count counted from the PDF (2 pages, image-only) via the
    // Root → Pages → Count chain.
    let doc = lopdf::Document::load(&path).expect("pdf loads");
    let catalog_id = doc
        .trailer
        .get(b"Root")
        .unwrap()
        .as_reference()
        .unwrap();
    let catalog = doc.get_object(catalog_id).unwrap().as_dict().unwrap();
    let pages_id = catalog.get(b"Pages").unwrap().as_reference().unwrap();
    let pages = doc.get_object(pages_id).unwrap().as_dict().unwrap();
    assert_eq!(pages.get(b"Count").unwrap().as_i64().unwrap(), 2);

    // XMP embedded (apply_metadata ran; the packet head is in the file).
    let bytes = std::fs::read(&path).unwrap();
    let needle = b"<x:xmpmeta";
    assert!(
        bytes.windows(needle.len()).any(|w| w == needle),
        "XMP packet embedded"
    );

    // Terminal event.
    assert_eq!(events.last().unwrap().status, "completed");
    assert!(events.iter().any(|e| e.status == "converting"));
}

#[test]
fn dl01_page_failures_route_to_failed_download() {
    let jpeg = jpeg_page();
    let routes: Vec<(String, u16, Vec<u8>)> = vec![
        ("/galleries/123456/1.jpg".to_string(), 200, jpeg.clone()),
        // Page 2: three 500s → exhausted after 3 attempts.
        ("/galleries/123456/2.jpg".to_string(), 500, b"boom".to_vec()),
    ];
    let mut setup = setup(2, routes, "cbz");
    let api = ScriptedApi {
        responses: Mutex::new(vec![
            api_ok(serde_json::to_string(&gallery_json(setup.gallery_id, "123456", 2)).unwrap()),
            api_ok(
                json!({"image_servers": ["i.fixture.invalid"], "thumb_servers": []}).to_string(),
            ),
        ]),
        requests: Mutex::new(Vec::new()),
    };
    let sleeps = Mutex::new(Vec::new());
    let events = run_pipeline(&mut setup, api, &sleeps, "cbz");

    // Row failed with the documented message.
    let row = qrow(&setup);
    assert_eq!(row["status"].as_str(), Some("failed"));
    assert_eq!(
        row["error_message"].as_str(),
        Some("1 of 2 pages failed to download")
    );

    // The failed page's download_page row is marked failed (pre-cleanup rows
    // are only deleted on completion; failure leaves them for reconcile).
    let pages = kopibon_core::db::download::get_pages(&setup.conn, setup.queue_id).unwrap();
    assert_eq!(pages.len(), 2);
    assert_eq!(pages[1]["status"].as_str(), Some("failed"));
    assert_eq!(pages[1]["retry_count"].as_i64(), Some(3));

    // Placeholder removed on failure.
    let placeholders: i64 = setup
        .conn
        .query_row(
            "SELECT COUNT(*) FROM library_item WHERE gallery_id = ? AND is_custom = 2",
            [setup.gallery_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(placeholders, 0, "placeholder removed on failure");

    // Backoff ladder: 1s after attempt 0, 2s after attempt 1.
    assert_eq!(sleeps.lock().unwrap().as_slice(), &[1000, 2000]);

    // Scratch purged; terminal failed event with the message.
    assert!(!setup.dir.join("download-tmp/555001").exists());
    let last = events.last().unwrap();
    // The failed EVENT carries no message — the DB row does (emitProgress
    // never sets errorMessage in 1.x).
    assert_eq!(last.status, "failed");
}

#[test]
fn dl01_server_rotation_and_demotion() {
    // Server A fails non-404 always; the page succeeds on server B. With one
    // page: attempt 0 → A (fail, backoff), attempt 1 → B (success).
    let jpeg = jpeg_page();
    let routes: Vec<(String, u16, Vec<u8>)> = vec![(
        "/galleries/123456/1.jpg".to_string(),
        200,
        jpeg,
    )];
    let mut setup = setup(1, routes, "cbz");
    let api = ScriptedApi {
        responses: Mutex::new(vec![
            api_ok(serde_json::to_string(&gallery_json(setup.gallery_id, "123456", 1)).unwrap()),
            api_ok(
                json!({"image_servers": ["bad1.fixture.invalid", "good1.fixture.invalid"], "thumb_servers": []})
                    .to_string(),
            ),
        ]),
        requests: Mutex::new(Vec::new()),
    };
    let sleeps = Mutex::new(Vec::new());
    let events = run_pipeline(&mut setup, api, &sleeps, "cbz");
    // The pipeline succeeded (attempt 1 hit the good server).
    assert_eq!(qrow(&setup)["status"].as_str(), Some("completed"));
    assert_eq!(events.last().unwrap().status, "completed");

    // Demotion: 3 consecutive failures demote; a success re-promotes.
    let mut cdn = CdnState::new();
    cdn.record_failure("bad.host");
    cdn.record_failure("bad.host");
    cdn.record_failure("bad.host");
    assert!(cdn.is_demoted("bad.host"));
    // Demoted servers sink to the end, never dropped.
    let ordered = cdn.order_servers(&[
        "bad.host".to_string(),
        "ok.host".to_string(),
        "https://proto.host".to_string(),
    ]);
    assert_eq!(ordered, vec!["ok.host", "https://proto.host", "bad.host"]);
    // One success clears the count and re-promotes.
    cdn.record_success("bad.host");
    assert!(!cdn.is_demoted("bad.host"));
    assert_eq!(cdn.failure_count("bad.host"), 0);
    // Protocol stripping is the tracker key.
    assert_eq!(kopibon_core::download::cdn::host_of("https://x.host"), "x.host");
    assert_eq!(kopibon_core::download::cdn::host_of("http://x.host"), "x.host");
}

#[test]
fn dl01_placeholder_lifecycle_and_superseded_removal() {
    let jpeg = jpeg_page();
    let routes: Vec<(String, u16, Vec<u8>)> = (1..=1)
        .map(|i| (format!("/galleries/123456/{i}.jpg"), 200u16, jpeg.clone()))
        .collect();
    let mut setup = setup(1, routes, "cbz");

    // Pre-existing row pointing at an OLD file (re-download scenario).
    let old_file = setup.library_root.join("Old").join("old.cbz");
    std::fs::create_dir_all(old_file.parent().unwrap()).unwrap();
    std::fs::write(&old_file, b"old bytes").unwrap();
    setup
        .conn
        .execute(
            "INSERT INTO library_item (gallery_id, is_custom, file_path, primary_artist, series_name, series_index, added_at, updated_at)
             VALUES (?, 0, 'Old/old.cbz', 'Old Artist', 'User Series', 2.5, unixepoch(), unixepoch())",
            rusqlite::params![setup.gallery_id],
        )
        .unwrap();

    let api = ScriptedApi {
        responses: Mutex::new(vec![
            api_ok(serde_json::to_string(&gallery_json(setup.gallery_id, "123456", 1)).unwrap()),
            api_ok(
                json!({"image_servers": ["i.fixture.invalid"], "thumb_servers": []}).to_string(),
            ),
        ]),
        requests: Mutex::new(Vec::new()),
    };
    let sleeps = Mutex::new(Vec::new());
    let _ = run_pipeline(&mut setup, api, &sleeps, "cbz");

    // No placeholder row was created (the row existed); its series fields
    // survive the completion update; the superseded file is gone.
    let row: (i64, Option<String>, Option<f64>, String) = setup
        .conn
        .query_row(
            "SELECT is_custom, series_name, series_index, file_path FROM library_item WHERE gallery_id = ?",
            [setup.gallery_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(row.0, 0);
    assert_eq!(row.1.as_deref(), Some("User Series"), "existing series preserved");
    assert_eq!(row.2, Some(2.5), "existing volume preserved");
    assert!(row.3.starts_with("Test Artist/"));
    assert!(!old_file.exists(), "superseded file removed after the new one exists");
    assert!(setup
        .library_root
        .join("Test Artist")
        .join("Pretty Title [nhentai-555001].cbz")
        .exists());
}

#[test]
fn dl01_claim_order_and_queue_control() {
    let dir = std::env::temp_dir().join(format!("dl-claim-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let db = kopibon_core::db::Db::open(&dir.join("db.sqlite")).unwrap();
    drop(db);
    let conn = rusqlite::Connection::open(dir.join("db.sqlite")).unwrap();

    // Mixed queue: priority DESC, queued_at ASC wins.
    conn.execute("INSERT INTO download_queue (gallery_id, priority, queued_at) VALUES (1, 0, 100)", []).unwrap();
    conn.execute("INSERT INTO download_queue (gallery_id, priority, queued_at) VALUES (2, 5, 300)", []).unwrap();
    conn.execute("INSERT INTO download_queue (gallery_id, priority, queued_at) VALUES (3, 5, 200)", []).unwrap();

    let clock = FixedClock(1_700_000_000_000);
    let first = kopibon_core::download::dequeue_next(&conn, &clock).unwrap();
    // (gallery_id, id, output_format — DDL default 'pdf' since the INSERT
    // didn't set one.)
    assert_eq!(first, Some((3, 3, "pdf".to_string())), "priority 5, older first");
    // The claimed row flipped to downloading with a stamp.
    let row = kopibon_core::db::download::find_by_id(&conn, 3).unwrap().unwrap();
    assert_eq!(row["status"].as_str(), Some("downloading"));
    assert!(row["started_at"].is_i64());
    let second = kopibon_core::download::dequeue_next(&conn, &clock).unwrap();
    assert_eq!(second, Some((2, 2, "pdf".to_string())));
    let third = kopibon_core::download::dequeue_next(&conn, &clock).unwrap();
    assert_eq!(third, Some((1, 1, "pdf".to_string())));
    assert!(kopibon_core::download::dequeue_next(&conn, &clock)
        .unwrap()
        .is_none());

    // findActiveByGalleryId ignores history.
    conn.execute("UPDATE download_queue SET status = 'completed' WHERE id = 2", []).unwrap();
    assert!(
        kopibon_core::db::download::find_active_by_gallery_id(&conn, 5)
            .unwrap()
            .is_none(),
        "completed rows never block a retry"
    );

    // Cancel of a queued row deletes row + pages.
    conn.execute("INSERT INTO download_queue (gallery_id, status) VALUES (9, 'queued')", []).unwrap();
    let qid = conn.last_insert_rowid();
    kopibon_core::db::download::insert_page(&conn, qid, 1).unwrap();
    assert!(kopibon_core::download::cancel_queued(&conn, qid).unwrap());
    assert!(kopibon_core::db::download::find_by_id(&conn, qid).unwrap().is_none());
    assert!(kopibon_core::db::download::get_pages(&conn, qid).unwrap().is_empty());

    // Pause/resume sweeps.
    conn.execute("INSERT INTO download_queue (gallery_id, status) VALUES (10, 'queued')", []).unwrap();
    conn.execute("INSERT INTO download_queue (gallery_id, status) VALUES (11, 'queued')", []).unwrap();
    assert_eq!(kopibon_core::download::pause_all(&conn).unwrap(), 2);
    assert_eq!(kopibon_core::download::resume_all(&conn).unwrap(), 2);

    // Concurrency clamp 1–8.
    assert_eq!(kopibon_core::download::clamp_concurrency(50.0, 3), 8);
    assert_eq!(kopibon_core::download::clamp_concurrency(0.0, 3), 1);
    assert_eq!(kopibon_core::download::clamp_concurrency(f64::NAN, 3), 3);
    assert_eq!(kopibon_core::download::clamp_concurrency(4.9, 3), 4);

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn dl01_reconcile_interrupted_idempotent() {
    let dir = std::env::temp_dir().join(format!("dl-reconcile-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let data_dir = dir.join("data");
    let db = kopibon_core::db::Db::open(&dir.join("db.sqlite")).unwrap();
    drop(db);
    let conn = rusqlite::Connection::open(dir.join("db.sqlite")).unwrap();

    // Rows left mid-flight by a crash, in both interrupted states; scratch
    // and page debris present.
    conn.execute("INSERT INTO download_queue (gallery_id, status) VALUES (1, 'downloading')", []).unwrap();
    conn.execute("INSERT INTO download_queue (gallery_id, status) VALUES (2, 'converting')", []).unwrap();
    conn.execute("INSERT INTO download_queue (gallery_id, status) VALUES (3, 'completed')", []).unwrap();
    conn.execute("INSERT INTO download_queue (gallery_id, status) VALUES (4, 'queued')", []).unwrap();
    conn.execute("INSERT INTO download_page (queue_id, page_number, url, status) VALUES (1, 1, '', 'done')", []).unwrap();
    conn.execute("INSERT INTO download_page (queue_id, page_number, url, status) VALUES (2, 1, '', 'done')", []).unwrap();
    let scratch = data_dir.join("download-tmp/1");
    std::fs::create_dir_all(&scratch).unwrap();
    std::fs::write(scratch.join("0001.jpg"), b"junk").unwrap();

    let n = kopibon_core::download::reconcile_interrupted(&conn, &data_dir).unwrap();
    assert_eq!(n, 2, "downloading + converting requeued");
    for id in [1, 2] {
        let row = kopibon_core::db::download::find_by_id(&conn, id).unwrap().unwrap();
        assert_eq!(row["status"].as_str(), Some("queued"), "row {id}");
        assert!(row["started_at"].is_null());
        assert!(row["error_message"].is_null());
    }
    assert!(kopibon_core::db::download::get_pages(&conn, 1).unwrap().is_empty());
    assert!(kopibon_core::db::download::get_pages(&conn, 2).unwrap().is_empty());
    assert!(!scratch.exists(), "scratch purged");
    // Completed/queued rows untouched.
    assert_eq!(kopibon_core::db::download::find_by_id(&conn, 3).unwrap().unwrap()["status"].as_str(), Some("completed"));
    assert_eq!(kopibon_core::db::download::find_by_id(&conn, 4).unwrap().unwrap()["status"].as_str(), Some("queued"));

    // Idempotent: a second pass requeues nothing.
    assert_eq!(kopibon_core::download::reconcile_interrupted(&conn, &data_dir).unwrap(), 0);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn dl01_cancel_mid_download() {
    let jpeg = jpeg_page();
    let routes: Vec<(String, u16, Vec<u8>)> = (1..=4)
        .map(|i| (format!("/galleries/123456/{i}.jpg"), 200u16, jpeg.clone()))
        .collect();
    let mut setup = setup(4, routes, "cbz");
    let api = ScriptedApi {
        responses: Mutex::new(vec![
            api_ok(serde_json::to_string(&gallery_json(setup.gallery_id, "123456", 4)).unwrap()),
            api_ok(
                json!({"image_servers": ["i.fixture.invalid"], "thumb_servers": []}).to_string(),
            ),
        ]),
        requests: Mutex::new(Vec::new()),
    };
    let sleeps = Mutex::new(Vec::new());
    let clock = FixedClock(1_700_000_000_000);
    let mut client = kopibon_core::nhentai::ApiClient::new(api, false, clock.now_ms());
    client.sleep = Box::new(|_| {});
    let mut cdn = CdnState::new();
    let events = std::rc::Rc::new(Mutex::new(Vec::new()));
    let events_sink = events.clone();
    let mut notify = move |p: kopibon_core::download::pipeline::DownloadProgress| {
        events_sink.lock().unwrap().push(p);
    };
    let mut sleep_sink = |ms: i64| sleeps.lock().unwrap().push(ms);
    let fetch = page_fetch_of(&setup.http);

    // Cancel after the first batch — the flags object the pipeline sees.
    let flags = kopibon_core::download::pipeline::ActiveFlags::new();
    let cancelled_flags = flags.clone();
    let counter = AtomicUsize::new(0);
    let fetch_with_cancel = move |url: &str| -> Result<Vec<u8>, PageFetchError> {
        if counter.fetch_add(1, Ordering::SeqCst) >= 3 {
            cancelled_flags.cancel();
        }
        fetch(url)
    };

    kopibon_core::download::pipeline::download_item(
        &mut setup.conn,
        &mut client,
        &mut cdn,
        setup.queue_id,
        setup.gallery_id,
        "cbz",
        &flags,
        &setup.library_root.to_string_lossy(),
        &setup.dir,
        &clock,
        &mut sleep_sink,
        &mut notify,
        &fetch_with_cancel,
    );

    let row = qrow(&setup);
    assert_eq!(row["status"].as_str(), Some("failed"));
    assert_eq!(row["error_message"].as_str(), Some("Cancelled by user"));
    drop(notify);
    let events = std::sync::Mutex::into_inner(
            std::rc::Rc::try_unwrap(events).map_err(|_| "sole owner").expect("sole owner"),
        )
        .unwrap_or_else(|e| e.into_inner());
    let last = events.last().expect("events");
    assert_eq!(last.status, "failed");
    // Placeholder removed; scratch purged.
    let placeholders: i64 = setup
        .conn
        .query_row(
            "SELECT COUNT(*) FROM library_item WHERE gallery_id = ?",
            [setup.gallery_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(placeholders, 0);
    assert!(!setup.dir.join("download-tmp/555001").exists());
}
