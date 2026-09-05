//! The kopibon headless CLI — the Rust side of the differential harness
//! (docs/rust-port/08-subsystem-plans/01 §8): one op per invocation, JSON in
//! (file path or `-` for stdin), one JSON line out:
//!
//!   kopibon <op> <input.json|->    →   {"ok":true,"value":…}
//!                                      {"ok":false,"error":"<verbatim error>"}
//!
//! Ops mirror `tests/differential/harness.mjs` exactly; both sides compare at
//! the parity levels of docs/rust-port/07-metadata-spec §1.

use kopibon_core::metadata::context::{
    file_metadata_from_gallery, file_metadata_from_library_item, file_metadata_from_payload,
    make_file_metadata, FileMetadata, LibraryItemMetadata, MetadataPayload,
};
use kopibon_core::metadata::mappers::{
    build_comic_info_xml, build_doc_info, build_keyword_tokens, build_xmp_xml, comic_info_context,
    xmp_context, Clock, FixedClock, SystemClock,
};
use kopibon_core::metadata::template::{render_template, TemplateContext, TemplateValue};
use kopibon_core::metadata::xml_utils::{
    decode_xml_entities, escape_xml, resolve_language_name, to_iso_language,
};

use serde_json::{json, Value};

/// JSON value → TemplateValue. A missing key is `Undefined` (handled by the
/// lookup, not here); `null` maps to `Null`; arrays map element-wise.
fn json_to_tv(v: &Value) -> TemplateValue {
    match v {
        Value::Null => TemplateValue::Null,
        Value::Bool(b) => TemplateValue::Bool(*b),
        Value::Number(n) => TemplateValue::Num(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => TemplateValue::Str(s.clone()),
        Value::Array(a) => TemplateValue::Arr(a.iter().map(json_to_tv).collect()),
        // JS objects stringify to "[object Object]"; templates never carry
        // them, but keep the behaviour defined.
        Value::Object(_) => TemplateValue::Str("[object Object]".into()),
    }
}

fn json_to_context(v: &Value) -> TemplateContext {
    let mut ctx = TemplateContext::new();
    if let Value::Object(map) = v {
        for (k, val) in map {
            ctx.insert(k.clone(), json_to_tv(val));
        }
    }
    ctx
}

fn meta(input: &Value) -> Result<FileMetadata, String> {
    let raw = input
        .get("meta")
        .ok_or_else(|| "missing input.meta".to_string())?;
    serde_json::from_value(raw.clone()).map_err(|e| format!("bad meta: {e}"))
}

fn sorted_context(ctx: &TemplateContext) -> Value {
    // Mirror the harness: keys sorted, values verbatim (JSON null for absent).
    let mut out = serde_json::Map::new();
    for (k, v) in ctx {
        out.insert(k.clone(), tv_to_json(v));
    }
    Value::Object(out)
}

fn tv_to_json(v: &TemplateValue) -> Value {
    match v {
        TemplateValue::Undefined | TemplateValue::Null => Value::Null,
        TemplateValue::Bool(b) => json!(b),
        TemplateValue::Num(n) => {
            // JS JSON.stringify prints integral numbers without a fraction.
            if n.fract() == 0.0 && n.abs() < 9e15 {
                json!(*n as i64)
            } else {
                serde_json::Number::from_f64(*n)
                    .map(Value::Number)
                    .unwrap_or(Value::Null)
            }
        }
        TemplateValue::Str(s) => json!(s),
        TemplateValue::Arr(a) => json!(a.iter().map(tv_to_json).collect::<Vec<_>>()),
    }
}

fn run(op: &str, input: &Value) -> Result<Value, String> {
    match op {
        "renderTemplate" => {
            let template = input
                .get("template")
                .and_then(|v| v.as_str())
                .ok_or("missing input.template")?;
            let ctx = json_to_context(input.get("context").unwrap_or(&Value::Null));
            Ok(json!(render_template(template, &ctx)?))
        }
        "buildComicInfoXml" => Ok(json!(build_comic_info_xml(&meta(input)?)?)),
        "buildXmpXml" => {
            let m = meta(input)?;
            let now = input.get("now").and_then(|v| v.as_i64()).unwrap_or(0);
            let clock = FixedClock(now);
            Ok(json!(build_xmp_xml(&m, &clock)?))
        }
        "buildKeywordTokens" => Ok(json!(build_keyword_tokens(&meta(input)?))),
        "buildDocInfo" => {
            let d = build_doc_info(&meta(input)?);
            Ok(
                json!({"title": d.title, "author": d.author, "keywords": d.keywords, "producer": d.producer}),
            )
        }
        "comicInfoContext" => Ok(sorted_context(&comic_info_context(&meta(input)?))),
        "xmpContext" => {
            let m = meta(input)?;
            let now = input.get("now").and_then(|v| v.as_i64()).unwrap_or(0);
            Ok(sorted_context(&xmp_context(&m, &FixedClock(now))))
        }
        "escapeXml" => {
            let s = input
                .get("s")
                .and_then(|v| v.as_str())
                .ok_or("missing input.s")?;
            Ok(json!(escape_xml(s)))
        }
        "decodeXmlEntities" => {
            let s = input
                .get("s")
                .and_then(|v| v.as_str())
                .ok_or("missing input.s")?;
            Ok(json!(decode_xml_entities(s)?))
        }
        "toIsoLanguage" => {
            let lang = input.get("lang").and_then(|v| v.as_str());
            Ok(json!(to_iso_language(lang)))
        }
        "resolveLanguageName" => {
            let cands: Vec<Option<String>> = input
                .get("candidates")
                .and_then(|v| v.as_array())
                .ok_or("missing input.candidates")?
                .iter()
                .map(|v| v.as_str().map(|s| s.to_string()))
                .collect();
            Ok(json!(resolve_language_name(&cands)))
        }
        "makeFileMetadata" => {
            let raw = input
                .get("meta")
                .cloned()
                .unwrap_or(Value::Object(Default::default()));
            let partial: FileMetadata =
                serde_json::from_value(raw).map_err(|e| format!("bad meta: {e}"))?;
            Ok(serde_json::to_value(make_file_metadata(partial)).map_err(|e| e.to_string())?)
        }
        "fileMetadataFromGallery" => {
            let gallery: kopibon_core::metadata::context::GalleryMetadata = serde_json::from_value(
                input
                    .get("gallery")
                    .cloned()
                    .ok_or("missing input.gallery")?,
            )
            .map_err(|e| format!("bad gallery: {e}"))?;
            let over: kopibon_core::metadata::context::FileMetadataOverrides =
                serde_json::from_value(
                    input
                        .get("over")
                        .cloned()
                        .unwrap_or(Value::Null)
                        .into_object_or_empty(),
                )
                .map_err(|e| format!("bad over: {e}"))?;
            Ok(
                serde_json::to_value(file_metadata_from_gallery(&gallery, over))
                    .map_err(|e| e.to_string())?,
            )
        }
        "fileMetadataFromLibraryItem" => {
            let row: LibraryItemMetadata =
                serde_json::from_value(input.get("row").cloned().ok_or("missing input.row")?)
                    .map_err(|e| format!("bad row: {e}"))?;
            let over: kopibon_core::metadata::context::FileMetadataOverrides =
                serde_json::from_value(
                    input
                        .get("over")
                        .cloned()
                        .unwrap_or(Value::Null)
                        .into_object_or_empty(),
                )
                .map_err(|e| format!("bad over: {e}"))?;
            Ok(
                serde_json::to_value(file_metadata_from_library_item(&row, over))
                    .map_err(|e| e.to_string())?,
            )
        }
        "fileMetadataFromPayload" => {
            let payload: MetadataPayload = serde_json::from_value(
                input
                    .get("payload")
                    .cloned()
                    .ok_or("missing input.payload")?,
            )
            .map_err(|e| format!("bad payload: {e}"))?;
            let over: kopibon_core::metadata::context::FileMetadataOverrides =
                serde_json::from_value(
                    input
                        .get("over")
                        .cloned()
                        .unwrap_or(Value::Null)
                        .into_object_or_empty(),
                )
                .map_err(|e| format!("bad over: {e}"))?;
            Ok(
                serde_json::to_value(file_metadata_from_payload(&payload, over))
                    .map_err(|e| e.to_string())?,
            )
        }
        "jsToString" => {
            let n = input
                .get("n")
                .and_then(|v| v.as_f64())
                .ok_or("missing input.n")?;
            Ok(json!(kopibon_core::metadata::js_number::js_to_string(n)))
        }
        "jsToFixed" => {
            let n = input
                .get("n")
                .and_then(|v| v.as_f64())
                .ok_or("missing input.n")?;
            let f = input
                .get("f")
                .and_then(|v| v.as_u64())
                .ok_or("missing input.f")? as usize;
            Ok(json!(kopibon_core::metadata::js_number::js_to_fixed(n, f)?))
        }
        "renderTemplateBatch" => {
            let cases = input
                .get("cases")
                .and_then(|v| v.as_array())
                .ok_or("missing input.cases")?;
            let mut values = Vec::with_capacity(cases.len());
            for case in cases {
                let r = (|| -> Result<Value, String> {
                    let template = case
                        .get("template")
                        .and_then(|v| v.as_str())
                        .ok_or("missing case.template")?;
                    let ctx = json_to_context(case.get("context").unwrap_or(&Value::Null));
                    Ok(json!(render_template(template, &ctx)?))
                })();
                values.push(match r {
                    Ok(v) => json!({"ok": true, "value": v}),
                    Err(e) => json!({"ok": false, "error": e}),
                });
            }
            Ok(json!({ "values": values }))
        }
        "applyGalleryIdToFilename" => {
            use kopibon_core::metadata::filenames::apply_gallery_id_to_filename;
            let file_name = input
                .get("fileName")
                .and_then(|v| v.as_str())
                .ok_or("missing input.fileName")?;
            let gallery_id = match input.get("galleryId") {
                None | Some(Value::Null) => None,
                Some(v) => Some(v.as_f64().ok_or("bad galleryId")? as u32),
            };
            Ok(json!(apply_gallery_id_to_filename(file_name, gallery_id)))
        }
        "truncateToBytes" => {
            use kopibon_core::metadata::filenames::truncate_to_bytes;
            let value = input
                .get("value")
                .and_then(|v| v.as_str())
                .ok_or("missing input.value")?;
            let max = input
                .get("maxBytes")
                .and_then(|v| v.as_u64())
                .ok_or("missing input.maxBytes")? as usize;
            Ok(json!(truncate_to_bytes(value, max)))
        }
        "tempSiblingPath" => {
            use kopibon_core::metadata::filenames::temp_sibling_path_suffix;
            let path = input
                .get("finalPath")
                .and_then(|v| v.as_str())
                .ok_or("missing input.finalPath")?;
            let suffix = input
                .get("suffix")
                .and_then(|v| v.as_str())
                .unwrap_or(".part");
            Ok(json!(temp_sibling_path_suffix(
                std::path::Path::new(path),
                suffix
            )
            .display()
            .to_string()))
        }
        "generateCbz" => {
            use base64::Engine as _;
            let pages: Vec<Vec<u8>> = input
                .get("pages")
                .and_then(|v| v.as_array())
                .ok_or("missing input.pages")?
                .iter()
                .map(|v| {
                    v.as_str()
                        .and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok())
                        .ok_or("bad page base64")
                })
                .collect::<Result<_, _>>()?;
            let m = meta(input)?;
            let mtime = input.get("mtime").and_then(|v| v.as_u64()).unwrap_or(0);
            let out = std::env::temp_dir().join(format!("cli-gen-{}.cbz", std::process::id()));
            kopibon_core::metadata::writers::comicinfo::generate_cbz(
                &pages, &out, &m, mtime, "jpg",
            )?;
            let bytes = std::fs::read(&out).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&out);
            Ok(json!(
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ))
        }
        "applyMetadata" => {
            use base64::Engine as _;
            let file = input
                .get("file")
                .and_then(|v| v.as_str())
                .ok_or("missing input.file")?;
            let format = kopibon_core::metadata::context::Format::parse_format(
                input
                    .get("format")
                    .and_then(|v| v.as_str())
                    .unwrap_or("pdf"),
            );
            let m = meta(input)?;
            let now = input.get("now").and_then(|v| v.as_i64()).unwrap_or(0);
            let mtime = input.get("mtime").and_then(|v| v.as_u64()).unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("cli-apply-{}", std::process::id()));
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let ext = if format == kopibon_core::metadata::context::Format::Cbz {
                "cbz"
            } else {
                "pdf"
            };
            let target = dir.join(format!("target.{ext}"));
            std::fs::copy(file, &target).map_err(|e| e.to_string())?;
            let r = match format {
                kopibon_core::metadata::context::Format::Cbz => {
                    kopibon_core::metadata::writers::apply_metadata(
                        &target,
                        kopibon_core::metadata::context::Format::Cbz,
                        &m,
                        &FixedClock(now),
                        mtime,
                    )
                }
                kopibon_core::metadata::context::Format::Pdf => {
                    kopibon_core::metadata::writers::apply_metadata(
                        &target,
                        kopibon_core::metadata::context::Format::Pdf,
                        &m,
                        &FixedClock(now),
                        mtime,
                    )
                }
            };
            let bytes = std::fs::read(&target).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_dir_all(&dir);
            match r {
                Ok(()) => Ok(json!({
                    "apply": {"success": true},
                    "bytes": base64::engine::general_purpose::STANDARD.encode(bytes)
                })),
                Err(e) => Ok(json!({"apply": {"success": false, "error": e}})),
            }
        }
        "countCbzPages" => {
            let file = input
                .get("file")
                .and_then(|v| v.as_str())
                .ok_or("missing input.file")?;
            Ok(json!(
                kopibon_core::metadata::writers::comicinfo::count_cbz_pages(std::path::Path::new(
                    file
                ))?
            ))
        }
        "batch" => {
            let items = input
                .get("items")
                .and_then(|v| v.as_array())
                .ok_or("missing input.items")?;
            let mut results = Vec::with_capacity(items.len());
            for item in items {
                let op = item
                    .get("op")
                    .and_then(|v| v.as_str())
                    .ok_or("missing item.op")?;
                let empty = Value::Object(Default::default());
                let item_input = item.get("input").unwrap_or(&empty);
                results.push(match run(op, item_input) {
                    Ok(v) => json!({"ok": true, "value": v}),
                    Err(e) => json!({"ok": false, "error": e}),
                });
            }
            Ok(json!({ "values": results }))
        }
        "systemNow" => Ok(json!(SystemClock.now_ms())),
        _ => Err(format!("kopibon: unknown op \"{op}\"")),
    }
}

