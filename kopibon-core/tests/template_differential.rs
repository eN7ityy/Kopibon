//! TA-01 — Template differential (26 seeds of
//! `src/main/services/metadata/template-engine.test.ts`), byte + error
//! strings, against live 1.x (10-test-plan §7). Every seed asserts the
//! *expected* value from the 1.x vitest suite AND equality with the JS side.

mod common;

use serde_json::json;

/// (template, context, expected-or-expected-error)
type Seed = (
    &'static str,
    serde_json::Value,
    Result<&'static str, &'static str>,
);

fn seeds() -> Vec<Seed> {
    vec![
        // ── substitution (template-engine.test.ts:11-41) ──
        ("<T>{{title}}</T>", json!({"title": "Hi"}), Ok("<T>Hi</T>")),
        ("<T>{{title}}</T>", json!({"title": ""}), Ok("<T></T>")),
        ("{{a}}-{{b}}", json!({"a": "1", "b": "2"}), Ok("1-2")),
        (
            "<W>{{writers}}</W>",
            json!({"writers": ["A", "B"]}),
            Ok("<W>A, B</W>"),
        ),
        ("<P>{{n?}}</P>", json!({"n": 0}), Ok("<P>0</P>")),
        ("<T>{{nope}}</T>", json!({}), Ok("<T></T>")),
        ("<T>{{t}}</T>", json!({"t": "&amp;"}), Ok("<T>&amp;</T>")),
        // ── optional lines (:43-64) ──
        ("a\n<S>{{s?}}</S>\nb", json!({"s": ""}), Ok("a\nb")),
        (
            "a\n<S>{{s?}}</S>\nb",
            json!({"s": "x"}),
            Ok("a\n<S>x</S>\nb"),
        ),
        (
            "<D>{{y?}}-{{m?}}</D>",
            json!({"y": "2020", "m": ""}),
            Ok(""),
        ),
        (
            "{{a?}}\n{{b?}}\n{{c?}}\nkeep",
            json!({"a": null, "c": []}),
            Ok("keep"),
        ),
        (
            "one\n<S>{{s?}}</S>\ntwo",
            json!({"s": null}),
            Ok("one\ntwo"),
        ),
        // ── sections (:67-112) ──
        (
            "before\n{{#lang}}\n  <L>{{lang}}</L>\n{{/lang}}\nafter",
            json!({"lang": "en"}),
            Ok("before\n  <L>en</L>\nafter"),
        ),
        (
            "before\n{{#lang}}\n  <L>{{lang}}</L>\n{{/lang}}\nafter",
            json!({"lang": null}),
            Ok("before\nafter"),
        ),
        (
            "  {{#x}}\n  body\n  {{/x}}",
            json!({"x": true}),
            Ok("  body"),
        ),
        (
            "<Bag>{{#p}}<li>{{p}}</li>{{/p}}</Bag>",
            json!({"p": "Acme"}),
            Ok("<Bag><li>Acme</li></Bag>"),
        ),
        (
            "<Bag>{{#p}}<li>{{p}}</li>{{/p}}</Bag>",
            json!({"p": ""}),
            Ok("<Bag></Bag>"),
        ),
        (
            "{{#a}}A{{/a}}{{#b}}B{{/b}}",
            json!({"a": 1, "b": ""}),
            Ok("A"),
        ),
        (
            "{{#o}}\no\n{{#i}}\ni\n{{/i}}\n{{/o}}",
            json!({"o": true, "i": true}),
            Ok("o\ni"),
        ),
        (
            "{{#o}}\no\n{{#i}}\ni\n{{/i}}\n{{/o}}",
            json!({"o": true, "i": false}),
            Ok("o"),
        ),
        (
            "{{#o}}\no\n{{#i}}\ni\n{{/i}}\n{{/o}}",
            json!({"o": false, "i": true}),
            Ok(""),
        ),
        (
            "{{#o}}\n<a>{{a}}</a>\n<b>{{b?}}</b>\n{{/o}}",
            json!({"o": true, "a": "1", "b": null}),
            Ok("<a>1</a>"),
        ),
        ("{{#a}}\nx", json!({}), Err("missing")),
        ("{{#a}}\nx\n{{/b}}", json!({}), Err("expected")),
        // ── each (:115-133) ──
        (
            "<Seq>\n{{#each xs}}\n  <li>{{.}}</li>\n{{/each}}\n</Seq>",
            json!({"xs": ["a", "b"]}),
            Ok("<Seq>\n  <li>a</li>\n  <li>b</li>\n</Seq>"),
        ),
        (
            "<Seq>\n{{#each xs}}\n  <li>{{.}}</li>\n{{/each}}\n</Seq>",
            json!({"xs": []}),
            Ok("<Seq>\n</Seq>"),
        ),
        (
            "<Seq>\n{{#each xs}}\n  <li>{{.}}</li>\n{{/each}}\n</Seq>",
            json!({}),
            Ok("<Seq>\n</Seq>"),
        ),
        (
            "{{#each xs}}\n{{prefix}}:{{.}}\n{{/each}}",
            json!({"xs": ["a"], "prefix": "p"}),
            Ok("p:a"),
        ),
        // ── file shape (:136-148) ──
        ("a\nb\n", json!({}), Ok("a\nb")),
        ("a\nb\n\n", json!({}), Ok("a\nb\n")),
        ("a\r\nb\r\n", json!({}), Ok("a\nb")),
    ]
}

