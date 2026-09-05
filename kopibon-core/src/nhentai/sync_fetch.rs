//! The sync worker's 3-attempt fetch (sync.worker.ts:36-83) — kept SEPARATE
//! from the client's single-429-retry model (04 §4.3: two retry models, do
//! not merge). Its UA is the *other* string, `DoujinDownloader/1.0
//! (eN7ityy)`, and it sends no Accept header — both asserted by fixtures.
//!
//! Note on attempt accounting: the 429 branch `continue`s, which in the TS
//! for-loop *does* advance the attempt counter — the source comment claims
//! otherwise, but the code is the parity contract (preserved-quirk rule).

use crate::nhentai::http::{RequestDef, Transport};

pub const MAX_RETRIES: u32 = 3;
pub const BASE_URL: &str = "https://nhentai.net/api/v2";

/// Sync UA — verbatim, distinct from the client's `Doujin-Downloader/1.0`.
pub const SYNC_USER_AGENT: &str = "DoujinDownloader/1.0 (eN7ityy)";

/// What the fetch did per attempt, for assertions; the recorded sleeps carry
/// the exact waits.
#[derive(Debug, Clone, PartialEq)]
pub enum AttemptOutcome {
    /// 429 — continued (consumes a loop iteration; preserved-quirk rule).
    RateLimited,
    /// Non-429 failure — HTTP error, transport failure or JSON parse failure.
    Failed { error: String },
    Success,
}

/// `jitter_ms` stands in for `Math.random() * 1000`; `sleep` stands in for
/// `setTimeout` (tests record waits instead of sleeping).
pub fn fetch_gallery<T: Transport>(
    transport: &T,
    id: i64,
    api_key: Option<&str>,
    jitter_ms: i64,
    sleep: &mut dyn FnMut(i64),
) -> (Result<serde_json::Value, String>, Vec<AttemptOutcome>) {
    let mut outcomes = Vec::new();
    let mut last_error: Option<String> = None;

    let mut headers = vec![("User-Agent".to_string(), SYNC_USER_AGENT.to_string())];
    if let Some(key) = api_key {
        headers.push(("Authorization".to_string(), format!("Key {key}")));
    }

    for attempt in 1..=MAX_RETRIES {
        let request = RequestDef {
            method: "GET".to_string(),
            url: format!("{BASE_URL}/galleries/{id}"),
            headers: headers.clone(),
            body: None,
        };
        match transport.send(&request) {
            Ok(response) => {
                if response.status == 429 {
                    // parseInt(headers.get('Retry-After') || '5') — a null
                    // header falls back to '5'; an unparseable value is NaN,
                    // and setTimeout(NaN) fires immediately.
                    let retry_after = response
                        .header("Retry-After")
                        .map(parse_int)
                        .unwrap_or(5.0);
                    let wait_ms = if retry_after.is_nan() {
                        0
                    } else {
                        (retry_after * 1000.0) as i64 + jitter_ms
                    };
                    sleep(wait_ms);
                    outcomes.push(AttemptOutcome::RateLimited);
                    continue;
                }
                if !(200..300).contains(&response.status) {
                    // Thrown inside the try — the catch logs and backs off.
                    let error = format!("HTTP {}: {}", response.status, response.status_text);
                    outcomes.push(AttemptOutcome::Failed {
                        error: error.clone(),
                    });
                    last_error = Some(error);
                    if attempt < MAX_RETRIES {
                        sleep(2000 + (attempt as i64) * 1000);
                    }
                    continue;
                }
                match serde_json::from_str::<serde_json::Value>(&response.body) {
                    Ok(v) => {
                        outcomes.push(AttemptOutcome::Success);
                        return (Ok(v), outcomes);
                    }
                    // resp.json() rejection goes through the same catch.
                    Err(e) => {
                        // resp.json() rejection goes through the same catch.
                        let error = format!("failed to parse JSON: {e}");
                        outcomes.push(AttemptOutcome::Failed {
                            error: error.clone(),
                        });
                        last_error = Some(error);
                        if attempt < MAX_RETRIES {
                            sleep(2000 + (attempt as i64) * 1000);
                        }
                    }
                }
            }
            Err(e) => {
                outcomes.push(AttemptOutcome::Failed { error: e.clone() });
                last_error = Some(e);
                if attempt < MAX_RETRIES {
                    sleep(2000 + (attempt as i64) * 1000);
                }
            }
        }
    }

    (
        Err(last_error.unwrap_or_else(|| {
            format!("Failed to fetch gallery {id} after {MAX_RETRIES} retries")
        })),
        outcomes,
    )
}

/// JS parseInt (radix 10): leading integer prefix, NaN otherwise.
fn parse_int(s: &str) -> f64 {
    let t = s.trim_start();
    let mut end = 0;
    let bytes = t.as_bytes();
    if end < bytes.len() && (bytes[end] == b'+' || bytes[end] == b'-') {
        end += 1;
    }
    let digits_start = end;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    if end == digits_start {
        return f64::NAN;
    }
    t[..end].parse::<f64>().unwrap_or(f64::NAN)
}
