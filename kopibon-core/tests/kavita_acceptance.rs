//! KV-01/KV-02 (10-test-plan §4; 07 §6-7) — endpoint shape parity on a
//! replay transport (method/path/query/headers incl. x-api-key-only auth,
//! body apiKey on scan-folder, positive-int filter, exact-match delete
//! guard, translate_to_kavita_path, item-count cache) plus the integration
//! acceptances against the Doujin-Test library (id 6).
//!
//! The production library (id 5) is UNTOUCHABLE: the suite refuses it by id,
//! asserts its item count before/after every mutating test, and all mutation
//! helpers run inside Doujin-Test only. These tests are `--ignored` (they
//! need the live Kavita server).

mod common;

use kopibon_core::kavita::{
    assert_not_production_library, translate_to_kavita_path, KavitaClient, KavitaConfig,
};
use kopibon_core::nhentai::http::{RequestDef, ResponseDef, Transport};
use serde_json::{json, Value};
use std::sync::Mutex;

// ─── Replay transport ────────────────────────────────────────────────────────

struct Replay {
    responses: Mutex<Vec<Result<ResponseDef, String>>>,
    requests: Mutex<Vec<RequestDef>>,
}

impl Transport for Replay {
    fn send(&self, request: &RequestDef) -> Result<ResponseDef, String> {
        self.requests.lock().unwrap().push(request.clone());
        self.responses.lock().unwrap().remove(0)
    }
}

fn ok(body: &str) -> Result<ResponseDef, String> {
    Ok(ResponseDef {
        status: 200,
        status_text: "OK".into(),
        headers: vec![],
        body: body.to_string(),
    })
}

fn make_client(responses: Vec<Result<ResponseDef, String>>) -> (KavitaClient<'static, Replay>, *const Replay) {
    // Leak the transport into a 'static arena for the borrow checker.
    let boxed: &'static Replay = Box::leak(Box::new(Replay {
        responses: Mutex::new(responses),
        requests: Mutex::new(Vec::new()),
    }));
    let client = KavitaClient::new(boxed, KavitaConfig::read(Some((
        "http://kavita.bragi.internal",
        "k",
        "6",
    ))));
    (client, boxed as *const Replay)
}

// ─── Unit shapes (no server) ─────────────────────────────────────────────────

#[test]
fn kv_path_translation() {
    assert_eq!(
        translate_to_kavita_path("/lib/Artist/x.cbz", "/lib", "/kavita"),
        "/kavita/Artist/x.cbz"
    );
    // Outside-root → unchanged.
    assert_eq!(
        translate_to_kavita_path("/other/x.cbz", "/lib", "/kavita"),
        "/other/x.cbz"
    );
    // Missing roots → unchanged.
    assert_eq!(translate_to_kavita_path("/lib/x", "", "/kavita"), "/lib/x");
    assert_eq!(translate_to_kavita_path("/lib/x", "/lib", ""), "/lib/x");
    // Trailing slashes stripped everywhere.
    assert_eq!(
        translate_to_kavita_path("/lib/a/", "/lib/", "/kavita//"),
        "/kavita/a"
    );
    assert_eq!(translate_to_kavita_path("/lib", "/lib/", "/kavita/"), "/kavita");
}

#[test]
fn kv_config_gating() {
    let full = KavitaConfig::read(Some(("http://h:5000/", " key ", " 6 ")));
    assert_eq!(full.url, "http://h:5000", "trailing slash stripped");
    assert_eq!(full.api_key, "key", "key trimmed");
    assert!(full.is_configured(true), "complete config passes");
    assert!(!full.is_configured(false), "the checkbox gates everything");
    assert!(!KavitaConfig::read(Some(("", "k", "6"))).is_configured(true));
    assert!(!KavitaConfig::read(Some(("u", "", "6"))).is_configured(true));
    assert!(!KavitaConfig::read(Some(("u", "k", ""))).is_configured(true));
}

#[test]
fn kv_production_guard_refuses_id_5() {
    assert!(assert_not_production_library("6").is_ok());
    assert!(assert_not_production_library("5").is_err());
}

// ─── Request-shape parity on replay ────────────────────────────────────────

