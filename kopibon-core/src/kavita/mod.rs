//! Kavita client port (kavita-client.ts) — thin, stateless; config read from
//! settings at call time so a save takes effect on the next call. Auth is the
//! `x-api-key` header (plus the body `apiKey` on scan-folder); 10 s timeout;
//! 204/empty bodies → None; fire-and-forget by contract.
//!
//! **Production-library guard (Q8):** every mutating helper takes the library
//! id and REFUSES id 5 (`Doujins`, 5287 files) — tests additionally assert
//! its item count before/after. The delete path acts only on an EXACT series
//! match; "no exact hit" means skip-and-log, never "delete the first hit".

use serde_json::{json, Value};

use crate::nhentai::http::{RequestDef, Transport};

/// The production library id — REFUSED by every mutating helper (Q8).
pub const PRODUCTION_LIBRARY_ID: &str = "5";
/// Item-count cache lifetime (kavita-client.ts:127-133).
pub const ITEM_COUNT_CACHE_MS: i64 = 60_000;

/// The decrypted config (readConfig, :150-163).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct KavitaConfig {
    pub url: String,
    pub api_key: String,
    pub library_id: String,
}

impl KavitaConfig {
    /// readConfig: trim + trailing-slash strip on the URL. The decrypt
    /// boundary lives with the settings layer (app-level AES; Phase A reads
    /// plaintext passthrough).
    pub fn read(values: Option<(&str, &str, &str)>) -> Self {
        let (url, api_key, library_id) = values.unwrap_or(("", "", ""));
        KavitaConfig {
            url: url.trim().trim_end_matches('/').to_string(),
            api_key: api_key.trim().to_string(),
            library_id: library_id.trim().to_string(),
        }
    }

    /// isConfigured (:178-182): enabled AND url+key+libraryId present.
    pub fn is_configured(&self, enabled: bool) -> bool {
        enabled && !self.url.is_empty() && !self.api_key.is_empty() && !self.library_id.is_empty()
    }
}

/// translateToKavitaPath (:387-396): re-root the app-side path from
/// `libraryPath` onto `kavitaLibraryRoot` (two mounts, same files);
/// outside-root or missing roots → input unchanged; trailing slashes
/// stripped on all three inputs.
pub fn translate_to_kavita_path(path: &str, library_root: &str, kavita_library_root: &str) -> String {
    let path = path.trim_end_matches('/');
    let library_root = library_root.trim_end_matches('/');
    let kavita_root = kavita_library_root.trim_end_matches('/');
    if library_root.is_empty() || kavita_root.is_empty() {
        return path.to_string();
    }
    let Some(rest) = path.strip_prefix(library_root) else {
        return path.to_string();
    };
    let rest = rest.trim_start_matches('/');
    if rest.is_empty() {
        kavita_root.to_string()
    } else {
        format!("{kavita_root}/{rest}")
    }
}

/// The client over the shared transport trait (the reqwest impl carries the
/// 10 s timeout; replay transports answer from fixtures).
pub struct KavitaClient<'a, T: Transport> {
    pub transport: &'a T,
    pub config: KavitaConfig,
    item_count_cache: Option<(i64, i64)>, // (value, fetched_at)
}

/// testConnection's in-band result (:105-110) — never throws.
#[derive(Debug, Clone, PartialEq)]
pub struct KavitaTestResult {
    pub ok: bool,
    pub version: Option<String>,
    pub username: Option<String>,
}

type RawResponse = Result<Option<Value>, String>;

