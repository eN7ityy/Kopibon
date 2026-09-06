//! App state: the 1.x main-process module singletons made explicit.
//!
//! 1.x keeps runtime state in module scope (rate-limiter tier, gallery LRU,
//! `syncingItems`, conversion lock sets + cancel flags, `restoreAuthFromDb`
//! results, updater status cache, `getItemCount` cache, …). The Tauri port
//! holds it in one [`AppState`] managed by Tauri (`State<AppState>` in every
//! command) — B2 grows this struct namespace by namespace; B1 seeds it with
//! the database handle and the data dir (the `initDatabase()` sequence).

use kopibon_core::db::Db;
use kopibon_core::metadata::mappers::Clock;
use kopibon_core::metadata::mappers::SystemClock;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::api::ApiState;
use crate::auth::AuthState;
use crate::commands::updater::UpdaterState;
use crate::download::DownloadManager;
use crate::kavita::KavitaState;
use crate::log::Logger;

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
    /// Root logger (`createLogger`, logger.ts:478-509). Cloned into scopes
    /// per command; the file+ring backend is shared.
    pub logger: Logger,
    /// nhentai auth state: client + `loggedIn`/`username` module flags
    /// (`auth.ipc.ts:7-10`). Behind a mutex — `validateKey` holds it across
    /// the `GET /user` round trip (1.x main is single-threaded; same
    /// serialisation here).
    pub auth: Mutex<AuthState>,
    /// Kavita shell state: blocking transport + status-bar count cache
    /// (`kavita-client.ts` module scope: client singleton, `itemCountCache`).
    pub kavita: Mutex<KavitaState>,
    /// Shared `api:*` caches: gallery details + tag autocomplete
    /// (`api.ipc.ts` + `search-settings.ipc.ts` module scope).
    pub api: ApiState,
    /// Updater status cache + staged update (`updater.ipc.ts`
    /// `lastUpdateStatus` + electron-updater's staging).
    pub updater: UpdaterState,
    /// Download pump state: in-flight flags, CDN health, concurrency
    /// (`DownloadManager` singleton + module maps).
    pub download: DownloadManager,
}

impl AppState {
    /// Open state against `data_dir` (creates it first, like `Db::open`).
    pub fn open(data_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        let db = Db::open(&data_dir.join("db.sqlite"))?;
        let logger = Logger::create(&data_dir.join("logs"))?;
        let auth = AuthState::fresh(SystemClock.now_ms());
        Ok(AppState {
            db,
            data_dir,
            toolchain_cache: Mutex::new(None),
            logger,
            auth: Mutex::new(auth),
            kavita: Mutex::new(KavitaState::new()),
            api: ApiState::new(),
            updater: UpdaterState::new(),
            download: DownloadManager::new(),
        })
    }
}
