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

    /// getSeries (:456-492): one series' detail. Never throws; `None` when
    /// unconfigured, unreachable, or gone.
    pub fn get_series(&self, series_id: i64) -> Option<SeriesDetail> {
        let s = self
            .request("GET", &format!("/api/Series/{series_id}"), None, None, None)
            .ok()??;
        let str_or_empty = |key: &str| {
            s.get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        Some(SeriesDetail {
            id: s.get("id").and_then(Value::as_i64).unwrap_or(series_id),
            name: str_or_empty("name"),
            library_id: s.get("libraryId").and_then(Value::as_i64).unwrap_or(0),
            library_name: str_or_empty("libraryName"),
            page_count: s.get("pages").and_then(Value::as_i64).unwrap_or(0),
            format: s
                .get("format")
                .and_then(Value::as_i64)
                .map(manga_format_name)
                .unwrap_or("Unknown")
                .to_string(),
            last_updated: s
                .get("lastChapterAdded")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(str::to_string),
            pages_read: s.get("pagesRead").and_then(Value::as_i64),
            total_reads: s.get("totalReads").and_then(Value::as_i64),
            chapter_id: None,
            chapter_title: None,
            chapter_count: None,
        })
    }

    /// findChapter (:544-589): the chapter owning a file. The file's
    /// basename (either separator — Kavita reports Windows paths) matches
    /// case-insensitively; the chapter count spans ALL volumes even after
    /// the match is found (the count loop is not gated on `!match`).
    pub fn find_chapter(&self, series_id: i64, file_path: &str) -> Option<ChapterRef> {
        let needle = file_path
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or_default()
            .to_lowercase();
        let volumes = self
            .request(
                "GET",
                &format!("/api/Series/volumes?seriesId={series_id}"),
                None,
                None,
                None,
            )
            .ok()??;
        let volumes = volumes.as_array()?;
        let mut chapter_count = 0i64;
        let mut found: Option<(i64, Option<String>)> = None;
        for volume in volumes {
            let chapters: &[Value] = volume
                .get("chapters")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            chapter_count += chapters.len() as i64;
            if found.is_none() {
                for chapter in chapters {
                    let files: &[Value] = chapter
                        .get("files")
                        .and_then(Value::as_array)
                        .map(Vec::as_slice)
                        .unwrap_or(&[]);
                    for file in files {
                        let candidate = file
                            .get("filePath")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .rsplit(['/', '\\'])
                            .next()
                            .unwrap_or_default()
                            .to_lowercase();
                        if !candidate.is_empty() && candidate == needle {
                            found = Some((
                                chapter.get("id").and_then(Value::as_i64).unwrap_or(0),
                                chapter
                                    .get("title")
                                    .and_then(Value::as_str)
                                    .filter(|t| !t.is_empty())
                                    .map(str::to_string),
                            ));
                            break;
                        }
                    }
                    if found.is_some() {
                        break;
                    }
                }
            }
        }
        found.map(|(id, title)| ChapterRef {
            id,
            title,
            chapter_count,
        })
    }

    /// findSeriesDetail (:500-535): series name first (a member is indexed
    /// under the series name, not the chapter title), item title as
    /// fallback; exact case-insensitive match preferred over first hit;
    /// chapter resolution when a file path is given. Never throws.
    pub fn find_series_detail(
        &self,
        series_name: &str,
        title: &str,
        file_path: Option<&str>,
    ) -> Option<SeriesDetail> {
        let name = series_name.trim();
        let mut results = if name.is_empty() {
            Vec::new()
        } else {
            self.search_series(name)
        };
        let fallback = title.trim();
        if results.is_empty() && !fallback.is_empty() {
            results = self.search_series(fallback);
        }
        if results.is_empty() {
            return None;
        }
        let target = if !name.is_empty() { name } else { fallback }.to_lowercase();
        let best = results
            .iter()
            .find(|r| {
                r.get("name")
                    .and_then(Value::as_str)
                    .map(|n| n.to_lowercase() == target)
                    .unwrap_or(false)
            })
            .or_else(|| results.first())?;
        // The core's search_series returns the raw response items
        // (`seriesId`, `name`) — 1.x maps to `{id, name}` first
        // (:437-440); accept both shapes here.
        let series_id = best
            .get("seriesId")
            .and_then(Value::as_i64)
            .or_else(|| best.get("id").and_then(Value::as_i64))?;
        let mut detail = self.get_series(series_id)?;
        if let Some(path) = file_path {
            if let Some(chapter) = self.find_chapter(series_id, path) {
                detail.chapter_id = Some(chapter.id);
                detail.chapter_title = chapter.title;
                detail.chapter_count = Some(chapter.chapter_count);
            }
        }
        Some(detail)
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

/// `LIBRARY_TYPE_NAMES` (kavita-client.ts:46-53): 0 Manga · 1 Comic · 2
/// Book · 3 Image · 4 Light Novel · 5 Comic. Unknown codes → '' (the
/// `?? ''` fallback in `getLibraries`).
pub fn library_type_name(code: i64) -> &'static str {
    match code {
        0 => "Manga",
        1 => "Comic",
        2 => "Book",
        3 => "Image",
        4 => "Light Novel",
        5 => "Comic",
        _ => "",
    }
}

/// `MANGA_FORMAT_NAMES` (kavita-client.ts:59-65): 0 Image · 1 Archive · 2
/// Unknown · 3 EPUB · 4 PDF. Unknown codes → 'Unknown'.
pub fn manga_format_name(code: i64) -> &'static str {
    match code {
        0 => "Image",
        1 => "Archive",
        2 => "Unknown",
        3 => "EPUB",
        4 => "PDF",
        _ => "Unknown",
    }
}

