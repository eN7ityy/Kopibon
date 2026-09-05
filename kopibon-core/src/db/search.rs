//! `buildLibraryFilter()` port (library.repo.ts:19-98; spec 03-data-model §9).
//!
//! Free text fans out OR'd over the 7 text columns + `CAST(gallery_id AS
//! TEXT)`, every value a bound parameter with `ESCAPE '\'`, NOCASE.
//! **`file_path` is not searched.** Tag filters are substring LIKE over the
//! comma-joined `custom_tags` — the over-match (`maid` hits `maids`) is the
//! USER DECISION of 05-DB §6, preserved verbatim in Phase A.

use rusqlite::types::Value as SqlValue;

#[derive(Debug, Clone, Default)]
pub struct LibraryFilterParams<'a> {
    pub search_query: Option<&'a str>,
    pub artist_filters: &'a [String],
    pub series_filters: &'a [String],
    pub tag_filters: &'a [String],
    pub show_unmatched_only: bool,
}

/// `escapeLikePattern` (library.repo.ts:19-21): escapes `\ % _`.
pub fn escape_like_pattern(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if c == '\\' || c == '%' || c == '_' {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The WHERE clause + bound parameters. Returns None when no condition
/// applies (the filter is absent).
pub struct Filter {
    pub sql: String,
    pub params: Vec<SqlValue>,
}

pub fn build_library_filter(params: &LibraryFilterParams) -> Option<Filter> {
    let mut conditions: Vec<String> = Vec::new();
    let mut bound: Vec<SqlValue> = Vec::new();

    if let Some(query) = params.search_query {
        let trimmed = query.trim();
        if !trimmed.is_empty() {
            let pattern = format!("%{}%", escape_like_pattern(trimmed));
            let columns = [
                "custom_title",
                "primary_artist",
                "series_name",
                "custom_tags",
                "publisher",
                "language",
                "description",
            ];
            let mut ors: Vec<String> = Vec::new();
            for column in columns {
                ors.push(format!("{column} LIKE ? ESCAPE '\\' COLLATE NOCASE"));
                bound.push(SqlValue::Text(pattern.clone()));
            }
            // The nhentai id too, cast to text (library.repo.ts:71).
            ors.push("CAST(gallery_id AS TEXT) LIKE ? ESCAPE '\\'".to_string());
            bound.push(SqlValue::Text(pattern));
            conditions.push(format!("({})", ors.join(" OR ")));
        }
    }

    if !params.artist_filters.is_empty() {
        let placeholders = vec!["?"; params.artist_filters.len()].join(", ");
        conditions.push(format!("primary_artist IN ({placeholders})"));
        for a in params.artist_filters {
            bound.push(SqlValue::Text(a.clone()));
        }
    }

    if !params.series_filters.is_empty() {
        let placeholders = vec!["?"; params.series_filters.len()].join(", ");
        conditions.push(format!("series_name IN ({placeholders})"));
        for s in params.series_filters {
            bound.push(SqlValue::Text(s.clone()));
        }
    }

    if !params.tag_filters.is_empty() {
        let mut ors: Vec<String> = Vec::new();
        for tag in params.tag_filters {
            ors.push("custom_tags LIKE ? ESCAPE '\\' COLLATE NOCASE".to_string());
            bound.push(SqlValue::Text(format!("%{}%", escape_like_pattern(tag))));
        }
        conditions.push(format!("({})", ors.join(" OR ")));
    }

    if params.show_unmatched_only {
        conditions.push("(gallery_id IS NULL OR gallery_id = 0)".to_string());
    }

    if conditions.is_empty() {
        None
    } else {
        Some(Filter {
            sql: conditions.join(" AND "),
            params: bound,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_wildcards() {
        assert_eq!(escape_like_pattern("50%_off\\x"), "50\\%\\_off\\\\x");
    }

    #[test]
    fn filter_shape() {
        let params = LibraryFilterParams {
            search_query: Some("maid"),
            tag_filters: &[],
            artist_filters: &[],
            series_filters: &[],
            show_unmatched_only: false,
        };
        let f = build_library_filter(&params).unwrap();
        assert_eq!(f.params.len(), 8); // 7 columns + gallery_id
        assert!(f.sql.contains("CAST(gallery_id AS TEXT)"));
        assert!(f.sql.contains("ESCAPE '\\'"));
        assert!(
            !f.sql.contains("file_path"),
            "file_path must not be searched"
        );
    }
}
