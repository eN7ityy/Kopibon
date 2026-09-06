//! Auth state + secret storage (`src/main/ipc/auth.ipc.ts:1-137`).
//!
//! 1.x encrypts API keys with Electron `safeStorage` (OS keychain) and keeps
//! a base64 blob in `app_settings`; when encryption is unavailable the key
//! is stored — and read back — as plaintext (`auth.ipc.ts:14-34`). The port
//! keeps those semantics with the [`keyring`] crate (02-ipc-surface §6):
//! a stored value is either a `keyring:v1:<account>` marker (secret lives
//! in the OS keychain) or plaintext (keychain unavailable at write time,
//! or a value saved before encryption existed). `decrypt_key` never throws:
//! an unreadable marker falls back to the stored string unchanged, exactly
//! like 1.x's `catch { return stored }`.
//!
//! Module state (`loggedIn`/`username`, `auth.ipc.ts:9-10`) and the API
//! client live in [`AuthState`], held behind one `Mutex` on [`AppState`](crate::state::AppState).
//! The client runs on [`UreqTransport`], the blocking HTTPS transport over
//! kopibon-core's `Transport` trait — the limiter, both 429 models and the
//! `Authorization: Key …` header stay in the core.

use kopibon_core::db::Db;
use kopibon_core::metadata::mappers::{Clock, SystemClock};
use kopibon_core::nhentai::{
    http::{RequestDef, ResponseDef, Transport},
    ApiClient,
};

/// Keyring service namespace (the bundle identifier — 1.x scopes
/// `safeStorage` to the app the same way).
pub const KEYRING_SERVICE: &str = "com.en7ity.kopibon";
/// `app_settings` key for the nhentai API key (`auth.ipc.ts:40`).
pub const NHENTAI_KEY_SETTING: &str = "nhentai_api_key";
/// Keyring account for the nhentai API key.
pub const NHENTAI_KEY_ACCOUNT: &str = "nhentai_api_key";
/// Keyring account for the Kavita API key (see `settings:*` encryption).
pub const KAVITA_KEY_ACCOUNT: &str = "kavitaApiKey";

/// Marker prefix for keychain-backed values in `app_settings`.
const MARKER_PREFIX: &str = "keyring:v1:";

fn marker(account: &str) -> String {
    format!("{MARKER_PREFIX}{account}")
}

/// `encryptKey` (`auth.ipc.ts:14-19`): keychain-backed marker when the OS
/// keychain answers, plaintext otherwise (`isEncryptionAvailable()` false).
pub fn encrypt_key(account: &str, key: &str) -> String {
    match keyring::Entry::new(KEYRING_SERVICE, account)
        .and_then(|entry| entry.set_password(key).map(|_| entry))
    {
        Ok(_) => marker(account),
        Err(_) => key.to_string(),
    }
}

/// `decryptKey` (`auth.ipc.ts:25-34`): markers resolve through the keychain,
/// everything else passes through unchanged (plaintext values, including
/// keys saved before encryption existed — `settings.ipc.ts:36-41`). Never
/// throws: an unreadable marker falls back to the stored string, matching
/// 1.x's `catch { return stored }`.
pub fn decrypt_key(account: &str, stored: &str) -> String {
    if let Some(marker_account) = stored.strip_prefix(MARKER_PREFIX) {
        let account = if marker_account.is_empty() {
            account
        } else {
            marker_account
        };
        return keyring::Entry::new(KEYRING_SERVICE, account)
            .and_then(|entry| entry.get_password())
            .unwrap_or_else(|_| stored.to_string());
    }
    stored.to_string()
}

/// Raw `app_settings` read (no decryption) for non-credential keys.
/// Small helper so the kavita/settings layers share one reader.
pub fn stored_setting(db: &Db, key: &str) -> Option<String> {
    db.with_reader(|conn| kopibon_core::db::settings::get(conn, key))
        .ok()?
}

/// Currently stored (decrypted) nhentai API key, if any
/// (`getStoredApiKey`, `auth.ipc.ts:39-47`). Decryption failure degrades to
/// `None` via the caller's catch — a marker that no longer resolves yields
/// the marker string, which authenticates against nothing, so validation
/// (not a crash) is the outcome either way.
pub fn stored_api_key(db: &Db) -> Option<String> {
    let encrypted: Option<String> = db
        .with_reader(|conn| kopibon_core::db::settings::get(conn, NHENTAI_KEY_SETTING))
        .ok()?;
    let stored = encrypted?;
    if stored.is_empty() {
        return None;
    }
    Some(decrypt_key(NHENTAI_KEY_ACCOUNT, &stored))
}

/// Blocking HTTPS transport over ureq (`Transport` is synchronous —
/// `nhentai/http.rs:6`). Status errors are NOT raised: kopibon-core's
/// `request()` maps `{status} {statusText}` itself, and the 429 retry quirk
/// needs the raw 429 response (`mod.rs:109+`). So `http_status_as_error`
/// stays off and every HTTP status comes back as a `ResponseDef`.
pub struct UreqTransport {
    agent: ureq::Agent,
}

