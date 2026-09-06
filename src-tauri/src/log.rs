//! `logger.ts` port: levels, ring buffer, file rotation, retention, redaction.
//!
//! Semantics are verbatim 1.x (cited below); the structure differs in one
//! place: 1.x keeps a module singleton behind `DeferredLogger` (module-scope
//! `getLogger()` before init), while here [`AppState`](crate::state::AppState)
//! owns one `Logger` behind a `Mutex` — commands always run post-setup, so
//! the pre-init case cannot occur and the deferred/noop layers have nothing
//! to do. Observable behavior is identical.
//!
//! - Levels + priorities (`debug:0 info:1 warn:2 error:3`), default `info`.
//! - Ring buffer of the last 2000 records, chronological on read.
//! - Files `<logDir>/app.log`, JSON per line, rotation at 5 MB keeping 5
//!   (`app.1.log`…`app.5.log`), 14-day retention pruned at creation.
//! - Every `error` record gets an `errorId` unless one was provided.
//! - Redaction: `SENSITIVE_FIELDS` keys → `[REDACTED]`; registered secrets
//!   (length ≥ 8) scrubbed out of every string including substrings, depth
//!   cap 10; structural keys (`ts/level/scope/msg`) never overwritten.
//! - File writes are best-effort and never throw (the ring already has the
//!   record); rotation/retention failures are non-fatal.

use serde_json::{Map, Value};
use std::collections::{HashSet, VecDeque};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// `LogLevel` (`logger.ts:36`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
}

impl LogLevel {
    fn priority(self) -> u8 {
        match self {
            LogLevel::Debug => 0,
            LogLevel::Info => 1,
            LogLevel::Warn => 2,
            LogLevel::Error => 3,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Error => "error",
            LogLevel::Warn => "warn",
            LogLevel::Info => "info",
            LogLevel::Debug => "debug",
        }
    }

    pub fn parse(s: &str) -> Option<LogLevel> {
        match s {
            "error" => Some(LogLevel::Error),
            "warn" => Some(LogLevel::Warn),
            "info" => Some(LogLevel::Info),
            "debug" => Some(LogLevel::Debug),
            _ => None,
        }
    }
}

/// `LogRecord` (`logger.ts:44-53`): structural fields plus redacted extras,
/// serialized flat exactly like 1.x (`record[k] = v` merge).
#[derive(Debug, Clone, PartialEq)]
pub struct Record {
    pub ts: String,
    pub level: LogLevel,
    pub scope: String,
    pub msg: String,
    pub error_id: Option<String>,
    pub job_id: Option<String>,
    /// Redacted extra fields (never `ts/level/scope/msg`).
    pub extra: Map<String, Value>,
}

impl Record {
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("ts".to_string(), Value::String(self.ts.clone()));
        out.insert(
            "level".to_string(),
            Value::String(self.level.as_str().to_string()),
        );
        out.insert("scope".to_string(), Value::String(self.scope.clone()));
        out.insert("msg".to_string(), Value::String(self.msg.clone()));
        if let Some(id) = &self.error_id {
            out.insert("errorId".to_string(), Value::String(id.clone()));
        }
        if let Some(job) = &self.job_id {
            out.insert("jobId".to_string(), Value::String(job.clone()));
        }
        for (k, v) in &self.extra {
            out.insert(k.clone(), v.clone());
        }
        Value::Object(out)
    }
}

const DEFAULT_LEVEL: LogLevel = LogLevel::Info;
const DEFAULT_MAX_FILE_SIZE: u64 = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES: usize = 5;
const DEFAULT_RETENTION_DAYS: i64 = 14;
const DEFAULT_RING_SIZE: usize = 2000;

/// Field names whose values are always redacted (`logger.ts:124-135`).
const SENSITIVE_FIELDS: &[&str] = &[
    "apikey",
    "api_key",
    "key",
    "token",
    "authorization",
    "cookie",
    "password",
    "nhentai_api_key",
    "kavitaapikey",
    "kavita_api_key",
];

const REDACTED: &str = "[REDACTED]";

