//! Command implementations, one function per channel plus the thin Tauri
//! wrapper. Pattern (every namespace follows it):
//!
//! ```ignore
//! // Pure logic: directly unit-tested with a scratch AppState.
//! pub(crate) fn cmd(state: &AppState, args: &[Value], log: &mut LogSink)
//!     -> Result<Value, CommandError>
//!
//! // Dumb wrapper: envelope + stderr mirror. Too small to misbehave;
//! // B2's contract suite drives the wrapper through the real invoke loop.
//! #[tauri::command(rename = "namespace:channel")]
//! fn channel_name(state: State<AppState>, args: Vec<Value>) -> Value { … }
//! ```
//!
//! The `rename` is LOAD-BEARING: the bridge invokes the Electron channel
//! string (`invoke('library:getAll', …)`), and without it Tauri registers
//! the Rust snake_case fn name — every call misses. The `handle()` channel
//! label and the rename must be identical.
//!
//! Arg encoding: the bridge sends `{args:[...]}` positionally (bridge.ts) —
//! each command indexes its params and treats JSON null as absent, matching
//! the preload's `?? default` idioms.

pub mod api;
pub mod app;
pub mod auth;
pub mod download;
pub mod kavita;
pub mod log;
pub mod search;
pub mod settings;
pub mod shell;
pub mod updater;

use serde_json::Value;

use crate::envelope::LogRecord;
use crate::state::AppState;

/// Forward envelope log lines into the app logger under the command's scope
/// (replaces the B2a stderr mirror — the file+ring logger has landed).
pub(crate) fn forward(state: &AppState, channel: &str, logs: Vec<LogRecord>) {
    let logger = state.logger.scope(channel);
    for record in logs {
        // Envelope records carry `message`; the logger's structural key is
        // `msg` — mapped here, everything else passes through (write_record
        // re-validates, re-redacts and preserves errorIds).
        let mut value = serde_json::Map::new();
        value.insert("level".to_string(), Value::String(record.level.to_string()));
        value.insert("scope".to_string(), Value::String(record.scope));
        value.insert("msg".to_string(), Value::String(record.message));
        for (k, v) in record.fields.as_object().cloned().unwrap_or_default() {
            value.insert(k, v);
        }
        logger.write_record(&Value::Object(value));
    }
}