#[test]
fn ta01_seeds_match_js_byte_and_error_exact() {
    common::init();
    let seeds = seeds();
    let batch: Vec<serde_json::Value> = seeds
        .iter()
        .map(|(template, context, _)| json!({"template": template, "context": context}))
        .collect();
    let js_values = common::js_op("renderTemplateBatch", &json!({ "cases": batch }))
        .expect("JS harness batch failed");

    for (i, (template, context, expected)) in seeds.iter().enumerate() {
        let input = json!({"template": template, "context": context});
        let js = js_values
            .get(i)
            .unwrap_or_else(|| panic!("batch row {i} missing"));

        // The live 1.x engine must still produce the recorded expectation.
        match expected {
            Ok(expected) => {
                assert_eq!(
                    js.get("value").and_then(|v| v.as_str()),
                    Some(*expected),
                    "seed {i} ({template:?}): live 1.x no longer matches the recorded value"
                );
            }
            Err(needle) => {
                let err = js.get("error").and_then(|v| v.as_str()).unwrap_or_default();
                assert!(
                    err.contains(needle),
                    "seed {i}: expected error containing {needle:?}, got {err:?}"
                );
            }
        }

        common::assert_differential("renderTemplate", &input);
    }
}

#[test]
fn ta01_engine_corners_match_js() {
    // Corners beyond the vitest seeds the shipped templates can hit via user
    // edits: dotted placeholder, optional each-item, whitespace forms.
    for (template, context) in [
        ("{{.}}", json!({})),
        ("{{ . }}", json!({"x": "1"})),
        ("{{ x? }}\n{{y ?}}", json!({"x": "", "y": "v"})),
        ("{{#each missing}}\n{{.}}\n{{/each}}", json!({})),
        ("{{#x}}\n{{.}}\n{{/x}}", json!({"x": "keep"})),
        ("{{#each xs}}\n{{q?}}\n{{/each}}", json!({"xs": ["a", "b"]})),
        ("{{#each}}\n{{.}}\n{{/each}}", json!({"each": "E"})),
        (
            "text {{#each xs}}\n{{.}}\n{{/each}} more",
            json!({"xs": ["1"]}),
        ),
        ("{{a}}{{a}}", json!({"a": "A"})),
        ("{{#o}}{{#o}}deep{{/o}}{{/o}}", json!({"o": true})),
        ("{{#x}}\nline1\n\nline3\n{{/x}}", json!({"x": 1})),
        ("{{n}}", json!({"n": 1.5})),
        ("{{n}}", json!({"n": 100.0})),
        ("{{n}}", json!({"n": 123456789.125})),
        ("{{n?}}", json!({"n": 0.0})),
        ("{{x}}", json!({"x": true})),
        ("{{x?}}", json!({"x": false})),
        ("{{x}}", json!({"x": ["a", null, "b"]})),
        ("{{x}}", json!({"x": [[1, 2], ["3"]]})),
        ("{{x?}}", json!({"x": []})),
    ] {
        common::assert_differential(
            "renderTemplate",
            &json!({"template": template, "context": context}),
        );
    }
}