struct Shared {
    log_dir: PathBuf,
    level: LogLevel,
    max_file_size: u64,
    max_files: usize,
    retention_days: i64,
    ring: VecDeque<Record>,
    ring_size: usize,
    secrets: HashSet<String>,
    current_log_path: PathBuf,
    job_id: Option<String>,
}

/// Scoped logger handle. `Clone` shares the state (like 1.x scopes sharing
/// `SharedState`); `Send + Sync` so commands and pump threads share it.
#[derive(Clone)]
pub struct Logger {
    shared: Arc<Mutex<Shared>>,
    scope: String,
}

impl Logger {
    /// `createLogger()` (`logger.ts:478-509`): mkdir, retention prune, root
    /// scope `app`. `create_with_config` exposes the caps for tests (the
    /// `_getSharedStateForTest` equivalent without a global).
    pub fn create(log_dir: &Path) -> Result<Self, String> {
        Self::create_with_config(
            log_dir,
            DEFAULT_LEVEL,
            DEFAULT_MAX_FILE_SIZE,
            DEFAULT_MAX_FILES,
            DEFAULT_RETENTION_DAYS,
            DEFAULT_RING_SIZE,
        )
    }

    pub fn create_with_config(
        log_dir: &Path,
        level: LogLevel,
        max_file_size: u64,
        max_files: usize,
        retention_days: i64,
        ring_size: usize,
    ) -> Result<Self, String> {
        std::fs::create_dir_all(log_dir).map_err(|e| e.to_string())?;
        let shared = Shared {
            current_log_path: log_dir.join("app.log"),
            log_dir: log_dir.to_path_buf(),
            level,
            max_file_size,
            max_files,
            retention_days,
            ring: VecDeque::with_capacity(ring_size.min(1024)),
            ring_size,
            secrets: HashSet::new(),
            job_id: None,
        };
        let logger = Logger {
            shared: Arc::new(Mutex::new(shared)),
            scope: "app".to_string(),
        };
        logger.prune_retention();
        Ok(logger)
    }

    pub fn error(&self, msg: &str, fields: Option<Map<String, Value>>) {
        self.emit(LogLevel::Error, msg, fields);
    }

    pub fn warn(&self, msg: &str, fields: Option<Map<String, Value>>) {
        self.emit(LogLevel::Warn, msg, fields);
    }

    pub fn info(&self, msg: &str, fields: Option<Map<String, Value>>) {
        self.emit(LogLevel::Info, msg, fields);
    }

    pub fn debug(&self, msg: &str, fields: Option<Map<String, Value>>) {
        self.emit(LogLevel::Debug, msg, fields);
    }

    /// `scope()` (`logger.ts:240-243`): `app` → bare name, else `parent:name`.
    pub fn scope(&self, name: &str) -> Logger {
        let scope = if self.scope == "app" {
            name.to_string()
        } else {
            format!("{}:{name}", self.scope)
        };
        Logger {
            shared: Arc::clone(&self.shared),
            scope,
        }
    }