impl UreqTransport {
    pub fn new() -> Self {
        UreqTransport {
            agent: ureq::Agent::config_builder()
                .http_status_as_error(false)
                .build()
                .into(),
        }
    }

    /// Transport with a global per-call timeout (`REQUEST_TIMEOUT_MS`,
    /// kavita-client.ts:116 — the Kavita shell calls give up after 10 s).
    /// The nhentai auth transport keeps no timeout (1.x fetch has none).
    pub fn with_global_timeout(timeout: std::time::Duration) -> Self {
        UreqTransport {
            agent: ureq::Agent::config_builder()
                .http_status_as_error(false)
                .timeout_global(Some(timeout))
                .build()
                .into(),
        }
    }
}

impl Default for UreqTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl Transport for UreqTransport {
    fn send(&self, request: &RequestDef) -> Result<ResponseDef, String> {
        // ureq 3 has verb-specific builders only; the core only sends
        // GET/POST/DELETE (mod.rs request sites) — anything else rides GET,
        // matching the replay transport's method-agnosticism in tests.
        let response = match request.method.as_str() {
            "POST" => {
                let mut outgoing = self.agent.post(request.url.clone());
                for (name, value) in &request.headers {
                    outgoing = outgoing.header(name.as_str(), value.as_str());
                }
                outgoing
                    .send(request.body.as_deref().unwrap_or(""))
                    .map_err(|e| e.to_string())?
            }
            "DELETE" => {
                let mut outgoing = self.agent.delete(request.url.clone());
                for (name, value) in &request.headers {
                    outgoing = outgoing.header(name.as_str(), value.as_str());
                }
                outgoing.call().map_err(|e| e.to_string())?
            }
            _ => {
                let mut outgoing = self.agent.get(request.url.clone());
                for (name, value) in &request.headers {
                    outgoing = outgoing.header(name.as_str(), value.as_str());
                }
                outgoing.call().map_err(|e| e.to_string())?
            }
        };
        // `http::Response<Body>`: status text is the canonical reason —
        // what fetch's `Response.statusText` carries for these codes.
        let status = response.status().as_u16();
        let status_text = response
            .status()
            .canonical_reason()
            .unwrap_or_default()
            .to_string();
        let mut headers = Vec::new();
        for (name, value) in response.headers().iter() {
            headers.push((
                name.to_string(),
                value.to_str().unwrap_or_default().to_string(),
            ));
        }
        let body = response.into_body().read_to_string().unwrap_or_default();
        Ok(ResponseDef {
            status,
            status_text,
            headers,
            body,
        })
    }
}

/// Main-process auth state (`auth.ipc.ts:7-10` module scope + client).
pub struct AuthState {
    client: ApiClient<UreqTransport>,
    logged_in: bool,
    username: Option<String>,
}

impl AuthState {
    /// Fresh state: anonymous limiter tier, logged out (`api-client.ts:134-136`
    /// + `auth.ipc.ts:9-10`).
    pub fn fresh(now_ms: i64) -> Self {
        AuthState {
            client: ApiClient::new(UreqTransport::new(), false, now_ms),
            logged_in: false,
            username: None,
        }
    }

    fn now_ms() -> i64 {
        SystemClock.now_ms()
    }

    /// `auth:validateKey` body (`auth.ipc.ts:83-98`): arm the client with the
    /// candidate key (raising the limiter tier), `GET /user`, persist
    /// encrypted on success; on ANY failure drop back to anonymous limits
    /// and report `'Invalid API key'`. Returns the username for the envelope.
    pub fn validate_key(&mut self, db: &Db, key: &str) -> Result<String, String> {
        let now = Self::now_ms();
        // Temporarily set the key to test it — this also raises the limits.
        self.client.set_api_key(Some(key), now);
        match self.fetch_username() {
            Ok(username) => {
                db.with_writer(|conn| {
                    kopibon_core::db::settings::set(
                        conn,
                        NHENTAI_KEY_SETTING,
                        &encrypt_key(NHENTAI_KEY_ACCOUNT, key),
                    )
                })?;
                self.logged_in = true;
                self.username = Some(username.clone());
                Ok(username)
            }
            Err(_) => {
                self.client.set_api_key(None, Self::now_ms());
                Err("Invalid API key".to_string())
            }
        }
    }

    /// `auth:setKey` (`auth.ipc.ts:111-114`): arm the client WITHOUT
    /// validation and WITHOUT persisting (startup restore path). The
    /// `loggedIn` flag is untouched — exactly like 1.x.
    pub fn set_key_unchecked(&mut self, key: &str) {
        self.client.set_api_key(Some(key), Self::now_ms());
    }

    /// Shared-client access for the `api:*` channels (`api.ipc.ts:55` holds
    /// the same singleton the auth handlers arm — one client, one limiter).
    pub fn client_mut(&mut self) -> &mut ApiClient<UreqTransport> {
        &mut self.client
    }

