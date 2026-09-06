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
//! #[tauri::command]
//! fn channel_name(state: State<AppState>, args: Vec<Value>) -> Value { … }
//! ```
//!
//! Arg encoding: the bridge sends `{args:[...]}` positionally (bridge.ts) —
//! each command indexes its params and treats JSON null as absent, matching
//! the preload's `?? default` idioms.

pub mod app;
