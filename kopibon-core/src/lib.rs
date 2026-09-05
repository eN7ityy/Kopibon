//! kopibon-core — the Rust port's headless core.
//!
//! Phase A builds this as a library + headless CLI, differentially tested
//! against live 1.x (docs/rust-port/09-migration-phases.md §Phase A).
//! Module layout mirrors docs/rust-port/08-subsystem-plans/01 §1.

pub mod cli_support;
pub mod conversion;
pub mod db;
pub mod download;
pub mod kavita;
pub mod metadata;
pub mod nhentai;
pub mod scanner;
pub mod series_grouping;
pub mod sync;
