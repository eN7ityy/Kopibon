#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Kopibon 2.x Tauri shell (Phase B).
//!
//! The React renderer is unchanged — `src/renderer/src/bridge.ts` rebuilds
//! the identical `window.api` over Tauri `invoke`/`listen`. B1 is the
//! scaffold: window config mirroring 1.x's `BrowserWindow` options
//! (`src/main/index.ts:22-38`) plus a `ping` smoke command. B2 adds
//! `commands/` (one module per namespace), `envelope.rs` (the `handle.ts`
//! port) and `events.rs`; B3 the plugins, bootstrap parity and polls→push.

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping])
        .run(tauri::generate_context!())
        .expect("failed to run kopibon");
}

/// Scaffold smoke command (B1 only): proves the invoke loop end to end.
/// B2's command layer (envelope + the 144 channels) supersedes this.
#[tauri::command]
fn ping() -> serde_json::Value {
    serde_json::json!({ "success": true, "data": "pong" })
}
