//! Diagnostics bundle (`src/main/services/diagnostics.ts`).
//!
//! Built for bug reports — the one artifact expected to be handed to a
//! stranger — so two rules, enforced here rather than at the call site:
//! settings are an ALLOWLIST (a new setting is excluded until someone
//! decides it safe), and the finished TEXT is scrubbed (covers log
//! messages and stack traces no field walk anticipates).
//!
//! 2.x deviation (documented, not silent): `versions` carries
//! `{ tauri }` instead of `{ electron, chrome, node }` — there is no
//! Electron/Chromium/Node in this shell, and shipping those keys with
//! dead values would lie to whoever reads the report.

use serde_json::{json, Value};
use std::collections::BTreeMap;

/// Settings safe to include (`SAFE_SETTING_KEYS`, diagnostics.ts:61-79).
/// `searchDefaultQuery` is deliberately absent (user content, no
/// diagnostic value); the blocked list lives in its own table, never in
/// scope here.
pub const SAFE_SETTING_KEYS: [&str; 16] = [
    "outputFormat",
    "downloadConcurrency",
    "compressPdf",
    "compressionQuality",
    "pageSize",
    "blackBackground",
    "showNotifications",
    "cbzMangaDirection",
    "cbzKeepOriginal",
    "completedRetentionDays",
    "searchDefaultSort",
    "searchDefaultLanguage",
    "searchMinPages",
    "searchMinFavorites",
    "searchUploadedWithinDays",
    "searchRespectBlacklist",
];

pub const REDACTED: &str = "[REDACTED]";

/// Bundle input: already-gathered values (gathering touches DB/logger/fs
/// and lives with the command).
pub struct DiagnosticsInput {
    pub app_version: String,
    pub tauri_version: String,
    pub os_platform: String,
    pub os_arch: String,
    pub os_release: String,
    pub os_cpus: usize,
    pub os_total_mem_gb: u64,
    pub toolchain: Value,
    pub settings: BTreeMap<String, String>,
    pub library_item_count: i64,
    pub records: Vec<Value>,
    pub secrets: Vec<String>,
    pub redact_paths: bool,
    pub exported_at: String,
    pub home_dir: Option<String>,
}

/// `buildDiagnostics` (diagnostics.ts:132-158): pure, same input same
/// output. Settings filtered by the allowlist (sorted keys); anything
/// else is reported by key in `omittedSettings`.
pub fn build_diagnostics(input: &DiagnosticsInput) -> Value {
    let allowed: std::collections::HashSet<&str> = SAFE_SETTING_KEYS.into_iter().collect();
    let mut settings = serde_json::Map::new();
    let mut omitted = Vec::new();
    let mut keys: Vec<&String> = input.settings.keys().collect();
    keys.sort();
    for key in keys {
        if allowed.contains(key.as_str()) {
            settings.insert(key.clone(), Value::String(input.settings[key].clone()));
        } else {
            omitted.push(Value::String(key.clone()));
        }
    }
    json!({
        "exportedAt": input.exported_at,
        "app": { "version": input.app_version, "tauri": input.tauri_version },
        "os": {
            "platform": input.os_platform,
            "arch": input.os_arch,
            "release": input.os_release,
            "cpus": input.os_cpus,
            "totalMemGb": input.os_total_mem_gb,
        },
        "toolchain": input.toolchain,
        "settings": settings,
        "omittedSettings": omitted,
        "libraryItemCount": input.library_item_count,
        "recentRecords": input.records,
    })
}

