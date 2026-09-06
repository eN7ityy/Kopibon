//! `shell:*` + `dialog:*` commands (02-ipc-surface §2.3–2.4,
//! `auth.ipc.ts:139-196`).
//!
//! Electron `shell` → `tauri-plugin-opener`, `dialog.showOpenDialog` →
//! `tauri-plugin-dialog` (blocking picks — Tauri sync commands run off the
//! main thread, so blocking is correct here). Shapes are verbatim:
//! - `shell:*` resolve bare `null` (1.x handlers return `undefined`);
//!   opener failures THROW (the 1.x `await shell.…` rejection propagates
//!   through `handle()` the same way).
//! - `dialog:*` return `{success:true, data: path|null}` (cancel → null);
//!   the 1.x "No window found" soft-fail has no Tauri equivalent (dialogs
//!   are app-modal, no per-window lookup) and is not reproduced.
//! - `dialog:openFile` defaults to the PDF filter when the arg is absent;
//!   a caller-supplied filter list (even empty) wins (`options?.filters
//!   || […]` — `||`, so only absent/null falls back).
//!
//! [`ShellOps`] abstracts the OS calls so the arg mapping and defaults are
//! unit-tested without opening windows.

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::envelope::{handle, CommandError, LogSink};
use crate::state::AppState;

use super::forward;

/// A file-type filter: `{name, extensions}` (preload shape).
#[derive(Debug, Clone, PartialEq)]
pub struct DialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// The 1.x default (`auth.ipc.ts:167-169`).
pub fn default_file_filters() -> Vec<DialogFilter> {
    vec![DialogFilter {
        name: "PDF Files".to_string(),
        extensions: vec!["pdf".to_string()],
    }]
}

/// Parse the `({filters?})` arg: absent/null/non-object → default; a
/// present `filters` array (even empty) wins. Malformed entries fall back
/// to the default — the renderer only ever sends well-formed filters.
fn parse_file_filters(args: &[Value]) -> Vec<DialogFilter> {
    let Some(obj) = args.first().and_then(|v| v.as_object()) else {
        return default_file_filters();
    };
    let Some(list) = obj.get("filters").and_then(|v| v.as_array()) else {
        return default_file_filters();
    };
    let mut out = Vec::new();
    for entry in list {
        let name = entry.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let extensions: Vec<String> = entry
            .get("extensions")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        if name.is_empty() || extensions.is_empty() {
            return default_file_filters();
        }
        out.push(DialogFilter {
            name: name.to_string(),
            extensions,
        });
    }
    out
}

/// OS backend for the five channels. The real impl drives the Tauri
/// plugins; tests use a scripted fake.
pub trait ShellOps {
    fn open_url(&self, url: &str) -> Result<(), String>;
    fn open_path(&self, path: &str) -> Result<(), String>;
    fn reveal_in_dir(&self, path: &str) -> Result<(), String>;
    fn pick_file(&self, filters: &[DialogFilter]) -> Result<Option<String>, String>;
    fn pick_dir(&self, default_path: Option<&str>) -> Result<Option<String>, String>;
}

/// Real backend over `tauri-plugin-opener` + `tauri-plugin-dialog`.
pub struct TauriShell {
    app: AppHandle,
}

impl TauriShell {
    pub fn new(app: AppHandle) -> Self {
        TauriShell { app }
    }
}

fn file_path_to_string(path: tauri_plugin_dialog::FilePath) -> String {
    match path {
        tauri_plugin_dialog::FilePath::Path(p) => p.to_string_lossy().to_string(),
        tauri_plugin_dialog::FilePath::Url(url) => url.to_string(),
    }
}

impl ShellOps for TauriShell {
    fn open_url(&self, url: &str) -> Result<(), String> {
        use tauri_plugin_opener::OpenerExt;
        self.app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| e.to_string())
    }

    fn open_path(&self, path: &str) -> Result<(), String> {
        use tauri_plugin_opener::OpenerExt;
        self.app
            .opener()
            .open_path(path, None::<&str>)
            .map_err(|e| e.to_string())
    }

    fn reveal_in_dir(&self, path: &str) -> Result<(), String> {
        use tauri_plugin_opener::OpenerExt;
        self.app
            .opener()
            .reveal_item_in_dir(path)
            .map_err(|e| e.to_string())
    }

    fn pick_file(&self, filters: &[DialogFilter]) -> Result<Option<String>, String> {
        use tauri_plugin_dialog::DialogExt;
        let mut builder = self.app.dialog().file();
        for filter in filters {
            let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
            builder = builder.add_filter(&filter.name, &extensions);
        }
        Ok(builder.blocking_pick_file().map(file_path_to_string))
    }

    fn pick_dir(&self, default_path: Option<&str>) -> Result<Option<String>, String> {
        use tauri_plugin_dialog::DialogExt;
        let builder = self.app.dialog().file();
        let builder = match default_path {
            Some(dir) => builder.set_directory(dir),
            None => builder,
        };
        Ok(builder.blocking_pick_folder().map(file_path_to_string))
    }
}

