//! App state: the 1.x main-process module singletons made explicit.
//!
//! 1.x keeps runtime state in module scope (rate-limiter tier, gallery LRU,
//! `syncingItems`, conversion lock sets + cancel flags, `restoreAuthFromDb`
//! results, updater status cache, `getItemCount` cache, …). The Tauri port
//! holds it in one [`AppState`] managed by Tauri (`State<AppState>` in every
//! command) — B2 grows this struct namespace by namespace; B1 seeds it with
//! the database handle and the data dir (the `initDatabase()` sequence).

use kopibon_core::db::Db;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;

/// Shared application state (`State<AppState>`). Must stay `Send + Sync`:
/// [`Db`] owns a `Mutex<Connection>` writer plus fresh read connections, so
/// commands on different threads serialize writes and never block reads.
///
/// Fields are read by namespace commands as they land (B2); allow-listed
/// until then (deny-warnings discipline — see Cargo.toml `[lints]`).
#[allow(dead_code)]
pub struct AppState {
    /// Opened at boot: pragmas, migrations, `seedDefaults` (connection.ts).
    pub db: Db,
    /// Resolved data dir (KOPIBON_DATA_DIR override → Tauri app-data path).
    pub data_dir: PathBuf,
    /// `checkToolchain` cache (toolchain.ts:105-106: cached unless `force`).
    pub toolchain_cache: Mutex<Option<Value>>,
}

impl AppState {
    /// Open state against `data_dir` (creates it first, like `Db::open`).
    pub fn open(data_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        let db = Db::open(&data_dir.join("db.sqlite"))?;
        Ok(AppState {
            db,
            data_dir,
            toolchain_cache: Mutex::new(None),
        })
    }
}