impl<'a, T: Transport> KavitaClient<'a, T> {
    pub fn new(transport: &'a T, config: KavitaConfig) -> Self {
        KavitaClient {
            transport,
            config,
            item_count_cache: None,
        }
    }

    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        url_override: Option<&str>,
        key_override: Option<&str>,
    ) -> RawResponse {
        let base = url_override.unwrap_or(&self.config.url).trim_end_matches('/');
        let key = key_override.unwrap_or(&self.config.api_key);
        if base.is_empty() || key.is_empty() {
            return Err("Kavita not configured".to_string());
        }
        let mut headers = vec![("x-api-key".to_string(), key.to_string())];
        let body_json = body.map(|b| {
            headers.push(("Content-Type".to_string(), "application/json".to_string()));
            serde_json::to_string(&b).unwrap_or_default()
        });
        let response = self.transport.send(&RequestDef {
            method: method.to_string(),
            url: format!("{base}{path}"),
            headers,
            body: body_json,
        })?;
        // Parse a JSON response body; throws on anything but a 2xx.
        if !(200..300).contains(&response.status) {
            return Err(format!("Kavita error {} {}", response.status, response.status_text));
        }
        if response.status == 204 || response.body.is_empty() {
            return Ok(None);
        }
        // Kavita answers with Content-Length on GETs; chunked bodies are
        // de-chunked here (HTTP/1.1, single-level).
        let body = dechunk(&response.body);
        serde_json::from_str(&body)
            .map(Some)
            .map_err(|e| format!("failed to parse JSON: {e}"))
    }

    /// testConnection (:255-272): in-band `{ok, version, username}`; never
    /// throws — unreachable hosts answer `{ok:false}`.
    pub fn test_connection(&self, url_override: Option<&str>, key_override: Option<&str>) -> KavitaTestResult {
        match self.request("GET", "/api/Account", None, url_override, key_override) {
            Ok(Some(v)) => KavitaTestResult {
                ok: v
                    .get("authenticated")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || v.get("ok").and_then(Value::as_bool).unwrap_or(true),
                version: v.get("version").and_then(Value::as_str).map(|s| s.to_string()),
                username: v.get("username").and_then(Value::as_str).map(|s| s.to_string()),
            },
            _ => KavitaTestResult {
                ok: false,
                version: None,
                username: None,
            },
        }
    }

    /// getLibraries (:281-297); failure → IPC envelope (Err).
    pub fn get_libraries(&self) -> Result<Vec<Value>, String> {
        match self.request("GET", "/api/Library/libraries", None, None, None)? {
            Some(Value::Array(a)) => Ok(a),
            Some(_) => Ok(Vec::new()),
            None => Ok(Vec::new()),
        }
    }

    /// getItemCount (:306-338): `chapterCount`; 60 s cache; never throws —
    /// null hides the status-bar figure.
    pub fn get_item_count(&mut self, now_ms: i64) -> Option<i64> {
        if !self.config.is_configured(true) {
            return None;
        }
        if let Some((value, at)) = self.item_count_cache {
            if now_ms - at < ITEM_COUNT_CACHE_MS {
                return Some(value);
            }
        }
        let value = match self.request("GET", "/api/Stats/server/stats", None, None, None) {
            Ok(Some(v)) => v.get("chapterCount").and_then(Value::as_i64),
            _ => None,
        };
        match value {
            Some(v) => {
                self.item_count_cache = Some((v, now_ms));
                Some(v)
            }
            None => None,
        }
    }

    /// markItemCountStale (:344-346) — invalidated by scans/deletes.
    pub fn invalidate_item_count(&mut self) {
        self.item_count_cache = None;
    }

    /// scanFolder (:356-376): POST with the key ALSO in the body; path
    /// translated first; fire-and-forget (errors swallowed, logged here).
    pub fn scan_folder(
        &mut self,
        folder_path: &str,
        library_root: &str,
        kavita_library_root: &str,
        log: &mut dyn FnMut(String),
    ) {
        if !self.config.is_configured(true) {
            return;
        }
        let kavita_path = translate_to_kavita_path(folder_path, library_root, kavita_library_root);
        let result = self.request(
            "POST",
            "/api/Library/scan-folder",
            Some(json!({ "folderPath": kavita_path, "apiKey": self.config.api_key })),
            None,
            None,
        );
        match result {
            Ok(_) => {
                self.invalidate_item_count();
                log(format!("requested a Kavita folder scan: {kavita_path}"));
            }
            Err(e) => log(format!("Kavita folder scan failed: {e}")),
        }
    }

    /// scanSeries (:403-419): fire-and-forget.
    pub fn scan_series(&mut self, series_id: i64, log: &mut dyn FnMut(String)) {
        if !self.config.is_configured(true) {
            return;
        }
        let result = self.request(
            "POST",
            "/api/Series/scan",
            Some(json!({ "seriesId": series_id, "libraryId": self.config.library_id })),
            None,
            None,
        );
        if let Err(e) = result {
            log(format!("Kavita series scan failed: {e}"));
        }
        self.invalidate_item_count();
    }

    /// searchSeries (:429-448): series array of the grouped response;
    /// failure → [].
    pub fn search_series(&self, query: &str) -> Vec<Value> {
        let url = format!(
            "/api/Search/search?queryString={}",
            crate::nhentai::http::urlencoded_encode(query)
        );
        match self.request("GET", &url, None, None, None) {
            Ok(Some(v)) => v
                .get("series")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    /// deleteSeries (:597-608): fire-and-forget.
    pub fn delete_series(&mut self, series_id: i64, log: &mut dyn FnMut(String)) {
        if !self.config.is_configured(true) {
            return;
        }
        let result = self.request("DELETE", &format!("/api/Series/{series_id}"), None, None, None);
        if let Err(e) = result {
            log(format!("Kavita delete failed: {e}"));
        }
        self.invalidate_item_count();
    }

    /// deleteMultipleSeries (:615-632): positive-integer filter, one call.
    pub fn delete_multiple_series(&mut self, ids: &[i64], log: &mut dyn FnMut(String)) {
        if !self.config.is_configured(true) {
            return;
        }
        let mut seen: Vec<i64> = Vec::new();
        for id in ids {
            if *id > 0 && !seen.contains(id) {
                seen.push(*id);
            }
        }
        if seen.is_empty() {
            return;
        }
        let result = self.request(
            "POST",
            "/api/Series/delete-multiple",
            Some(json!({ "seriesIds": seen })),
            None,
            None,
        );
        if let Err(e) = result {
            log(format!("Kavita batch delete failed: {e}"));
        }
        self.invalidate_item_count();
    }

    /// deleteItemsFromKavita (:650-708): search the title, require an EXACT
    /// case-insensitive name match — Kavita's search is substring, so "no
    /// exact hit" must mean skip-and-log, never "delete the first hit".
    pub fn delete_items_exact(&mut self, titles: &[&str], log: &mut dyn FnMut(String)) -> Vec<i64> {
        let mut deleted = Vec::new();
        for title in titles {
            if title.trim().is_empty() {
                continue;
            }
            let hits = self.search_series(title);
            let exact: Vec<i64> = hits
                .iter()
                .filter(|h| {
                    h.get("name")
                        .and_then(Value::as_str)
                        .map(|n| n.to_lowercase() == title.trim().to_lowercase())
                        .unwrap_or(false)
                })
                .filter_map(|h| h.get("id").and_then(Value::as_i64))
                .collect();
            if exact.is_empty() {
                log(format!("no exact Kavita match for {title:?}; skipped"));
                continue;
            }
            self.delete_multiple_series(&exact, log);
            deleted.extend(exact);
        }
        deleted
    }
}

/// De-chunk a possibly chunked HTTP body: `hexlen CRLF bytes CRLF ... 0`.
/// Plain (Content-Length) bodies pass through byte-identical.
pub fn dechunk(body: &str) -> String {
    let bytes = body.as_bytes();
    // Fast path: does not start with a hex length line.
    if bytes.len() < 4 {
        return body.to_string();
    }
    let mut out = Vec::new();
    let mut i = 0;
    let mut chunked = false;
    while i < bytes.len() {
        let mut j = i;
        while j < bytes.len() && bytes[j] != b'\r' {
            j += 1;
        }
        if j + 1 >= bytes.len() || bytes[j + 1] != b'\n' {
            break;
        }
        let Ok(len) = usize::from_str_radix(std::str::from_utf8(&bytes[i..j]).unwrap_or(""), 16)
        else {
            break;
        };
        chunked = true;
        i = j + 2;
        if len == 0 {
            break;
        }
        if i + len > bytes.len() {
            break;
        }
        out.extend_from_slice(&bytes[i..i + len]);
        i += len;
        if bytes.get(i..i + 2) == Some(b"\r\n") {
            i += 2;
        }
    }
    if chunked {
        String::from_utf8_lossy(&out).to_string()
    } else {
        body.to_string()
    }
}

/// The library-id guard the acceptance harness uses: refuse the production
/// library outright (Q8).
pub fn assert_not_production_library(library_id: &str) -> Result<(), String> {
    if library_id == PRODUCTION_LIBRARY_ID {
        return Err("refusing to mutate the production Kavita library (id 5)".to_string());
    }
    Ok(())
}