/// `KavitaSeriesDetail` (kavita-client.ts:67-97). Optional fields are
/// `None` when absent — the IPC layer omits them (structured clone drops
/// 1.x's `undefined` the same way).
#[derive(Debug, Clone, PartialEq)]
pub struct SeriesDetail {
    pub id: i64,
    pub name: String,
    pub library_id: i64,
    pub library_name: String,
    pub page_count: i64,
    pub format: String,
    pub last_updated: Option<String>,
    pub pages_read: Option<i64>,
    pub total_reads: Option<i64>,
    pub chapter_id: Option<i64>,
    pub chapter_title: Option<String>,
    pub chapter_count: Option<i64>,
}

impl SeriesDetail {
    /// Envelope-ready JSON: `None` fields are omitted, never `null`
    /// (1.x leaves them `undefined`, which does not survive the clone).
    pub fn to_value(&self) -> Value {
        let mut out = serde_json::Map::new();
        out.insert("id".to_string(), json!(self.id));
        out.insert("name".to_string(), json!(self.name));
        out.insert("libraryId".to_string(), json!(self.library_id));
        out.insert("libraryName".to_string(), json!(self.library_name));
        out.insert("pageCount".to_string(), json!(self.page_count));
        out.insert("format".to_string(), json!(self.format.clone()));
        if let Some(v) = &self.last_updated {
            out.insert("lastUpdated".to_string(), json!(v));
        }
        if let Some(v) = self.pages_read {
            out.insert("pagesRead".to_string(), json!(v));
        }
        if let Some(v) = self.total_reads {
            out.insert("totalReads".to_string(), json!(v));
        }
        if let Some(v) = self.chapter_id {
            out.insert("chapterId".to_string(), json!(v));
        }
        if let Some(v) = &self.chapter_title {
            out.insert("chapterTitle".to_string(), json!(v));
        }
        if let Some(v) = self.chapter_count {
            out.insert("chapterCount".to_string(), json!(v));
        }
        Value::Object(out)
    }
}

/// A chapter hit for the reader-link resolution.
#[derive(Debug, Clone, PartialEq)]
pub struct ChapterRef {
    pub id: i64,
    pub title: Option<String>,
    pub chapter_count: i64,
}

/// The library-id guard the acceptance harness uses: refuse the production
/// library outright (Q8).
pub fn assert_not_production_library(library_id: &str) -> Result<(), String> {
    if library_id == PRODUCTION_LIBRARY_ID {
        return Err("refusing to mutate the production Kavita library (id 5)".to_string());
    }
    Ok(())
}