/// `shell:openExternal` (`auth.ipc.ts:142-144`).
pub(crate) fn open_external_impl<S: ShellOps>(
    shell: &S,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let url = args.first().and_then(|v| v.as_str()).unwrap_or("");
    shell.open_url(url).map_err(CommandError::Thrown)?;
    Ok(Value::Null)
}

/// `shell:openPath` (`auth.ipc.ts:146-148`).
pub(crate) fn open_path_impl<S: ShellOps>(
    shell: &S,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let path = args.first().and_then(|v| v.as_str()).unwrap_or("");
    shell.open_path(path).map_err(CommandError::Thrown)?;
    Ok(Value::Null)
}

/// `shell:showItemInFolder` (`auth.ipc.ts:150-152`).
pub(crate) fn show_item_impl<S: ShellOps>(
    shell: &S,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let path = args.first().and_then(|v| v.as_str()).unwrap_or("");
    shell.reveal_in_dir(path).map_err(CommandError::Thrown)?;
    Ok(Value::Null)
}

/// `dialog:openFile` (`auth.ipc.ts:156-178`).
pub(crate) fn open_file_impl<S: ShellOps>(
    shell: &S,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let filters = parse_file_filters(args);
    let picked = shell.pick_file(&filters).map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": picked }))
}

/// `dialog:openDirectory` (`auth.ipc.ts:179-195`): starts where the caller
/// already points; an unreadable/missing path is the plugin's problem, not
/// a failure (Electron ignores it rather than failing — `:186-187`).
pub(crate) fn open_dir_impl<S: ShellOps>(
    shell: &S,
    args: &[Value],
    _log: &mut LogSink,
) -> Result<Value, CommandError> {
    let default_path = args.first().and_then(|v| v.as_str());
    let picked = shell.pick_dir(default_path).map_err(CommandError::Thrown)?;
    Ok(json!({ "success": true, "data": picked }))
}

#[tauri::command(rename = "shell:openExternal")]
pub(crate) fn shell_open_external(
    app: AppHandle,
    state: State<AppState>,
    args: Vec<Value>,
) -> Value {
    let shell = TauriShell::new(app);
    let outcome = handle("shell:openExternal", |log| {
        open_external_impl(&shell, &args, log)
    });
    forward(&state, "shell:openExternal", outcome.logs);
    outcome.value
}

#[tauri::command(rename = "shell:openPath")]
pub(crate) fn shell_open_path(app: AppHandle, state: State<AppState>, args: Vec<Value>) -> Value {
    let shell = TauriShell::new(app);
    let outcome = handle("shell:openPath", |log| open_path_impl(&shell, &args, log));
    forward(&state, "shell:openPath", outcome.logs);
    outcome.value
}

#[tauri::command(rename = "shell:showItemInFolder")]
pub(crate) fn shell_show_item_in_folder(
    app: AppHandle,
    state: State<AppState>,
    args: Vec<Value>,
) -> Value {
    let shell = TauriShell::new(app);
    let outcome = handle("shell:showItemInFolder", |log| {
        show_item_impl(&shell, &args, log)
    });
    forward(&state, "shell:showItemInFolder", outcome.logs);
    outcome.value
}

#[tauri::command(rename = "dialog:openFile")]
pub(crate) fn dialog_open_file(app: AppHandle, state: State<AppState>, args: Vec<Value>) -> Value {
    let shell = TauriShell::new(app);
    let outcome = handle("dialog:openFile", |log| open_file_impl(&shell, &args, log));
    forward(&state, "dialog:openFile", outcome.logs);
    outcome.value
}

