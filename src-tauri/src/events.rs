//! Event emission (`02-ipc-surface` §3).
//!
//! The 14 main→renderer channels become Tauri `emit`s from the core's event
//! sinks. Audience rule (02 §1.4, 08-GUI §2.2): the app is single-window, so
//! [`emit`] broadcasts to all windows — the safer default the plan mandates.
//! The per-event table below records the 1.x audience for the multi-window
//! future; emitting modules must keep this list current either way.
//!
//! | Channel | 1.x audience | Notes |
//! |---|---|---|
//! | `download:progress` | all windows | |
//! | `library:scanProgress` | originating window | |
//! | `library:scanComplete` | originating window | |
//! | `library:scanError` | originating window | |
//! | `library:newItem` | originating window | subscribed, unconsumed (§4.4) — still emitted |
//! | `library:newItems` | originating window | batched 25 items / 500 ms in the worker |
//! | `library:syncProgress` | originating window | |
//! | `library:syncComplete` | originating window | |
//! | `library:convertProgress` | originating window | logLines drained per send |
//! | `library:convertToCbzProgress` | originating window | `CbzConvertProgress` shape |
//! | `library:addCustomProgress` | originating window | total 0 for non-per-page steps |
//! | `library:scanPaused` | originating window | no payload |
//! | `library:scanCancelled` | originating window | no payload |
//! | `app:updateStatus` | all windows | also sends `'checking'` |

use serde_json::Value;
use tauri::{AppHandle, Emitter};

/// Broadcast an event channel with a JSON payload (all-windows default).
/// First emitter lands with the download commands (B2); allow-listed until
/// then (workspace deny-warnings discipline — see Cargo.toml `[lints]`).
#[allow(dead_code)]
pub fn emit(app: &AppHandle, channel: &str, payload: Value) {
    let _ = app.emit(channel, payload);
}
