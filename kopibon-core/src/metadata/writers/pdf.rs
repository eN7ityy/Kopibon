//! PdfWriter — lopdf replaces the Python/pikepdf pipeline wholesale
//! (D3: no external tools; 08/01 §5; sources xmp-inject.ts:20-54).
//!
//! The exact operations of the Python script become: open, delete any
//! existing catalog `/Metadata`, set Info `/Title /Author /Keywords` +
//! `/Producer` (D6: "Kopibon 2.x") + `/Trapped /False` as a proper name,
//! insert the rendered XMP as an **uncompressed** `/Type /Metadata
//! /Subtype /XML` stream, save with object streams off so the Info dict is
//! plainly readable, atomic replace into place.
//!
//! The two lxml normalisations (07-metadata-spec §2, S1 evidence §10.1) are
//! implemented here as exactly two explicit passes — never generalised into
//! a serialiser, never applied to ComicInfo.
//!
//! D6/§12.1: pikepdf's silent empty-metadata failure becomes **loud** — a
//! saved document without the packet is an error.

use crate::metadata::context::FileMetadata;
use crate::metadata::filenames::temp_sibling_path;
use crate::metadata::mappers::{build_doc_info, build_xmp_xml, Clock};
use lopdf::dictionary;
use std::path::Path;

/// The 1.x pipeline's final XMP bytes are the template output passed through
/// pikepdf's lxml serialiser, which (a) self-closes empty elements and
/// (b) appends the packet-tail newline (07-metadata-spec §2). Reproduce
/// exactly these two normalisations — no XML library, no other rewrites.
pub fn lxml_normalisations(rendered: &str) -> String {
    // (b) first, as the S1 spike verified byte-identity: newline tail after
    // the root element, before the closing xpacket PI, and a final newline.
    let mut out = rendered.replace("</x:xmpmeta>\n<?xpacket", "</x:xmpmeta>\n\n<?xpacket");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    // (a) `<tag attrs></tag>` → `<tag attrs/>` for same-line pairs.
    normalize_empty_elements(&out)
}

fn normalize_empty_elements(s: &str) -> String {
    let mut res = String::with_capacity(s.len());
    let mut i = 0usize;
    let mut search = 0usize;
    while let Some(rel) = s[search..].find("></") {
        let open_end = search + rel;
        // Find the '<' that opens this element.
        let Some(open_rel) = s[..open_end].rfind('<') else {
            res.push_str(&s[search..open_end + 2]);
            search = open_end + 2;
            continue;
        };
        let open = open_rel;
        let tag = &s[open + 1..open_end];
        let name = tag.split_whitespace().next().unwrap_or("");
        let close = format!("></{name}>");
        if !name.is_empty()
            && !name.starts_with('/')
            && !name.starts_with('!')
            && s[open_end..].starts_with(&close)
        {
            let end = open_end + close.len();
            let selfclosed = format!("<{tag}/>");
            res.push_str(&s[i..open]);
            res.push_str(&selfclosed);
            i = end;
            search = end;
        } else {
            search = open_end + 1;
        }
    }
    res.push_str(&s[i..]);
    res
}

