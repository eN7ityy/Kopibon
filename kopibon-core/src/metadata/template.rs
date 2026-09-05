//! Port of `src/main/services/metadata/template-engine.ts` (07-metadata-spec
//! §2 is the formal contract). A very small line-oriented template engine:
//! `{{name}}`, `{{name?}}`, `{{#name}}…{{/name}}`, `{{#each name}}…{{/each}}`.
//! No escaping — the mapper owns it.
//!
//! The four regexes are verbatim (template-engine.ts:36-46); the inline
//! section uses a hand-rolled backreference scan because the `regex` crate
//! has no `\1`, exactly as 08/01 §2 prescribes.
//!
//! One deliberate non-observable difference: TS's `String.replace(whole, …)`
//! interprets `$`-sequences in the replacement; a template body containing
//! `$&`/`$1` would re-insert the whole match and loop forever in JS. Here the
//! replacement is literal, which is the only sane reading (JS hangs on that
//! input; no real template carries `$`-sequences).

use regex::Regex;
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// Anything a template placeholder can resolve to
/// (template-engine.ts:31, `TemplateValue`).
#[derive(Debug, Clone, PartialEq)]
pub enum TemplateValue {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<TemplateValue>),
}

/// The flat bag of values a template is rendered against
/// (template-engine.ts:34). `BTreeMap` for deterministic iteration.
pub type TemplateContext = BTreeMap<String, TemplateValue>;

/// `{{name}}`, `{{name?}}`, `{{.}}` — the `?` marks the line as droppable
/// (template-engine.ts:37).
fn placeholder() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*|\.)\s*(\?)?\s*\}\}").unwrap())
}

/// A section opener sitting alone on its line, e.g. `  {{#each tags}}`
/// (template-engine.ts:40). Tested against the trimmed line.
fn block_open() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\{\{#(each\s+)?([A-Za-z_][A-Za-z0-9_]*)\}\}$").unwrap())
}

/// Any section closer sitting alone on its line (template-engine.ts:43).
fn block_close() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\{\{/(each|[A-Za-z_][A-Za-z0-9_]*)\}\}$").unwrap())
}

/// Whether a value counts as "not there" (template-engine.ts:54-59). `0` and
/// `'0'` are *present*: PageCount is legitimately zero on an empty archive.
fn is_empty(value: Option<&TemplateValue>) -> bool {
    match value {
        None | Some(TemplateValue::Undefined) | Some(TemplateValue::Null) => true,
        Some(TemplateValue::Bool(false)) => true,
        Some(TemplateValue::Bool(true)) => false,
        Some(TemplateValue::Arr(a)) => a.is_empty(),
        // Numbers are never empty (String(0) = "0").
        Some(TemplateValue::Num(_)) => false,
        Some(TemplateValue::Str(s)) => s.is_empty(),
    }
}

/// Render a value into a line (template-engine.ts:67-72). Arrays join with
/// `', '` — via JS `Array.prototype.join` semantics, where null/undefined
/// elements become empty strings and *nested* arrays stringify via
/// `Array.prototype.toString`, i.e. a `','` join.
fn scalar(value: Option<&TemplateValue>) -> String {
    match value {
        None | Some(TemplateValue::Undefined) | Some(TemplateValue::Null) => String::new(),
        Some(TemplateValue::Bool(false)) => String::new(),
        Some(TemplateValue::Bool(true)) => "true".to_string(),
        Some(TemplateValue::Arr(a)) => js_join(a, ", "),
        Some(TemplateValue::Num(n)) => crate::metadata::js_number::js_to_string(*n),
        Some(TemplateValue::Str(s)) => s.clone(),
    }
}

/// `Array.prototype.join(sep)` with JS ToString element semantics.
fn js_join(items: &[TemplateValue], sep: &str) -> String {
    items
        .iter()
        .map(|v| match v {
            TemplateValue::Null | TemplateValue::Undefined => String::new(),
            TemplateValue::Arr(inner) => js_join(inner, ","),
            other => scalar(Some(other)),
        })
        .collect::<Vec<String>>()
        .join(sep)
}

fn lookup<'a>(
    name: &str,
    ctx: &'a TemplateContext,
    item: Option<&'a TemplateValue>,
) -> Option<&'a TemplateValue> {
    if name == "." {
        return item;
    }
    ctx.get(name)
}