#[test]
fn kv_request_shapes() {
    let (c, arena) = make_client(vec![
        ok("true"), // testConnection /api/Account
    ]);
    let result = c.test_connection(None, None);
    assert!(result.ok, "in-band ok (never throws)");
    let requests = unsafe { &*arena }.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].url, "http://kavita.bragi.internal/api/Account");
    // x-api-key auth, never Bearer.
    assert!(requests[0]
        .headers
        .iter()
        .any(|(k, v)| k == "x-api-key" && v == "k"));
    assert!(!requests[0].headers.iter().any(|(k, _)| k == "Authorization"));

    // (transport-error path covered in the live-unreachable assertion of
    // the doc comment; the replay below exercises the real branches.)

    // scan-folder: POST, translated path, key ALSO in the body, count stale.
    let (mut c, arena) = make_client(vec![ok("")]); // empty body → status matters
    let mut logs = Vec::new();
    c.scan_folder("/lib/Artist/x.cbz", "/lib", "/kavita", &mut |m| logs.push(m));
    let requests = unsafe { &*arena }.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].url, "http://kavita.bragi.internal/api/Library/scan-folder");
    let body: Value = serde_json::from_str(&requests[0].body.clone().expect("body")).expect("json");
    assert_eq!(body["folderPath"], json!("/kavita/Artist/x.cbz"));
    assert_eq!(body["apiKey"], json!("k"), "key also in the body (:361-368)");

    // search: queryString param.
    let (c, arena) = make_client(vec![ok(r#"{"series":[{"id":1,"name":"X"}]}"#)]);
    let hits = c.search_series("Dolls");
    assert_eq!(hits.len(), 1);
    let requests = unsafe { &*arena }.requests.lock().unwrap().clone();
    assert!(requests[0].url.ends_with("/api/Search/search?queryString=Dolls"));



    // delete-multiple: positive-integer filter, one call.
    let (mut c, arena) = make_client(vec![ok("")]);
    let mut logs = Vec::new();
    c.delete_multiple_series(&[0, -2, 9, 9, 3], &mut |m| logs.push(m));
    let requests = unsafe { &*arena }.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "POST");
    let body: Value = serde_json::from_str(&requests[0].body.clone().expect("body")).expect("json");
    assert_eq!(body["seriesIds"], json!([9, 3]), "positive-integer filter + dedup");

    // exact-match delete guard: "Doll" must NOT delete series "Dolls".
    let (mut c, _) = make_client(vec![
        ok(r#"{"series":[{"id":7,"name":"Dolls"}]}"#),
        ok(""),
    ]);
    let mut logs = Vec::new();
    let deleted = c.delete_items_exact(&["Doll"], &mut |m| logs.push(m));
    assert!(deleted.is_empty(), "no exact hit → skip and log");
    assert!(logs.iter().any(|l| l.contains("no exact Kavita match")));

    // Exact match (case-insensitive) deletes.
    let (mut c, _) = make_client(vec![
        ok(r#"{"series":[{"id":7,"name":"Dolls"},{"id":8,"name":"Other"}]}"#),
        ok(""),
    ]);
    let mut logs = Vec::new();
    let deleted = c.delete_items_exact(&["dolls"], &mut |m| logs.push(m));
    assert_eq!(deleted, vec![7]);

    // Item-count cache: hit within 60s, expiry after.
    let (mut c, _) = make_client(vec![
        ok(r#"{"chapterCount":5258}"#),
        ok(r#"{"chapterCount":5259}"#),
        ok(r#"{"chapterCount":5260}"#),
    ]);
    assert_eq!(c.get_item_count(1_000), Some(5258));
    assert_eq!(c.get_item_count(1_000 + 59_999), Some(5258), "cache hit");
    assert_eq!(c.get_item_count(1_000 + 60_000), Some(5259), "expired");
    c.invalidate_item_count();
        assert_eq!(c.get_item_count(99_999_999), Some(5260));
    // failure → null, never throws.
    let (mut c, _) = make_client(vec![Err("boom".into())]);
    assert_eq!(c.get_item_count(0), None, "transport failure → null");
}

// ─── Live transport: minimal plaintext HTTP/1.1 (the server is port 80) ─────

/// A real request against the live server for the ignored acceptances.
/// Production writes never go through here without the id-5 refusal.
struct LiveTransport {
    host: String,
}

impl Transport for LiveTransport {
    fn send(&self, request: &RequestDef) -> Result<ResponseDef, String> {
        use std::io::{Read, Write};
        let path = request
            .url
            .split_once("://")
            .and_then(|(_, rest)| rest.find('/').map(|i| &rest[i..]))
            .unwrap_or("/");
        let mut stream = std::net::TcpStream::connect((self.host.as_str(), 80))
            .map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .ok();
        stream
            .set_write_timeout(Some(std::time::Duration::from_secs(10)))
            .ok();
        let mut headers = format!("{} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n", request.method, path, self.host);
        for (k, v) in &request.headers {
            headers.push_str(&format!("{k}: {v}\r\n"));
        }
        let body = request.body.clone().unwrap_or_default();
        headers.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
        headers.push_str(&body);
        stream.write_all(headers.as_bytes()).map_err(|e| e.to_string())?;
        let mut response = Vec::new();
        stream.read_to_end(&mut response).map_err(|e| e.to_string())?;
        let header_end = response
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .ok_or("bad response")?;
        let head = String::from_utf8_lossy(&response[..header_end]).to_string();
        let status: u16 = head
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .ok_or("bad status")?;
        let status_text = head
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(2))
            .unwrap_or("")
            .to_string();
        let mut resp_headers = Vec::new();
        for line in head.lines().skip(1) {
            if let Some((k, v)) = line.split_once(':') {
                resp_headers.push((k.trim().to_string(), v.trim().to_string()));
            }
        }
        Ok(ResponseDef {
            status,
            status_text,
            headers: resp_headers,
            body: String::from_utf8_lossy(&response[header_end + 4..]).to_string(),
        })
    }
}

fn live_key() -> Option<String> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("root");
    let text = std::fs::read_to_string(root.join("plans/kopibon_rust_port/kavita_server.txt")).ok()?;
    for line in text.lines() {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim() == "api_key" {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

/// Server-wide chapterCount (moves on ANY library mutation — the KV-02
/// coarse invariant alongside the id-5 refusal).
fn server_chapter_count(transport: &LiveTransport, key: &str) -> i64 {
    let mut client = KavitaClient::new(
        transport,
        KavitaConfig::read(Some(("http://kavita.bragi.internal", key, "6"))),
    );
    let count = client.get_item_count(0);
    if count.unwrap_or(-1) < 0 {
        let requests: Vec<String> = Vec::new();
        let _ = requests;
    }
    count.unwrap_or(-1)
}

fn require_live() -> (LiveTransport, String) {
    let key = live_key()
        .map(|k| {
            // The file line is `api_key: <key>`; a colon-split keeps the value
            // but any trailing comment would ride along — take the token.
            k.split_whitespace().next().unwrap_or("").to_string()
        })
        .filter(|k| !k.is_empty())
        .expect("kavita key file present");
    (
        LiveTransport {
            host: "kavita.bragi.internal".to_string(),
        },
        key,
    )
}

/// KV-01 positive: connection + libraries enumerate both ids; id-5 count
/// pinned before and after.
#[test]
#[ignore]
fn kv01_connection_and_libraries() {
    let (transport, key) = require_live();
    let config = KavitaConfig::read(Some(("http://kavita.bragi.internal", &key, "6")));
    let client = KavitaClient::new(&transport, config);

    let before = server_chapter_count(&transport, &key);
    assert!(before > 0, "stats readable, chapterCount = {before}");
    // The libraries endpoint itself must still enumerate both ids.
    let libs = client.get_libraries().expect("libraries enumerate");
    let ids: Vec<i64> = libs.iter().filter_map(|l| l.get("id").and_then(Value::as_i64)).collect();
    assert!(ids.contains(&5) && ids.contains(&6), "both libraries present: {ids:?}");

    let result = client.test_connection(None, None);
    assert!(result.ok, "live connection is ok: {result:?}");

    let after = server_chapter_count(&transport, &key);
    assert_eq!(before, after, "KV-02: library id 5 untouched (chapterCount pinned)");
    // And the id-5 refusal is ironclad even for would-be mutations.
    assert!(assert_not_production_library("5").is_err());
    assert!(assert_not_production_library("6").is_ok());
}

#[test]
#[ignore]
fn kv01_search_and_exact_delete_guard_live() {
    let (transport, key) = require_live();
    let config = KavitaConfig::read(Some(("http://kavita.bragi.internal", &key, "6")));
    let mut logs: Vec<String> = Vec::new();

    // Sandbox-only: the delete helper's searches run library-scoped by the
    // server config; the exact-match guard is proven on replay above.
    let before = server_chapter_count(&transport, &key);

    let mut client = KavitaClient::new(&transport, config);
    // Deliberately non-matching title: must skip, never delete.
    let deleted = client.delete_items_exact(&["definitely-not-a-series-xyzzy"], &mut |m| logs.push(m));
    assert!(deleted.is_empty());
    assert!(logs.iter().any(|l| l.contains("no exact Kavita match")));

    // The library-id guard refuses id 5 even for a read-shape helper.
    assert!(assert_not_production_library("5").is_err());
    assert!(assert_not_production_library("6").is_ok());

    let after = server_chapter_count(&transport, &key);
    assert_eq!(before, after, "KV-02: library id 5 untouched");
}

/// KV-01 negative: wrong key → {ok:false}; unreachable host → never throws.
#[test]
#[ignore]
fn kv01_negatives() {
    let (transport, _key) = require_live();
    let config = KavitaConfig::read(Some(("http://kavita.bragi.internal", "wrong-key", "6")));
    let client = KavitaClient::new(&transport, config);
    assert!(!client.test_connection(None, None).ok, "wrong key → ok:false");

    let dead = LiveTransport {
        host: "no-such-host.invalid".to_string(),
    };
    let config = KavitaConfig::read(Some(("http://no-such-host.invalid", "k", "6")));
    let client = KavitaClient::new(&dead, config);
    assert!(!client.test_connection(None, None).ok, "unreachable → ok:false, no throw");
    assert!(client.search_series("x").is_empty(), "search failure → []");
    let mut c2 = KavitaClient::new(
        &dead,
        KavitaConfig::read(Some(("http://no-such-host.invalid", "k", "6"))),
    );
    let mut logs = Vec::new();
    c2.scan_folder("/lib/x.cbz", "/lib", "/kavita", &mut |m| logs.push(m));
    assert!(logs.iter().any(|l| l.contains("failed")), "fire-and-forget swallows");
}
