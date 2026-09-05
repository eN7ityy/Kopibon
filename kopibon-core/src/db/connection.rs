//! Path resolution, pragmas and connection management (05-DB §4;
//! connection.ts:11-109). `KOPIBON_DATA_DIR` → `<dir>/db.sqlite` is the
//! override every worker honours (src/main/index.ts:101).

use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const BUSY_TIMEOUT_MS: u64 = 5000;

/// The database handle: one serialized writer + concurrent read connections.
pub struct Db {
    pub(crate) write: Mutex<Connection>,
    path: PathBuf,
}

impl Db {
    /// Open (creating directories first), apply pragmas, run migrations and
    /// seed defaults — the `initDatabase()` sequence (connection.ts:69-87).
    pub fn open(path: &Path) -> Result<Self, String> {
        let writer = open_connection(path)?;
        let db = Db {
            write: Mutex::new(writer),
            path: path.to_path_buf(),
        };
        crate::db::migrator::run_migrations(
            &mut *db.write.lock().map_err(|_| "write lock poisoned")?,
        )?;
        crate::db::seed::seed_defaults(&*db.write.lock().map_err(|_| "write lock poisoned")?)?;
        Ok(db)
    }

    pub fn open_default_dir() -> Result<Self, String> {
        let dir = resolve_db_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Self::open(&dir.join("db.sqlite"))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The write connection — serialize every mutation through this.
    pub fn with_writer<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut conn = self.write.lock().map_err(|_| "write lock poisoned")?;
        f(&mut conn)
    }

    /// A read connection (WAL: readers never block the writer). Opened fresh
    /// per call and closed after — SQLite connection setup is microseconds,
    /// and this keeps the `!Sync` `Connection` out of any shared state.
    pub fn with_reader<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let conn = open_connection(&self.path)?;
        f(&conn)
    }
}

/// Pragmas every connection sets (03-data-model §10.3).
pub fn open_connection(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_millis(BUSY_TIMEOUT_MS))
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// `resolveDbDir()` (connection.ts:11-44): `$KOPIBON_DATA_DIR` first, then
/// the Electron userData stand-in, then `~/.config/kopibon` (last resort).
pub fn resolve_db_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("KOPIBON_DATA_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".config").join("kopibon");
    }
    PathBuf::from(".")
}