/// Find the line index closing the section opened at `start`
/// (template-engine.ts:79-96). Tracks depth; error strings with 1-based line
/// numbers are load-bearing differential assertions.
fn find_close(lines: &[&str], start: usize, expected: &str) -> Result<usize, String> {
    let mut depth: i64 = 0;
    for (i, line) in lines.iter().enumerate().skip(start) {
        let trimmed = crate::metadata::xml_utils::js_trim(line);
        if block_open().is_match(trimmed) {
            depth += 1;
        } else if block_close().is_match(trimmed) {
            depth -= 1;
            if depth == 0 {
                if trimmed != expected {
                    return Err(format!(
                        "Template: expected {expected} on line {}, found {trimmed}",
                        i + 1
                    ));
                }
                return Ok(i);
            }
        }
    }
    Err(format!(
        "Template: {expected} is missing (section opened on line {})",
        start + 1
    ))
}

/// Find `{{#name}}body{{/name}}` — the INLINE_SECTION regex's backreference
/// semantics (template-engine.ts:46, non-greedy, NO `each x` support). JS
/// scans forward for the first position where the whole pattern matches, so a
/// failed candidate (`{{#each x}}`, `{{#1a}}`) is skipped in favour of the
/// next `{{#`; this reproduces that scan. Returns (name, body, byte start,
/// byte end exclusive).
fn find_inline_section(s: &str) -> Option<(String, String, usize, usize)> {
    let mut scan = 0usize;
    loop {
        let open = s[scan..].find("{{#")? + scan;
        scan = open + 3;
        let name_start = open + 3;
        let rest = &s[name_start..];
        let name_len = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(rest.len());
        let name = &rest[..name_len];
        // Name grammar: [A-Za-z_][A-Za-z0-9_]*, then `}}` must follow
        // immediately (placeholders allow `\s*?`; sections do not).
        let mut chars = name.chars();
        let valid = match chars.next() {
            Some(c) if c.is_ascii_alphabetic() || c == '_' => {
                chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
            }
            _ => false,
        };
        if !valid || !rest[name_len..].starts_with("}}") {
            continue; // regex engine advances to the next `{{#` candidate
        }
        let body_start = name_start + name_len + 2;
        // No closer for this candidate → JS backtracks and tries the next
        // opener, so fall through to the next scan position as well.
        let Some(close_rel) = s[body_start..].find(&format!("{{{{/{name}}}}}")) else {
            continue;
        };
        let close_start = body_start + close_rel;
        return Some((
            name.to_string(),
            s[body_start..close_start].to_string(),
            open,
            close_start + close_tag_len(name),
        ));
    }
}

fn close_tag_len(name: &str) -> usize {
    3 + name.len() + 2 // "{{/" + name + "}}"
}

/// Expand inline sections until none are left (template-engine.ts:99-107).
/// A `{{x?}}` inside a removed inline section can never set dropLine — the
/// section text simply vanishes before placeholder substitution.
fn expand_inline_sections(
    line: &str,
    ctx: &TemplateContext,
    item: Option<&TemplateValue>,
) -> String {
    let mut out = line.to_string();
    loop {
        let Some((name, body, start, end)) = find_inline_section(&out) else {
            return out;
        };
        let rendered = if is_empty(lookup(&name, ctx, item)) {
            String::new() // markers and body both vanish
        } else {
            body
        };
        out.replace_range(start..end, &rendered);
    }
}

/// Replace placeholders on one line (template-engine.ts:136-143); sets
/// `drop_line` when any `?` placeholder resolved empty.
fn substitute_placeholders(
    line: &str,
    ctx: &TemplateContext,
    item: Option<&TemplateValue>,
    drop_line: &mut bool,
) -> String {
    placeholder()
        .replace_all(line, |caps: &regex::Captures| {
            let name = &caps[1];
            let optional = caps.get(2).is_some();
            let value = if name == "." { item } else { ctx.get(name) };
            if optional && is_empty(value) {
                *drop_line = true;
            }
            scalar(value)
        })
        .into_owned()
}

