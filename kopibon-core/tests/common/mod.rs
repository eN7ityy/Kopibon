//! Shared plumbing for the differential suites: spawn the two sides of the
//! harness (live 1.x TS via `tests/differential/harness.mjs`, and this
//! workspace's `kopibon` CLI) and compare their JSON envelopes at the byte
//! level (10-test-plan §3).
//!
//! The live 1.x side is the repo's own TypeScript, read-only (D8). Node and
//! esbuild come from the repo's own dev tree. Both processes run pinned to
//! `TZ` so local-timezone fields (ComicInfo Year/Month/Day) are reproducible.

#![allow(dead_code)]

use serde_json::Value;
use std::process::Command;
use std::sync::Once;

static INIT: Once = Once::new();

/// Pin the timezone for both processes before any local-time use.
pub fn init() {
    INIT.call_once(|| {
        std::env::set_var("TZ", "Asia/Tokyo");
    });
}

fn envelope(mut cmd: Command, op: &str, input: &Value) -> Result<(bool, Value), String> {
    let stdin_json = serde_json::to_string(input).map_err(|e| e.to_string())?;
    cmd.arg(op)
        .arg("-")
        .stdin(std::process::Stdio::piped())
        // wait_with_output only captures streams configured as piped.
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    use std::io::Write;
    child
        .stdin
        .as_mut()
        .expect("piped")
        .write_all(stdin_json.as_bytes())
        .map_err(|e| format!("stdin write failed: {e}"))?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "harness process exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let parsed: Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("harness output not JSON: {e}"))?;
    let ok = parsed
        .get("ok")
        .and_then(|v| v.as_bool())
        .ok_or("harness envelope missing ok")?;
    Ok((ok, parsed))
}

/// Run one op on the JS side (live 1.x TS). Returns Ok(value) or Err(the
/// verbatim JS error string).
pub fn js_op(op: &str, input: &Value) -> Result<Value, String> {
    let mut cmd = Command::new("node");
    cmd.arg("tests/differential/harness.mjs")
        .current_dir(env_repo_root());
    match envelope(cmd, op, input)? {
        (true, v) => Ok(v
            .get("value")
            .cloned()
            .ok_or("JS harness envelope missing value")?),
        (false, v) => Err(v
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("unknown JS error")
            .to_string()),
    }
}

/// Run one op on the Rust side (the kopibon CLI). CARGO_BIN_EXE_ is set by
/// cargo for integration tests.
pub fn rust_op(op: &str, input: &Value) -> Result<Value, String> {
    let bin = env!("CARGO_BIN_EXE_kopibon");
    let mut cmd = Command::new(bin);
    cmd.current_dir(env_repo_root());
    match envelope(cmd, op, input)? {
        (true, v) => Ok(v
            .get("value")
            .cloned()
            .ok_or("Rust CLI envelope missing value")?),
        (false, v) => Err(v
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("unknown Rust error")
            .to_string()),
    }
}

/// Both sides ran the op; compare value-or-error exactly, reporting the
/// artifact that diverged.
pub fn assert_differential(op: &str, input: &Value) {
    init();
    let js = js_op(op, input);
    let rs = rust_op(op, input);
    match (js, rs) {
        (Ok(a), Ok(b)) => {
            if a != b {
                panic!(
                    "DIFF at op {op}:\n  input: {input}\n  js: {a}\n  rust: {b}"
                );
            }
        }
        (Err(a), Err(b)) => {
            if a != b {
                panic!(
                    "ERROR-STRING DIFF at op {op}:\n  input: {input}\n  js error: {a}\n  rust error: {b}"
                );
            }
        }
        (Ok(a), Err(b)) => panic!(
            "JS succeeded but Rust threw at op {op}:\n  input: {input}\n  js: {a}\n  rust error: {b}"
        ),
        (Err(a), Ok(b)) => panic!(
            "Rust succeeded but JS threw at op {op}:\n  input: {input}\n  js error: {a}\n  rust: {b}"
        ),
    }
}

/// Normalise every JSON number to f64 so `10` (JS) equals `10.0` (Rust).
pub fn normalize_numbers(v: &Value) -> Value {
    match v {
        Value::Number(n) => match n.as_f64() {
            Some(f) => serde_json::Number::from_f64(f)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            None => Value::Null,
        },
        Value::Array(a) => Value::Array(a.iter().map(normalize_numbers).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| (k.clone(), normalize_numbers(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn env_repo_root() -> String {
    // Integration tests run with CWD = the crate dir (kopibon-core); the
    // harness needs the repo root for tests/differential and the templates.
    let crate_dir = env!("CARGO_MANIFEST_DIR");
    std::path::Path::new(crate_dir)
        .parent()
        .expect("crate has a parent")
        .to_string_lossy()
        .to_string()
}