    /// `api:setApiKey` (`api.ipc.ts:108-111`): client tier only — no
    /// persistence, no flags (unlike `auth:validateKey`). `None` drops to
    /// anonymous limits, mirroring `setApiKey(null)`.
    pub fn set_api_key_opt(&mut self, key: Option<&str>) {
        self.client.set_api_key(key, Self::now_ms());
    }

    /// `auth:clearKey` (`auth.ipc.ts:120-127`): anonymous limits, row
    /// deleted, flags dropped.
    pub fn clear_key(&mut self, db: &Db) -> Result<(), String> {
        self.client.set_api_key(None, Self::now_ms());
        db.with_writer(|conn| kopibon_core::db::settings::delete(conn, NHENTAI_KEY_SETTING))?;
        self.logged_in = false;
        self.username = None;
        Ok(())
    }

    /// `auth:getAuthStatus` payload (`auth.ipc.ts:103-105`).
    pub fn status(&self) -> (bool, Option<String>) {
        (self.logged_in, self.username.clone())
    }

    /// `auth:getRateLimits` payload (`auth.ipc.ts:132-137`): note
    /// `authenticated` is the module `loggedIn` flag, NOT the limiter tier
    /// (they diverge after `setKey`-without-validation — preserved).
    pub fn rate_limits(&mut self) -> (bool, serde_json::Value) {
        let snapshot = self.client.limiter.snapshot(Self::now_ms());
        let mut buckets = serde_json::Map::new();
        for (group, (available, limit)) in snapshot {
            buckets.insert(
                group,
                serde_json::json!({ "available": available, "limit": limit }),
            );
        }
        (self.logged_in, serde_json::Value::Object(buckets))
    }

    /// `restoreAuthFromDb` (`auth.ipc.ts:53-74`): arm the client from the
    /// saved key, validate, and on failure drop the key AND the row (an
    /// invalid saved key must not linger to be retried every boot).
    /// Fire-and-forget at startup (`index.ts`: called without await).
    pub fn restore(&mut self, db: &Db) {
        let Some(saved) = stored_api_key(db) else {
            return;
        };
        let now = Self::now_ms();
        self.client.set_api_key(Some(&saved), now);
        match self.fetch_username() {
            Ok(username) => {
                self.logged_in = true;
                self.username = Some(username);
            }
            Err(_) => {
                self.client.set_api_key(None, Self::now_ms());
                let _ = db.with_writer(|conn| {
                    kopibon_core::db::settings::delete(conn, NHENTAI_KEY_SETTING)
                });
                self.logged_in = false;
                self.username = None;
            }
        }
    }

    /// `GET /user` → username. `None` (204 — never happens on /user) and
    /// unparseable bodies are failures: 1.x's `request<UserProfile>` throws
    /// on both, which `validateKey` maps to `'Invalid API key'`.
    fn fetch_username(&mut self) -> Result<String, String> {
        let clock = SystemClock;
        let response = self
            .client
            .get_user(&clock)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Invalid API key".to_string())?;
        serde_json::from_str::<serde_json::Value>(&response.body)
            .ok()
            .and_then(|v| v.get("username")?.as_str().map(str::to_string))
            .ok_or_else(|| "Invalid API key".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Plaintext passthrough when the keychain is unavailable, marker round
    /// trip when it answers — either way `decrypt(encrypt(k)) == k`. (No
    /// network: these cover the storage layer only.)
    #[test]
    fn key_round_trip() {
        let stored = encrypt_key("test-account-kopibon", "secret-value-123");
        assert_eq!(
            decrypt_key("test-account-kopibon", &stored),
            "secret-value-123"
        );
        if stored.starts_with(MARKER_PREFIX) {
            assert_eq!(stored, marker("test-account-kopibon"));
        } else {
            // Keychain unavailable here: plaintext, verbatim 1.x fallback.
            assert_eq!(stored, "secret-value-123");
        }
    }

    /// Pre-encryption values (no marker) pass through untouched
    /// (`settings.ipc.ts:36-41` — no migration step needed).
    #[test]
    fn legacy_plaintext_passes_through() {
        assert_eq!(
            decrypt_key("kavitaApiKey", "opaque-old-value"),
            "opaque-old-value"
        );
        assert_eq!(decrypt_key("nhentai_api_key", ""), "");
    }

    /// An unreadable marker degrades to the stored string, never a throw
    /// (`auth.ipc.ts:28-30` `catch { return stored }`).
    #[test]
    fn unreadable_marker_falls_back_to_stored() {
        let stored = marker("definitely-missing-account-xyz");
        // Either the keychain answers (impossible for a missing entry — the
        // get fails) or it doesn't; both paths return the stored string.
        assert_eq!(decrypt_key("whatever", &stored), stored);
    }

    /// Fresh state is logged-out with an anonymous limiter tier.
    #[test]
    fn fresh_state_is_anonymous() {
        let state = AuthState::fresh(0);
        assert_eq!(state.status(), (false, None));
    }
}