fn render_lines(
    lines: &[&str],
    ctx: &TemplateContext,
    item: Option<&TemplateValue>,
) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let trimmed = crate::metadata::xml_utils::js_trim(lines[i]);
        if let Some(open) = block_open().captures(trimmed) {
            let is_each = open.get(1).is_some();
            let name = open[2].to_string();
            let expected = if is_each {
                "{{/each}}".to_string()
            } else {
                format!("{{{{/{name}}}}}")
            };
            let close = find_close(lines, i, &expected)?;
            let body = &lines[i + 1..close];
            let value = ctx.get(&name);

            if is_each {
                // Non-array/missing → zero iterations (template-engine.ts:125).
                if let Some(TemplateValue::Arr(items)) = value {
                    for entry in items {
                        out.extend(render_lines(body, ctx, Some(entry))?);
                    }
                }
            } else if !is_empty(value) {
                out.extend(render_lines(body, ctx, item)?);
            }
            i = close + 1;
            continue;
        }

        let mut drop_line = false;
        let expanded = expand_inline_sections(lines[i], ctx, item);
        let rendered = substitute_placeholders(&expanded, ctx, item, &mut drop_line);
        if !drop_line {
            out.push(rendered);
        }
        i += 1;
    }
    Ok(out)
}

/// Render `template` against `ctx` (template-engine.ts:158-161): CRLF → LF,
/// exactly one trailing newline dropped, render, join.
pub fn render_template(template: &str, ctx: &TemplateContext) -> Result<String, String> {
    let normalised = template.replace("\r\n", "\n");
    let normalised = normalised.strip_suffix('\n').unwrap_or(&normalised);
    let lines: Vec<&str> = normalised.split('\n').collect();
    Ok(render_lines(&lines, ctx, None)?.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(pairs: &[(&str, TemplateValue)]) -> TemplateContext {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    fn s(v: &str) -> TemplateValue {
        TemplateValue::Str(v.to_string())
    }

    // The 26 seeds of template-engine.test.ts, encoded as Rust assertions;
    // the differential suite re-runs these through live JS (TA-01).
    #[test]
    fn seeds_substitution() {
        let c = ctx(&[("title", s("Hi"))]);
        assert_eq!(
            render_template("<T>{{title}}</T>", &c).unwrap(),
            "<T>Hi</T>"
        );
        let c = ctx(&[("title", s(""))]);
        assert_eq!(render_template("<T>{{title}}</T>", &c).unwrap(), "<T></T>");
        let c = ctx(&[("a", s("1")), ("b", s("2"))]);
        assert_eq!(render_template("{{a}}-{{b}}", &c).unwrap(), "1-2");
        let c = ctx(&[("writers", TemplateValue::Arr(vec![s("A"), s("B")]))]);
        assert_eq!(
            render_template("<W>{{writers}}</W>", &c).unwrap(),
            "<W>A, B</W>"
        );
        let c = ctx(&[("n", TemplateValue::Num(0.0))]);
        assert_eq!(render_template("<P>{{n?}}</P>", &c).unwrap(), "<P>0</P>");
        assert_eq!(
            render_template("<T>{{nope}}</T>", &ctx(&[])).unwrap(),
            "<T></T>"
        );
        let c = ctx(&[("t", s("&amp;"))]);
        assert_eq!(render_template("<T>{{t}}</T>", &c).unwrap(), "<T>&amp;</T>");
    }

    #[test]
    fn seeds_optional_lines() {
        let c = ctx(&[("s", s(""))]);
        assert_eq!(render_template("a\n<S>{{s?}}</S>\nb", &c).unwrap(), "a\nb");
        let c = ctx(&[("s", s("x"))]);
        assert_eq!(
            render_template("a\n<S>{{s?}}</S>\nb", &c).unwrap(),
            "a\n<S>x</S>\nb"
        );
        let c = ctx(&[("y", s("2020")), ("m", s(""))]);
        assert_eq!(render_template("<D>{{y?}}-{{m?}}</D>", &c).unwrap(), "");
        let c = ctx(&[
            ("a", TemplateValue::Null),
            ("c", TemplateValue::Arr(vec![])),
        ]);
        assert_eq!(
            render_template("{{a?}}\n{{b?}}\n{{c?}}\nkeep", &c).unwrap(),
            "keep"
        );
        let c = ctx(&[("s", TemplateValue::Null)]);
        assert_eq!(
            render_template("one\n<S>{{s?}}</S>\ntwo", &c).unwrap(),
            "one\ntwo"
        );
    }

    #[test]
    fn seeds_sections() {
        let t = "before\n{{#lang}}\n  <L>{{lang}}</L>\n{{/lang}}\nafter";
        let c = ctx(&[("lang", s("en"))]);
        assert_eq!(
            render_template(t, &c).unwrap(),
            "before\n  <L>en</L>\nafter"
        );
        let c = ctx(&[("lang", TemplateValue::Null)]);
        assert_eq!(render_template(t, &c).unwrap(), "before\nafter");
        let c = ctx(&[("x", TemplateValue::Bool(true))]);
        assert_eq!(
            render_template("  {{#x}}\n  body\n  {{/x}}", &c).unwrap(),
            "  body"
        );
        // Inline sections.
        let line = "<Bag>{{#p}}<li>{{p}}</li>{{/p}}</Bag>";
        let c = ctx(&[("p", s("Acme"))]);
        assert_eq!(
            render_template(line, &c).unwrap(),
            "<Bag><li>Acme</li></Bag>"
        );
        let c = ctx(&[("p", s(""))]);
        assert_eq!(render_template(line, &c).unwrap(), "<Bag></Bag>");
        let c = ctx(&[("a", TemplateValue::Num(1.0)), ("b", s(""))]);
        assert_eq!(
            render_template("{{#a}}A{{/a}}{{#b}}B{{/b}}", &c).unwrap(),
            "A"
        );
        // Nesting.
        let nested = "{{#o}}\no\n{{#i}}\ni\n{{/i}}\n{{/o}}";
        let c = ctx(&[
            ("o", TemplateValue::Bool(true)),
            ("i", TemplateValue::Bool(true)),
        ]);
        assert_eq!(render_template(nested, &c).unwrap(), "o\ni");
        let c = ctx(&[
            ("o", TemplateValue::Bool(true)),
            ("i", TemplateValue::Bool(false)),
        ]);
        assert_eq!(render_template(nested, &c).unwrap(), "o");
        let c = ctx(&[
            ("o", TemplateValue::Bool(false)),
            ("i", TemplateValue::Bool(true)),
        ]);
        assert_eq!(render_template(nested, &c).unwrap(), "");
        // Optional line inside a rendered section.
        let sec = "{{#o}}\n<a>{{a}}</a>\n<b>{{b?}}</b>\n{{/o}}";
        let c = ctx(&[
            ("o", TemplateValue::Bool(true)),
            ("a", s("1")),
            ("b", TemplateValue::Null),
        ]);
        assert_eq!(render_template(sec, &c).unwrap(), "<a>1</a>");
        // Errors (verbatim strings with 1-based line numbers).
        let err = render_template("{{#a}}\nx", &ctx(&[])).unwrap_err();
        assert_eq!(
            err,
            "Template: {{/a}} is missing (section opened on line 1)"
        );
        let err = render_template("{{#a}}\nx\n{{/b}}", &ctx(&[])).unwrap_err();
        assert_eq!(err, "Template: expected {{/a}} on line 3, found {{/b}}");
    }

    #[test]
    fn seeds_each() {
        let t = "<Seq>\n{{#each xs}}\n  <li>{{.}}</li>\n{{/each}}\n</Seq>";
        let c = ctx(&[("xs", TemplateValue::Arr(vec![s("a"), s("b")]))]);
        assert_eq!(
            render_template(t, &c).unwrap(),
            "<Seq>\n  <li>a</li>\n  <li>b</li>\n</Seq>"
        );
        let c = ctx(&[("xs", TemplateValue::Arr(vec![]))]);
        assert_eq!(render_template(t, &c).unwrap(), "<Seq>\n</Seq>");
        assert_eq!(render_template(t, &ctx(&[])).unwrap(), "<Seq>\n</Seq>");
        let t2 = "{{#each xs}}\n{{prefix}}:{{.}}\n{{/each}}";
        let c = ctx(&[("xs", TemplateValue::Arr(vec![s("a")])), ("prefix", s("p"))]);
        assert_eq!(render_template(t2, &c).unwrap(), "p:a");
    }

    #[test]
    fn seeds_file_shape() {
        assert_eq!(render_template("a\nb\n", &ctx(&[])).unwrap(), "a\nb");
        assert_eq!(render_template("a\nb\n\n", &ctx(&[])).unwrap(), "a\nb\n");
        assert_eq!(render_template("a\r\nb\r\n", &ctx(&[])).unwrap(), "a\nb");
    }

    #[test]
    fn number_semantics_in_templates() {
        // JS String(Number) through the engine.
        let c = ctx(&[("n", TemplateValue::Num(1e21))]);
        assert_eq!(render_template("{{n}}", &c).unwrap(), "1e+21");
        let c = ctx(&[("n", TemplateValue::Num(2.5))]);
        assert_eq!(render_template("{{n}}", &c).unwrap(), "2.5");
        let c = ctx(&[("n", TemplateValue::Num(0.0))]);
        assert_eq!(render_template("{{n}}", &c).unwrap(), "0");
    }
}
