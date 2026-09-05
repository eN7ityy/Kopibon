//! Response types (api-client.ts:5-123) — field-for-field the JSON of
//! openapi_documentation.json. TS's optional fields map to Option with
//! serde(default) so an omitted field stays absent rather than invented.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct GalleryListItem {
    pub id: i64,
    pub media_id: String,
    pub english_title: String,
    #[serde(default)]
    pub japanese_title: Option<String>,
    pub thumbnail: String,
    pub thumbnail_width: i64,
    pub thumbnail_height: i64,
    pub num_pages: i64,
    pub num_favorites: i64,
    #[serde(default)]
    pub tag_ids: Vec<i64>,
    #[serde(default)]
    pub blacklisted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SearchResponse {
    pub result: Vec<GalleryListItem>,
    pub num_pages: i64,
    pub per_page: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct CoverInfo {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub width: i64,
    #[serde(default)]
    pub height: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PageInfo {
    pub number: i64,
    pub path: String,
    pub width: i64,
    pub height: i64,
    pub thumbnail: String,
    pub thumbnail_width: i64,
    pub thumbnail_height: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct TagResponse {
    pub id: i64,
    #[serde(rename = "type", default)]
    pub tag_type: String,
    #[serde(default)]
    pub name: String,
    // TS reads these as `undefined` when absent — lenient defaults mirror
    // that rather than inventing a parse failure the source never has.
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub count: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_community: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_describe_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct GalleryTitle {
    #[serde(default)]
    pub english: String,
    #[serde(default)]
    pub japanese: Option<String>,
    #[serde(default)]
    pub pretty: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GalleryDetail {
    pub id: i64,
    #[serde(default)]
    pub media_id: String,
    pub title: GalleryTitle,
    #[serde(default)]
    pub cover: CoverInfo,
    #[serde(default)]
    pub thumbnail: CoverInfo,
    #[serde(default)]
    pub scanlator: String,
    #[serde(default)]
    pub upload_date: i64,
    #[serde(default)]
    pub tags: Vec<TagResponse>,
    pub num_pages: i64,
    #[serde(default)]
    pub num_favorites: i64,
    /// Only present when ?include=favorite is passed (requires API key).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_favorited: Option<bool>,
    pub pages: Vec<PageInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CdnConfig {
    pub image_servers: Vec<String>,
    pub thumb_servers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnnouncementLink {
    pub text: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Announcement {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub links: Option<Vec<AnnouncementLink>>,
}

/// GET /config response — the API does not return a rate limit here; limits
/// are per-endpoint (rate-limiter.ts).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ApiConfig {
    pub image_servers: Vec<String>,
    pub thumb_servers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub announcement: Option<Announcement>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UserProfile {
    pub id: i64,
    pub username: String,
    #[serde(default)]
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FavoritesResponse {
    pub result: Vec<GalleryListItem>,
    pub num_pages: i64,
    pub per_page: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FavoriteResponse {
    pub favorited: bool,
    #[serde(default)]
    pub num_favorites: Option<i64>,
}
