//! The metadata engine (docs/rust-port/08-subsystem-plans/01).
//!
//! The normative contract is docs/rust-port/07-metadata-spec.md; this module
//! is pure — no DB, HTTP or clock reads outside `Clock` impls.

pub mod context;
pub mod filenames;
pub mod js_number;
pub mod mappers;
pub mod template;
pub mod templates_io;
pub mod writers;
pub mod xml_utils;
