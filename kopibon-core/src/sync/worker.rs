//! sync.worker.ts port — one item per invocation: fetch with retry, rebuild
//! canonical metadata, rewrite the archive IN PLACE. The archive rewrite is
//! why cancel never terminates an in-flight sync (03 §2).

use serde_json::{json, Value};

use crate::nhentai::http::Transport;
use crate::nhentai::sync_fetch::{fetch_gallery, SYNC_USER_AGENT};

/// The flat payload the main side commits to the library row (:196-202).
#[derive(Debug, Clone, PartialEq)]
pub struct SyncFlatMetadata {
    pub title: String,
    pub primary_artist: String,
    pub tags: String,
    pub language: Option<String>,
    pub publisher: Option<String>,
}

/// The complete result posted back (:180-202).
#[derive(Debug, Clone)]
pub enum SyncOutcome {
    Success {
        raw_tags: Value,
        gallery: Value,
        metadata: SyncFlatMetadata,
    },
    Error {
        message: String,
    },
}

/// The command (sync.worker.ts:12-37). Series comes from OUR database —
/// nhentai has none, and omitting it silently dissolved series members.
pub struct SyncCommand<'a> {
    pub item_id: i64,
    pub nhentai_id: i64,
    pub file_path: &'a str,
    pub format: &'a str,
    pub api_key: Option<&'a str>,
    pub series_name: Option<&'a str>,
    pub series_index: Option<f64>,
}

/// syncItem (:84-203): fetch → rebuild → in-place rewrite → post back.
pub fn sync_item<T: Transport>(
    transport: &T,
    cmd: &SyncCommand<'_>,
    clock: &dyn crate::metadata::mappers::Clock,
    jitter_ms: i64,
    sleep: &mut dyn FnMut(i64),
) -> SyncOutcome {
    let (fetch_result, _attempts) = fetch_gallery(transport, cmd.nhentai_id, cmd.api_key, jitter_ms, sleep);
    let gallery = match fetch_result {
        Ok(g) => g,
        Err(e) => {
            return SyncOutcome::Error {
                message: format!("Sync failed for gallery {}: {e}", cmd.nhentai_id),
            }
        }
    };

    // Metadata rebuild (:88-142).
    let title = gallery
        .pointer("/title/pretty")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| gallery.pointer("/title/english").and_then(Value::as_str))
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("Gallery #{}", cmd.nhentai_id));
    let tags = gallery.get("tags").and_then(Value::as_array).cloned().unwrap_or_default();
    let artist_tags: Vec<String> = tags
        .iter()
        .filter(|t| t["type"] == "artist")
        .filter_map(|t| t["name"].as_str().map(|s| s.to_string()))
        .collect();
    let group_tags: Vec<String> = tags
        .iter()
        .filter(|t| t["type"] == "group")
        .filter_map(|t| t["name"].as_str().map(|s| s.to_string()))
        .collect();
    // All language-type tags are candidates, in order (:100-104).
    let language = crate::metadata::xml_utils::resolve_language_name(
        &tags
            .iter()
            .filter(|t| t["type"] == "language")
            .map(|t| Some(t["name"].as_str().unwrap_or("").to_string()))
            .collect::<Vec<_>>(),
    );
    let publisher = group_tags.first().cloned();
    let creators: Vec<String> = if !artist_tags.is_empty() {
        artist_tags
    } else if !group_tags.is_empty() {
        group_tags
    } else {
        vec!["Unknown".to_string()]
    };

    // Built from the API gallery so typed tags survive (:116-131). Series
    // from our own DB (:27-37).
    let meta = crate::metadata::context::file_metadata_from_gallery(
        &crate::metadata::context::GalleryMetadata {
            id: cmd.nhentai_id as f64,
            title: crate::metadata::context::GalleryTitle {
                english: Some(
                    gallery
                        .pointer("/title/english")
                        .and_then(Value::as_str)
                        .unwrap_or(&title)
                        .to_string(),
                ),
                japanese: gallery
                    .pointer("/title/japanese")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string()),
                pretty: Some(
                    gallery
                        .pointer("/title/pretty")
                        .and_then(Value::as_str)
                        .unwrap_or(&title)
                        .to_string(),
                ),
            },
            tags: tags
                .iter()
                .map(|t| crate::metadata::context::TagLike {
                    id: t["id"].as_f64(),
                    r#type: t["type"].as_str().unwrap_or("tag").to_string(),
                    name: t["name"].as_str().unwrap_or("").to_string(),
                })
                .collect(),
            upload_date: Some(gallery["upload_date"].as_f64().unwrap_or(0.0)),
            num_pages: Some(gallery["num_pages"].as_f64().unwrap_or(0.0)),
            series_name: cmd.series_name.map(|s| s.to_string()),
            series_index: cmd.series_index,
            language: None,
            publisher: publisher.clone(),
            description: None,
            media_id: gallery["media_id"].as_str().and_then(|s| s.parse().ok()),
            favorites: gallery["num_favorites"].as_f64(),
            cover_url: None,
            thumbnail_url: None,
            scanlator: None,
        },
        crate::metadata::context::FileMetadataOverrides {
            title: Some(title.clone()),
            series_name: cmd.series_name.map(|s| s.to_string()),
            series_index: cmd.series_index,
            format: Some(cmd.format.to_string()),
            ..Default::default()
        },
    );

    // In-place rewrite — one call for both formats (:146).
    let format = crate::metadata::context::Format::parse_format(cmd.format);
    let result = crate::metadata::writers::apply_metadata(
        std::path::Path::new(cmd.file_path),
        format,
        &meta,
        clock,
        clock.now_ms() as u64,
    );
    if let Err(e) = result {
        let what = if cmd.format == "cbz" { "ComicInfo rewrite" } else { "XMP write" };
        return SyncOutcome::Error { message: format!("{what} failed: {e}") };
    }

    SyncOutcome::Success {
        raw_tags: json!(tags
            .iter()
            .map(|t| json!({
                "id": t["id"].as_i64().unwrap_or(0),
                "type": t["type"].as_str().unwrap_or(""),
                "name": t["name"].as_str().unwrap_or(""),
            }))
            .collect::<Vec<_>>()),
        gallery,
        metadata: SyncFlatMetadata {
            title,
            primary_artist: creators[0].clone(),
            tags: tags
                .iter()
                .filter_map(|t| t["name"].as_str())
                .collect::<Vec<_>>()
                .join(", "),
            language: language.clone(),
            publisher,
        },
    }
}

/// The UA is asserted by fixtures (03 §4.3) — re-exported for the test.
pub fn sync_user_agent() -> &'static str {
    SYNC_USER_AGENT
}