/// `serializeDiagnostics` (diagnostics.ts:166-190): the finished string is
/// scrubbed — secrets (len ≥ 8; short values would match ordinary text)
/// plus their JSON-escaped form — then paths when asked.
pub fn serialize_diagnostics(input: &DiagnosticsInput) -> String {
    let bundle = build_diagnostics(input);
    let mut text = serde_json::to_string_pretty(&bundle).unwrap_or_default();
    for secret in &input.secrets {
        if secret.len() < 8 {
            continue;
        }
        if text.contains(secret) {
            text = text.split(secret).collect::<Vec<_>>().join(REDACTED);
        }
        // The JSON-escaped form, in case stringify altered quotes or
        // backslashes in the value.
        let escaped = json!(secret).as_str().unwrap_or_default().to_string();
        if escaped != *secret && text.contains(&escaped) {
            text = text.split(&escaped).collect::<Vec<_>>().join(REDACTED);
        }
    }
    if input.redact_paths {
        let library_path = input.settings.get("libraryPath").map(String::as_str);
        text = redact_paths(&text, input.home_dir.as_deref(), library_path);
    }
    text
}

/// `redactPaths` (diagnostics.ts:91-124): home + library dirs become
/// placeholders. Longest first (a library path under home must not be
/// half-replaced); JSON-doubled backslashes covered for Windows paths.
pub fn redact_paths(text: &str, home_dir: Option<&str>, library_path: Option<&str>) -> String {
    let mut rules: Vec<(&str, &str)> = Vec::new();
    if let Some(path) = library_path {
        if path.len() > 3 {
            rules.push((path, "<LIBRARY>"));
        }
    }
    if let Some(home) = home_dir {
        if home.len() > 3 {
            rules.push((home, "<HOME>"));
        }
    }
    rules.sort_by_key(|rule| std::cmp::Reverse(rule.0.len()));
    let mut out = text.to_string();
    for (needle, placeholder) in rules {
        if out.contains(needle) {
            out = out.split(needle).collect::<Vec<_>>().join(placeholder);
        }
        let escaped = needle.replace('\\', "\\\\");
        if escaped != needle && out.contains(&escaped) {
            out = out.split(&escaped).collect::<Vec<_>>().join(placeholder);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> DiagnosticsInput {
        DiagnosticsInput {
            app_version: "1.0.2".to_string(),
            tauri_version: "2.0.0".to_string(),
            os_platform: "linux".to_string(),
            os_arch: "x86_64".to_string(),
            os_release: "6.0".to_string(),
            os_cpus: 8,
            os_total_mem_gb: 16,
            toolchain: json!({}),
            settings: BTreeMap::from([
                ("outputFormat".to_string(), "cbz".to_string()),
                ("nhentai_api_key".to_string(), "SECRET".to_string()),
            ]),
            library_item_count: 3,
            records: vec![],
            secrets: vec!["SECRET-VALUE-123".to_string(), "short".to_string()],
            redact_paths: false,
            exported_at: "2026-01-01T00:00:00.000Z".to_string(),
            home_dir: None,
        }
    }

    /// Allowlist: safe keys in, everything else by-key in omittedSettings.
    #[test]
    fn allowlist_filters() {
        let bundle = build_diagnostics(&input());
        assert_eq!(bundle["settings"], json!({ "outputFormat": "cbz" }));
        assert_eq!(bundle["omittedSettings"], json!(["nhentai_api_key"]));
    }

    /// Secrets scrubbed wherever they appear (even inside messages);
    /// short values left alone.
    #[test]
    fn secrets_scrubbed_from_text() {
        let mut input = input();
        input.records = vec![json!({ "msg": "leak SECRET-VALUE-123 here and short" })];
        let text = serialize_diagnostics(&input);
        assert!(!text.contains("SECRET-VALUE-123"), "secret scrubbed");
        assert!(text.contains("short"), "short values untouched");
        assert!(text.contains(REDACTED));
    }

    /// Paths redacted longest-first.
    #[test]
    fn paths_redacted() {
        let out = redact_paths(
            "at /home/alice/lib/x and /home/alice/y",
            Some("/home/alice"),
            Some("/home/alice/lib"),
        );
        assert_eq!(out, "at <LIBRARY>/x and <HOME>/y");
    }
}
