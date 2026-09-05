//! JS `Number` stringification for f64 (08/01 §4, §10).
//!
//! Rust's `format!` differs from ECMAScript in two load-bearing ways: the
//! shortest-round-trip digits are the same, but Rust never uses exponential
//! form (`1e21` prints in full) and Rust's fixed formatting rounds half-to-even
//! where `toFixed` rounds exact ties toward the larger `n` (07-metadata-spec
//! §2 item: `String(Number)` and `toFixed(2)` semantics).
//!
//! `Number::toString` implements ECMA-262 `Number::toString(x, 10)` on top of
//! Rust's shortest-round-trip digits (`{:e}`); `to_fixed` implements
//! `Number.prototype.toFixed(f)` on top of the *exact* decimal expansion of
//! the binary value (Rust's `{:.*f}` with large precision is exact).

/// `String(Number)` — ECMA-262 Number::toString for radix 10, implemented by
/// `ryu-js` (shortest round-trip digits with the exact ECMAScript placement
/// and exponential thresholds; Rust's `{:e}` tie-breaking diverges —
/// 8.988465674311579e307 exposed that in fuzz).
pub fn js_to_string(x: f64) -> String {
    ryu_js::Buffer::new().format(x).to_string()
}

/// Digit-string variant used by the entity decoder for code points beyond
/// char range — plain integer printing (u128 never reaches the exponential
/// thresholds of the JS paths it feeds).
pub fn js_to_string_u128(v: u128) -> String {
    v.to_string()
}

/// `Number.prototype.toFixed(f)` — ECMA-262, f in 0..=100.
///
/// Per spec: pick `n` such that `n / 10^f − x` is as close to zero as
/// possible; on two such `n`, pick the **larger**. Since every f64 has a
/// finite decimal expansion, this is exact rounding of the true binary value
/// at position `f`, ties toward the larger `n` (up for positive values,
/// toward zero for negative ones).
pub fn js_to_fixed(x: f64, f: usize) -> Result<String, String> {
    if !(0..=100).contains(&f) {
        return Err(format!(
            "toFixed() digits argument must be between 0 and {}",
            if f > 100 { 100 } else { f }
        ));
    }
    if x.is_nan() {
        return Ok("NaN".to_string());
    }
    if x.is_infinite() {
        return Ok(if x > 0.0 { "Infinity" } else { "-Infinity" }.to_string());
    }
    if x.abs() >= 1e21 {
        return Ok(js_to_string(x)); // spec: ≥10^21 behaves as toString
    }

    let neg = x < 0.0; // -0.0 is not < 0, matching JS
    let abs = x.abs();

    // Exact decimal expansion of `abs`. Precision f + margin covers the full
    // expansion for the magnitudes below 1e21 and lets tie detection see the
    // true tail.
    const MARGIN: usize = 1200;
    let expansion = format!("{:.*}", f + MARGIN, abs);
    // expansion = "123.456..." or "0.00420..."
    let (int_part, frac_part) = expansion
        .split_once('.')
        .unwrap_or((expansion.as_str(), ""));
    let int_digits: Vec<u8> = int_part.bytes().collect();
    let frac_digits: Vec<u8> = frac_part.bytes().collect();

    // Round at fractional position f: decide whether the kept digits increment.
    // Ground truth (node): ties round away from zero for BOTH signs —
    // (0.125).toFixed(2)='0.13' and (-0.125).toFixed(2)='-0.13'; the sign is
    // kept even when the rounded value is zero ((-0.001).toFixed(2)='-0.00').
    let next = frac_digits.get(f).copied();
    let round_up = match next {
        None => false,
        Some(d) if d < b'5' => false,
        Some(_) => true,
    };

    // Build kept digits (int part + first f fractional), then apply carry.
    let mut kept: Vec<u8> = int_digits.clone();
    for i in 0..f {
        kept.push(*frac_digits.get(i).unwrap_or(&b'0'));
    }
    let mut carried_digit = 0usize; // extra integer digits created by carry
    if round_up {
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, b'1');
                carried_digit = 1;
                break;
            }
            i -= 1;
            if kept[i] == b'9' {
                kept[i] = b'0';
            } else {
                kept[i] += 1;
                break;
            }
        }
    }

    // Strip a leading zero when the carry produced an extra digit before the
    // decimal point ("0" + nothing) — only relevant for int_part "0".
    let mut result = String::with_capacity(kept.len() + 2);
    if neg {
        result.push('-');
    }
    let int_end = int_digits.len() + carried_digit;
    result.push_str(std::str::from_utf8(&kept[..int_end]).unwrap());
    if f > 0 {
        result.push('.');
        result.push_str(std::str::from_utf8(&kept[int_end..]).unwrap());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_string_basics() {
        assert_eq!(js_to_string(0.0), "0");
        assert_eq!(js_to_string(-0.0), "0");
        assert_eq!(js_to_string(1.0), "1");
        assert_eq!(js_to_string(-1.5), "-1.5");
        assert_eq!(js_to_string(0.5), "0.5");
        assert_eq!(js_to_string(f64::NAN), "NaN");
        assert_eq!(js_to_string(f64::INFINITY), "Infinity");
        assert_eq!(js_to_string(2.675), "2.675");
    }

    #[test]
    fn to_string_exponential_thresholds() {
        // JS: 1e-7 → "1e-7", 1e-6 → "0.000001", 1e21 → "1e+21"
        assert_eq!(js_to_string(1e-7), "1e-7");
        assert_eq!(js_to_string(1e-6), "0.000001");
        assert_eq!(js_to_string(1e21), "1e+21");
        assert_eq!(js_to_string(1.5e22), "1.5e+22");
        assert_eq!(js_to_string(1e20), "100000000000000000000");
        assert_eq!(js_to_string(-1e21), "-1e+21");
        assert_eq!(js_to_string(1.2345678901234568e20), "123456789012345680000");
    }

    #[test]
    fn to_fixed_semantics() {
        // Vectors verified against node (Number.prototype.toFixed ground truth).
        assert_eq!(js_to_fixed(2.675, 2).unwrap(), "2.67"); // binary value is below
        assert_eq!(js_to_fixed(0.125, 2).unwrap(), "0.13"); // exact tie → away
        assert_eq!(js_to_fixed(-0.125, 2).unwrap(), "-0.13"); // tie → away from zero
        assert_eq!(js_to_fixed(9.999, 2).unwrap(), "10.00");
        assert_eq!(js_to_fixed(1.005, 2).unwrap(), "1.00");
        assert_eq!(js_to_fixed(1.0, 2).unwrap(), "1.00");
        assert_eq!(js_to_fixed(0.0, 2).unwrap(), "0.00");
        assert_eq!(js_to_fixed(-0.0, 2).unwrap(), "0.00");
        assert_eq!(js_to_fixed(-0.001, 2).unwrap(), "-0.00");
        assert_eq!(js_to_fixed(0.5, 0).unwrap(), "1");
        assert_eq!(js_to_fixed(-0.5, 0).unwrap(), "-1");
        assert_eq!(js_to_fixed(2.5, 0).unwrap(), "3");
        assert_eq!(js_to_fixed(-2.5, 0).unwrap(), "-3");
        assert_eq!(js_to_fixed(0.001, 2).unwrap(), "0.00");
        assert_eq!(js_to_fixed(123.456, 0).unwrap(), "123");
        assert_eq!(js_to_fixed(1e21, 2).unwrap(), "1e+21");
    }
}