    /// `getRingBuffer()` — chronological, oldest first (`logger.ts:245-255`).
    pub fn ring_buffer(&self) -> Vec<Record> {
        self.shared
            .lock()
            .map(|s| s.ring.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn set_level(&self, level: LogLevel) {
        if let Ok(mut s) = self.shared.lock() {
            s.level = level;
        }
    }

    pub fn level(&self) -> LogLevel {
        self.shared.lock().map(|s| s.level).unwrap_or(DEFAULT_LEVEL)
    }

    /// `logDir` for `log:openFolder` (B3 opener plugin); allow-listed until then.
    #[allow(dead_code)]
    pub fn log_dir(&self) -> PathBuf {
        self.shared
            .lock()
            .map(|s| s.log_dir.clone())
            .unwrap_or_default()
    }

    pub fn retention_days(&self) -> i64 {
        self.shared
            .lock()
            .map(|s| s.retention_days)
            .unwrap_or(DEFAULT_RETENTION_DAYS)
    }

    pub fn set_retention_days(&self, days: i64) {
        if let Ok(mut s) = self.shared.lock() {
            s.retention_days = days;
        }
    }

    /// `registerSecret()` (`logger.ts:265-269`). First caller is
    /// `auth:setKey` (next namespace batch); allow-listed until then.
    #[allow(dead_code)]
    pub fn register_secret(&self, value: &str) {
        if value.is_empty() {
            return;
        }
        if let Ok(mut s) = self.shared.lock() {
            s.secrets.insert(value.to_string());
        }
    }

    /// `setJobId()` (`logger.ts:271-273`). First callers are the convert/sync
    /// pump commands; allow-listed until then.
    #[allow(dead_code)]
    pub fn set_job_id(&self, job_id: &str) {
        if let Ok(mut s) = self.shared.lock() {
            s.job_id = Some(job_id.to_string());
        }
    }

    /// `writeRecord()` (`logger.ts:290-324`): the trust boundary for
    /// records built elsewhere (envelope outcomes, pump threads). Validates
    /// structure, applies the level filter, redacts, and mints an errorId
    /// for errors — exactly like `emit()`.
    pub fn write_record(&self, value: &Value) {
        let obj = match value.as_object() {
            Some(o) => o,
            None => return,
        };
        let level = obj
            .get("level")
            .and_then(|v| v.as_str())
            .and_then(LogLevel::parse)
            .unwrap_or(LogLevel::Info);
        let Ok(shared) = self.shared.lock() else {
            return;
        };
        if level.priority() < shared.level.priority() {
            return;
        }
        let secrets = shared.secrets.clone();
        let job_default = shared.job_id.clone();
        drop(shared);

        let str_field = |k: &str| obj.get(k).and_then(|v| v.as_str()).unwrap_or("");
        let ts = obj
            .get("ts")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(now_iso);
        let scope = {
            let s = str_field("scope");
            if s.is_empty() {
                "worker".to_string()
            } else {
                s.to_string()
            }
        };
        let msg = scrub_secrets(str_field("msg").to_string(), &secrets);
        let error_id = obj
            .get("errorId")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let job_id = obj
            .get("jobId")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or(job_default);

        // One redact pass over the whole extras object (logger.ts:310-314):
        // top-level sensitive keys are replaced, not just scrubbed.
        let mut raw_extra = Map::new();
        for (k, v) in obj {
            if k == "ts"
                || k == "level"
                || k == "scope"
                || k == "msg"
                || k == "errorId"
                || k == "jobId"
            {
                continue;
            }
            raw_extra.insert(k.clone(), v.clone());
        }
        let extra = redact_map(raw_extra, &secrets, 0);
        // writeRecord redacts the forwarded shape wholesale (logger.ts:308-314)
        // — no err normalization here, unlike emit().
        let mut record = Record {
            ts,
            level,
            scope,
            msg,
            error_id,
            job_id,
            extra,
        };
        if level == LogLevel::Error && record.error_id.is_none() {
            record.error_id = Some(crate::envelope::new_error_id());
        }
        self.push_record(record);
    }

    fn emit(&self, level: LogLevel, msg: &str, fields: Option<Map<String, Value>>) {
        let Ok(shared) = self.shared.lock() else {
            return;
        };
        if level.priority() < shared.level.priority() {
            return;
        }
        let secrets = shared.secrets.clone();
        let job_id = shared.job_id.clone();
        drop(shared);

        let mut record = Record {
            ts: now_iso(),
            level,
            scope: self.scope.clone(),
            msg: scrub_secrets(msg.to_string(), &secrets),
            error_id: None,
            job_id,
            extra: Map::new(),
        };
        if let Some(fields) = fields {
            // Normalize err first, then redact the whole map — 1.x order
            // (logger.ts:347-361): secrets inside err.stack get scrubbed too.
            let mut fields = fields;
            if let Some(err) = fields.remove("err") {
                fields.insert("err".to_string(), normalize_err(&err));
            }
            let redacted = redact_map(fields, &secrets, 0);
            for (k, v) in redacted {
                if k == "ts" || k == "level" || k == "scope" || k == "msg" {
                    continue;
                }
                record.extra.insert(k, v);
            }
        }
        if level == LogLevel::Error && record.error_id.is_none() {
            record.error_id = Some(crate::envelope::new_error_id());
        }
        self.push_record(record);
    }

    fn push_record(&self, record: Record) {
        let line = record.to_value().to_string() + "\n";
        let path = match self.shared.lock() {
            Ok(mut s) => {
                while s.ring.len() >= s.ring_size && s.ring_size > 0 {
                    s.ring.pop_front();
                }
                if s.ring_size > 0 {
                    s.ring.push_back(record);
                }
                s.current_log_path.clone()
            }
            Err(_) => return,
        };
        self.write_to_file(&path, &line);
    }

    fn write_to_file(&self, path: &Path, line: &str) {
        let needs_rotate = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
            >= self
                .shared
                .lock()
                .map(|s| s.max_file_size)
                .unwrap_or(DEFAULT_MAX_FILE_SIZE);
        if needs_rotate {
            self.rotate();
        }
        // Trap #2 (logger.ts:404-407): file failure must never throw or
        // recurse — the ring already has the record.
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = file.write_all(line.as_bytes());
        }
    }

    fn rotate(&self) {
        let Ok(s) = self.shared.lock() else { return };
        let dir = s.log_dir.clone();
        let current = s.current_log_path.clone();
        let max_files = s.max_files;
        drop(s);
        let shift = |i: usize| {
            let old = dir.join(format!("app.{i}.log"));
            let new = dir.join(format!("app.{}.log", i + 1));
            if old.exists() {
                if new.exists() {
                    let _ = std::fs::remove_file(&new);
                }
                let _ = std::fs::rename(&old, &new);
            }
        };
        if max_files > 1 {
            for i in (1..max_files).rev() {
                shift(i);
            }
        }
        let first = dir.join("app.1.log");
        if current.exists() {
            if first.exists() {
                let _ = std::fs::remove_file(&first);
            }
            let _ = std::fs::rename(&current, &first);
        }
    }

    fn prune_retention(&self) {
        let Ok(s) = self.shared.lock() else { return };
        let dir = s.log_dir.clone();
        let cutoff_ms = s.retention_days * 86_400_000;
        drop(s);
        let entries = std::fs::read_dir(&dir)
            .map(|r| r.collect::<Vec<_>>())
            .unwrap_or_default();
        // 1.x compares mtimeMs against Date.now() - days; port in the same
        // units via SystemTime (matches on any clock).
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        for entry in entries.into_iter().flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("app") || !name.ends_with(".log") {
                continue;
            }
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .and_then(|t| {
                    t.duration_since(std::time::UNIX_EPOCH)
                        .map_err(|_| std::io::Error::other("clock"))
                })
                .map(|d| (now_ms - d.as_millis() as i64) > cutoff_ms)
                .unwrap_or(false);
            if old {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// `Date.toISOString()` — UTC, millisecond precision always.
fn now_iso() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    kopibon_core::metadata::context::JsDate(ms).to_iso_string()
}

/// Remove every occurrence of each registered secret (length ≥ 8) from text
/// (`scrubSecrets`, logger.ts:148-157).
fn scrub_secrets(mut text: String, secrets: &HashSet<String>) -> String {
    if secrets.is_empty() {
        return text;
    }
    for secret in secrets {
        if secret.len() < 8 {
            continue;
        }
        if text.contains(secret) {
            text = text.replace(secret, REDACTED);
        }
    }
    text
}

/// Deep-redact a value (`redactValue`, logger.ts:166-192): sensitive keys →
/// `[REDACTED]`, secrets scrubbed from every string, depth cap 10.
fn redact_value(value: Value, secrets: &HashSet<String>, depth: u32) -> Value {
    if depth > 10 {
        return value;
    }
    match value {
        Value::String(s) => Value::String(scrub_secrets(s, secrets)),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|v| redact_value(v, secrets, depth + 1))
                .collect(),
        ),
        // Objects check keys at EVERY depth (logger.ts:178-188) — a secret
        // nested three levels deep is still replaced, not just scrubbed.
        Value::Object(map) => redact_object(map, secrets, depth),
        other => other,
    }
}

fn redact_map(
    map: Map<String, Value>,
    secrets: &HashSet<String>,
    depth: u32,
) -> Map<String, Value> {
    match redact_object(map, secrets, depth) {
        Value::Object(out) => out,
        _ => Map::new(),
    }
}

fn redact_object(map: Map<String, Value>, secrets: &HashSet<String>, depth: u32) -> Value {
    let mut out = Map::new();
    for (k, v) in map {
        if SENSITIVE_FIELDS.contains(&k.to_lowercase().as_str()) {
            out.insert(k, Value::String(REDACTED.to_string()));
        } else {
            out.insert(k.clone(), redact_value(v, secrets, depth + 1));
        }
    }
    Value::Object(out)
}

/// Normalize an `err` field (`logger.ts:347-357`): `{name, message, stack?}`.
/// Callers redact the normalized shape afterwards (emit order).
fn normalize_err(err: &Value) -> Value {
    let obj = err.as_object();
    let name = obj
        .and_then(|o| o.get("name"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Error");
    let message = obj
        .and_then(|o| o.get("message"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mut out = Map::new();
    out.insert("name".to_string(), Value::String(name.to_string()));
    out.insert("message".to_string(), Value::String(message.to_string()));
    if let Some(stack) = obj.and_then(|o| o.get("stack")).and_then(|v| v.as_str()) {
        out.insert("stack".to_string(), Value::String(stack.to_string()));
    }
    Value::Object(out)
}

/// `getRecords` JSON shape for the log viewer: the flat record values.
pub fn records_to_json(records: &[Record]) -> Value {
    Value::Array(records.iter().map(Record::to_value).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_logger() -> (Logger, tempfile_dir::TempDir) {
        let dir = tempfile_dir::TempDir::new().expect("tempdir");
        let logger = Logger::create(dir.path()).expect("logger");
        (logger, dir)
    }

    #[test]
    fn level_filter_drops_below_config() {
        let (logger, _dir) = test_logger();
        logger.debug("quiet", None);
        logger.info("kept", None);
        let ring = logger.ring_buffer();
        assert_eq!(ring.len(), 1);
        assert_eq!(ring[0].msg, "kept");
        logger.set_level(LogLevel::Debug);
        logger.debug("now kept", None);
        assert_eq!(logger.ring_buffer().len(), 2);
    }

    #[test]
    fn error_records_carry_error_ids() {
        let (logger, _dir) = test_logger();
        logger.error("boom", None);
        let ring = logger.ring_buffer();
        let id = ring[0].error_id.clone().expect("errorId minted");
        assert!(id.starts_with("E-"));
        assert_eq!(ring[0].to_value()["errorId"], json!(id));
    }

    #[test]
    fn redaction_covers_keys_and_secret_substrings() {
        let (logger, _dir) = test_logger();
        logger.register_secret("super-secret-key-123");
        let mut fields = Map::new();
        fields.insert("apiKey".to_string(), json!("hunter2hunter2"));
        fields.insert(
            "url".to_string(),
            json!("https://x.test/?k=super-secret-key-123"),
        );
        fields.insert("n".to_string(), json!(1));
        // Sensitive keys are replaced at EVERY depth (logger.ts:178-188).
        fields.insert(
            "nested".to_string(),
            json!({"deep": {"token": "abc", "ok": 1}}),
        );
        logger.warn("check", Some(fields));
        let ring = logger.ring_buffer();
        let v = ring[0].to_value();
        assert_eq!(v["apiKey"], json!("[REDACTED]"));
        assert_eq!(v["url"], json!("https://x.test/?k=[REDACTED]"));
        assert_eq!(v["n"], json!(1));
        assert_eq!(
            v["nested"],
            json!({"deep": {"token": "[REDACTED]", "ok": 1}})
        );
    }

    #[test]
    fn structural_keys_win_over_user_fields() {
        let (logger, _dir) = test_logger();
        let mut fields = Map::new();
        fields.insert("msg".to_string(), json!("evil"));
        fields.insert("scope".to_string(), json!("evil"));
        logger.info("good", Some(fields));
        let ring = logger.ring_buffer();
        assert_eq!(ring[0].msg, "good");
        assert_eq!(ring[0].scope, "app");
    }

    #[test]
    fn ring_is_bounded_and_chronological() {
        let dir = tempfile_dir::TempDir::new().expect("tempdir");
        let logger = Logger::create_with_config(dir.path(), LogLevel::Debug, u64::MAX, 1, 365, 5)
            .expect("logger");
        for i in 0..8 {
            logger.info(&format!("m{i}"), None);
        }
        let ring = logger.ring_buffer();
        assert_eq!(ring.len(), 5);
        assert_eq!(ring[0].msg, "m3");
        assert_eq!(ring[4].msg, "m7");
    }

    #[test]
    fn rotation_keeps_bounded_files() {
        let dir = tempfile_dir::TempDir::new().expect("tempdir");
        // Tiny cap forces rotation on nearly every record.
        let logger = Logger::create_with_config(dir.path(), LogLevel::Debug, 64, 2, 365, 2000)
            .expect("logger");
        for i in 0..20 {
            logger.info(
                &format!("record number {i} with padding to force growth"),
                None,
            );
        }
        let mut names: Vec<String> = std::fs::read_dir(dir.path())
            .expect("readdir")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["app.1.log", "app.2.log", "app.log"]);
        // Every line in every file is a complete JSON record.
        for name in &names {
            let text = std::fs::read_to_string(dir.path().join(name)).expect("read");
            for line in text.lines() {
                let v: Value = serde_json::from_str(line).expect("json line");
                assert!(v.get("ts").is_some() && v.get("msg").is_some());
            }
        }
    }

    #[test]
    fn retention_prunes_old_logs() {
        let dir = tempfile_dir::TempDir::new().expect("tempdir");
        let stale = dir.path().join("app.9.log");
        std::fs::write(&stale, "old\n").expect("write");
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(30 * 86_400);
        filetime_set_mtime(&stale, old);
        Logger::create_with_config(dir.path(), LogLevel::Debug, u64::MAX, 5, 14, 2000)
            .expect("logger");
        assert!(
            !stale.exists(),
            "14-day retention prunes 30-day-old app log"
        );
    }

    #[test]
    fn write_record_validates_and_redacts() {
        let (logger, _dir) = test_logger();
        logger.register_secret("credential-abc-123");
        logger.write_record(&json!({
            "level": "bogus",
            "scope": "",
            "msg": "leak credential-abc-123 here",
            "api_key": "whatever",
        }));
        let ring = logger.ring_buffer();
        assert_eq!(ring.len(), 1);
        // Bogus level falls back to info (passes the default filter).
        assert_eq!(ring[0].level, LogLevel::Info);
        // Empty scope becomes worker; secrets + keys redacted.
        assert_eq!(ring[0].scope, "worker");
        let v = ring[0].to_value();
        assert_eq!(v["msg"], json!("leak [REDACTED] here"));
        assert_eq!(v["api_key"], json!("[REDACTED]"));
    }

    #[test]
    fn scope_nesting_matches_1x() {
        let (logger, _dir) = test_logger();
        assert_eq!(logger.scope("library").scope, "library");
        assert_eq!(logger.scope("a").scope("b").scope, "a:b");
    }

    // -- test helpers (no new deps): mtime setter via libc-free utimensat --

    mod tempfile_dir {
        use std::path::{Path, PathBuf};
        pub struct TempDir {
            path: PathBuf,
        }
        impl TempDir {
            pub fn new() -> std::io::Result<Self> {
                let path = std::env::temp_dir().join(format!(
                    "kopibon-log-test-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_nanos())
                        .unwrap_or(0)
                ));
                std::fs::create_dir_all(&path)?;
                Ok(TempDir { path })
            }
            pub fn path(&self) -> &Path {
                &self.path
            }
        }
        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.path);
            }
        }
    }

    fn filetime_set_mtime(path: &Path, mtime: std::time::SystemTime) {
        // utimensat via /proc-free libc call: use std-only fallback through
        // `std::process::Command("touch")` — touch(1) is POSIX baseline.
        let secs = mtime
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_else(|_| "0".to_string());
        let status = std::process::Command::new("touch")
            .args(["-d", &format!("@{secs}"), &path.to_string_lossy()])
            .status();
        assert!(
            status.map(|s| s.success()).unwrap_or(false),
            "touch -d mtime"
        );
    }
}