/// Apply metadata to a PDF in place: docinfo nuked, XMP packet injected
/// (xmp-inject.ts:143-148 + apply-metadata.ts:219). The packet and the Info
/// dictionary derive from the same FileMetadata, so they cannot disagree.
pub fn write_pdf_metadata(
    pdf_path: &Path,
    meta: &FileMetadata,
    clock: &dyn Clock,
) -> Result<(), String> {
    let rendered = build_xmp_xml(meta, clock)?;
    let packet = lxml_normalisations(&rendered);
    let info = build_doc_info(meta);

    let part_path = temp_sibling_path(pdf_path);
    let result = (|| -> Result<(), String> {
        let mut doc = lopdf::Document::load(pdf_path).map_err(|e| e.to_string())?;
        if std::env::var("PDF_WRITER_DEBUG").is_ok() {
            eprintln!("stage: loaded source");
        }

        // Nuke the existing catalog Metadata reference (xmp-inject.ts:38-40).
        let root_id = match doc.trailer.get(b"Root") {
            Ok(lopdf::Object::Reference(id)) => *id,
            _ => return Err("PDF has no catalog".to_string()),
        };
        // The Metadata stream is written as an INDIRECT object, as pikepdf
        // does. (S1 caveat, 07 §10.1: lopdf's naive `dict.set` inlines the
        // stream into the catalog object — a consumer objected, pikepdf/qpdf
        // rejects nested streams, so the object is split out per 08/01 §5.)
        let metadata_id = (doc.max_id + 1, 0);
        doc.objects.insert(
            metadata_id,
            lopdf::Object::Stream(lopdf::Stream::new(
                lopdf::dictionary! {
                    "Type" => "Metadata",
                    "Subtype" => "XML",
                },
                packet.as_bytes().to_vec(),
            )),
        );
        doc.max_id += 1;
        let catalog = doc.get_object_mut(root_id).map_err(|e| e.to_string())?;
        if let lopdf::Object::Dictionary(dict) = catalog {
            dict.remove(b"Metadata");
            dict.set("Metadata", lopdf::Object::Reference(metadata_id));
        } else {
            return Err("PDF catalog is not a dictionary".to_string());
        }

        // Info dict: semantic-level fields (D6: Producer corrected, /Trapped
        // as a proper name, xmp-inject.ts:32-36). /Creator is preserved.
        let info_id = match doc.trailer.get(b"Info") {
            Ok(lopdf::Object::Reference(id)) => *id,
            _ => {
                return Err(
                    "PDF has no Info dict; refusing to write metadata into nothing".to_string(),
                )
            }
        };
        let info_obj = doc.get_object_mut(info_id).map_err(|e| e.to_string())?;
        if let lopdf::Object::Dictionary(dict) = info_obj {
            dict.set(
                "Title",
                lopdf::Object::String(
                    info.title.clone().into_bytes(),
                    lopdf::StringFormat::Literal,
                ),
            );
            dict.set(
                "Author",
                lopdf::Object::String(
                    info.author.clone().into_bytes(),
                    lopdf::StringFormat::Literal,
                ),
            );
            dict.set(
                "Keywords",
                lopdf::Object::String(
                    info.keywords.clone().into_bytes(),
                    lopdf::StringFormat::Literal,
                ),
            );
            dict.set(
                "Producer",
                lopdf::Object::String(
                    info.producer.clone().into_bytes(),
                    lopdf::StringFormat::Literal,
                ),
            );
            dict.set("Trapped", lopdf::Object::Name(b"False".to_vec()));
        } else {
            return Err("PDF Info is not a dictionary".to_string());
        }

        // Save with traditional xref / no object streams so the Info dict is
        // readable (xmp-inject.ts:50); write to the temp sibling — this also
        // fixes the pikepdf .tmp-bypasses-255-bytes defect (07 §12.2).
        if std::env::var("PDF_WRITER_DEBUG").is_ok() {
            eprintln!("stage: pre-save");
        }
        doc.save(&part_path).map_err(|e| e.to_string())?;
        if std::env::var("PDF_WRITER_DEBUG").is_ok() {
            eprintln!("stage: post-save");
        }

        // Loud failure (07 §12.1): a document without the packet is an error.
        // The saved file is byte-searched for the packet head (the stream is
        // uncompressed) and re-parsed for validity.
        let saved_bytes = std::fs::read(&part_path).map_err(|e| e.to_string())?;
        let head = &packet.as_bytes()[..packet.len().min(48)];
        if !saved_bytes.windows(head.len()).any(|w| w == head) {
            return Err("PDF writer produced a document without the XMP packet".to_string());
        }
        lopdf::Document::load(&part_path).map_err(|e| e.to_string())?;

        std::fs::rename(&part_path, pdf_path).map_err(|e| e.to_string())?;
        Ok(())
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&part_path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_elements_self_close() {
        let input = "<a></a><b x=\"1\"></b><c>keep</c>";
        assert_eq!(
            normalize_empty_elements(input),
            "<a/><b x=\"1\"/><c>keep</c>"
        );
    }

    #[test]
    fn packet_tail_newlines() {
        let input = "</x:xmpmeta>\n<?xpacket end=\"w\"?>";
        let out = lxml_normalisations(input);
        assert_eq!(out, "</x:xmpmeta>\n\n<?xpacket end=\"w\"?>\n");
    }

    #[test]
    fn nested_tags_are_not_touched() {
        let input =
            "<dc:description>\n        <rdf:Alt>\n        </rdf:Alt>\n      </dc:description>";
        // Multiline element bodies stay untouched — only same-line empty
        // pairs self-close.
        let out = normalize_empty_elements(input);
        assert_eq!(out, input);
    }
}
