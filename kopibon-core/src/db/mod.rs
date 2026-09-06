//! `kopibon_core::db` — the rusqlite port of `src/main/db/`
//! (08-subsystem-plans/05; normative contract 03-data-model.md).
//!
//! **Connection topology (port decision, 05-DB §4):** WAL + a read pool +
//! ONE serialized write path. `Db` owns a `Mutex<Connection>` reserved for
//! writes (queue claims, row updates, maintenance) and hands out read
//! connections from a small pool. Every connection sets
//! `journal_mode = WAL`, `foreign_keys = ON` and `busy_timeout = 5000`
//! (1.x set busy_timeout on workers only — an accident, not a requirement;
//! 03-data-model §1). The single-writer rule is what keeps the download
//! queue's read-then-write claim safe and the two `UPDATE…RETURNING` claims
//! "exactly one row per runner".
//!
//! Callers from async contexts must reach the DB through
//! `tokio::task::spawn_blocking` — `Connection` is `!Sync` — do not wrap it
//! in an async adapter.

pub mod connection;
pub mod conversion;
pub mod blocked;
pub mod download;
pub mod gallery;
pub mod library;
pub mod maintenance;
pub mod migrator;
pub mod search;
pub mod seed;
pub mod series;
pub mod settings;
pub mod sync;

pub use connection::Db;

/// `unixepoch()` equivalent for stamping new writes (03-data-model §10.5).
pub fn now_s() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