#[tauri::command(rename = "dialog:openDirectory")]
pub(crate) fn dialog_open_directory(
    app: AppHandle,
    state: State<AppState>,
    args: Vec<Value>,
) -> Value {
    let shell = TauriShell::new(app);
    let outcome = handle("dialog:openDirectory", |log| {
        open_dir_impl(&shell, &args, log)
    });
    forward(&state, "dialog:openDirectory", outcome.logs);
    outcome.value
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Scripted fake: records calls, replays picks.
    struct FakeShell {
        calls: Mutex<Vec<(String, String)>>,
        filters_seen: Mutex<Vec<Vec<DialogFilter>>>,
        pick_file_result: Option<String>,
        pick_dir_result: Option<String>,
        fail_with: Option<String>,
    }

    impl FakeShell {
        fn new() -> Self {
            FakeShell {
                calls: Mutex::new(Vec::new()),
                filters_seen: Mutex::new(Vec::new()),
                pick_file_result: Some("/picked/file.pdf".to_string()),
                pick_dir_result: Some("/picked/dir".to_string()),
                fail_with: None,
            }
        }

        fn record(&self, op: &str, arg: &str) -> Result<(), String> {
            self.calls
                .lock()
                .expect("lock")
                .push((op.to_string(), arg.to_string()));
            match &self.fail_with {
                Some(message) => Err(message.clone()),
                None => Ok(()),
            }
        }
    }

    impl ShellOps for FakeShell {
        fn open_url(&self, url: &str) -> Result<(), String> {
            self.record("open_url", url)
        }
        fn open_path(&self, path: &str) -> Result<(), String> {
            self.record("open_path", path)
        }
        fn reveal_in_dir(&self, path: &str) -> Result<(), String> {
            self.record("reveal", path)
        }
        fn pick_file(&self, filters: &[DialogFilter]) -> Result<Option<String>, String> {
            self.filters_seen
                .lock()
                .expect("lock")
                .push(filters.to_vec());
            Ok(self.pick_file_result.clone())
        }
        fn pick_dir(&self, default_path: Option<&str>) -> Result<Option<String>, String> {
            self.record("pick_dir", default_path.unwrap_or_default())?;
            Ok(self.pick_dir_result.clone())
        }
    }

    fn sink() -> impl FnMut(crate::envelope::LogRecord) {
        |_: crate::envelope::LogRecord| {}
    }

    /// shell:* forward the single arg and resolve null.
    #[test]
    fn shell_channels_forward_arg_and_resolve_null() {
        let shell = FakeShell::new();
        let mut log = sink();
        assert_eq!(
            open_external_impl(&shell, &[json!("https://x.test/")], &mut log).expect("ok"),
            Value::Null
        );
        assert_eq!(
            open_path_impl(&shell, &[json!("/tmp/x")], &mut log).expect("ok"),
            Value::Null
        );
        assert_eq!(
            show_item_impl(&shell, &[json!("/tmp/x/f.pdf")], &mut log).expect("ok"),
            Value::Null
        );
        assert_eq!(
            *shell.calls.lock().expect("lock"),
            [
                ("open_url".to_string(), "https://x.test/".to_string()),
                ("open_path".to_string(), "/tmp/x".to_string()),
                ("reveal".to_string(), "/tmp/x/f.pdf".to_string()),
            ]
        );
    }

    /// Backend failure THROWS (the 1.x await rejection through handle()).
    #[test]
    fn shell_failure_throws() {
        let shell = FakeShell {
            fail_with: Some("no browser".to_string()),
            ..FakeShell::new()
        };
        let mut log = sink();
        assert_eq!(
            open_external_impl(&shell, &[json!("https://x.test/")], &mut log).expect_err("throws"),
            CommandError::Thrown("no browser".to_string())
        );
    }

    /// openFile without args uses the PDF default; cancel → null.
    #[test]
    fn open_file_defaults_and_cancel() {
        let shell = FakeShell::new();
        let mut log = sink();
        let out = open_file_impl(&shell, &[], &mut log).expect("ok");
        assert_eq!(out, json!({ "success": true, "data": "/picked/file.pdf" }));
        assert_eq!(
            *shell.filters_seen.lock().expect("lock"),
            [default_file_filters()]
        );

        let cancelled = FakeShell {
            pick_file_result: None,
            ..FakeShell::new()
        };
        let out = open_file_impl(&cancelled, &[], &mut log).expect("ok");
        assert_eq!(out, json!({ "success": true, "data": null }));
    }

    /// Caller-supplied filters win, even an empty list (`||` fallback).
    #[test]
    fn open_file_caller_filters_win() {
        let shell = FakeShell::new();
        let mut log = sink();
        let custom = json!({ "filters": [{ "name": "All", "extensions": ["*"] }] });
        open_file_impl(&shell, &[custom], &mut log).expect("ok");
        assert_eq!(
            *shell.filters_seen.lock().expect("lock"),
            [vec![DialogFilter {
                name: "All".to_string(),
                extensions: vec!["*".to_string()],
            }]]
        );
        let empty = json!({ "filters": [] });
        open_file_impl(&shell, &[empty], &mut log).expect("ok");
        assert_eq!(shell.filters_seen.lock().expect("lock").len(), 2);
        assert!(shell.filters_seen.lock().expect("lock")[1].is_empty());
    }

    /// openDirectory passes the start path through; absent → None.
    #[test]
    fn open_dir_passes_default_path() {
        let shell = FakeShell::new();
        let mut log = sink();
        let out = open_dir_impl(&shell, &[json!("/start/here")], &mut log).expect("ok");
        assert_eq!(out, json!({ "success": true, "data": "/picked/dir" }));
        assert_eq!(
            *shell.calls.lock().expect("lock"),
            [("pick_dir".to_string(), "/start/here".to_string())]
        );
        open_dir_impl(&shell, &[], &mut log).expect("ok");
        assert_eq!(
            shell.calls.lock().expect("lock").last(),
            Some(&("pick_dir".to_string(), String::new()))
        );
    }
}
