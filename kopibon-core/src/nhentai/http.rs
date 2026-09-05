//! HTTP abstraction (04 §1): the only module that touches the network.
//! `Transport` is synchronous here; the reqwest transport lands with the
//! download manager's runtime (WP-A8) behind this same trait, and tests run
//! on a replay transport (04 §7).

/// A request as the client builds it — enough for request-identical parity
/// (method/path/query/headers/body).
#[derive(Debug, Clone, PartialEq)]
pub struct RequestDef {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

/// A response: status, headers (multi-value preserved), body text.
#[derive(Debug, Clone, PartialEq)]
pub struct ResponseDef {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl ResponseDef {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

pub trait Transport {
    fn send(&self, request: &RequestDef) -> Result<ResponseDef, String>;
}

/// WHATWG `application/x-www-form-urlencoded` serialization — what
/// `URLSearchParams.toString()` produces: alnum plus `*`, `-`, `.`, `_`
/// literal, space → `+`, everything else percent-encoded uppercase.
pub fn urlencoded_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for &b in value.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