trait IntoObjectOrEmpty {
    fn into_object_or_empty(self) -> Value;
}
impl IntoObjectOrEmpty for Value {
    fn into_object_or_empty(self) -> Value {
        if self.is_null() {
            Value::Object(Default::default())
        } else {
            self
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 && args[1] == "--list-ops" {
        for op in [
            "renderTemplate",
            "renderTemplateBatch",
            "buildComicInfoXml",
            "buildXmpXml",
            "buildKeywordTokens",
            "buildDocInfo",
            "comicInfoContext",
            "xmpContext",
            "escapeXml",
            "decodeXmlEntities",
            "toIsoLanguage",
            "resolveLanguageName",
            "makeFileMetadata",
            "fileMetadataFromGallery",
            "fileMetadataFromLibraryItem",
            "fileMetadataFromPayload",
            "jsToString",
            "jsToFixed",
        ] {
            println!("{op}");
        }
        return;
    }
    if args.len() < 2 {
        eprintln!("usage: kopibon <op> <input.json|->");
        std::process::exit(2);
    }
    let op = args[1].clone();
    let raw = if args.len() > 2 && args[2] != "-" {
        match std::fs::read_to_string(&args[2]) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("kopibon: cannot read {}: {e}", args[2]);
                std::process::exit(2);
            }
        }
    } else {
        use std::io::Read;
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).expect("read stdin");
        s
    };
    let input: Value = serde_json::from_str(&raw).unwrap_or_else(|e| {
        eprintln!("kopibon: bad input JSON: {e}");
        std::process::exit(2);
    });
    match run(&op, &input) {
        Ok(value) => println!("{}", json!({"ok": true, "value": value})),
        Err(error) => println!("{}", json!({"ok": false, "error": error})),
    }
}
