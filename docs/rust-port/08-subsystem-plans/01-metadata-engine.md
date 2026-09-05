# Subsystem plan 01 — Metadata engine (`kopibon-core::metadata`)

Execution plan for the implementing agent building the metadata engine as the
`kopibon-core::metadata` module in Phase A (headless, differentially tested
against live 1.x — [09-migration-phases.md](../09-migration-phases.md)). The
**normative contract is [07-metadata-spec.md](../07-metadata-spec.md)**; this
document does not restate its rules, it says how to build the code that
satisfies them and how to prove it. Supporting context:
[01-current-architecture.md](../01-current-architecture.md) §4,
[03-data-model.md](../03-data-model.md) (no DB here — this crate is pure),
D2/D3/D6/D7 of the planning plan
([00-planning-plan.md](../../../plans/kopibon_rust_port/00-planning-plan.md)).

Phase A exit gate (whole port): **the field × mutation matrix of
07-metadata-spec §4–§6 is green at its stated parity levels** (byte for
ComicInfo/`/Keywords`/ZIP, byte for XMP via the S1 normalisations, semantic for
the Info dict).

---

## 1. Module boundaries

One workspace crate, `kopibon-core`, metadata as a subtree — no separate crate
(the scanner and download manager need these types by value):

```
kopibon-core/src/metadata/
├── mod.rs            // re-exports; no logic
├── template.rs       // port of services/metadata/template-engine.ts (162 lines)
├── templates_io.rs   // port of services/metadata/templates.ts (resolution, cache, seeding)
├── context.rs        // port of services/metadata/file-metadata.ts (FileMetadata + adapters)
├── mappers.rs        // port of services/metadata/mappers.ts (contexts, /Keywords, docinfo)
├── xml_utils.rs      // port of services/xml-utils.ts (escape/decode/language)
├── js_number.rs      // JS Number::toString + toFixed semantics for f64 (see §3)
├── filenames.rs      // port of gallery-filename.ts + the three sanitisers + temp-path.ts
└── writers/
    ├── mod.rs        // apply_metadata dispatcher (port of src/main/services/apply-metadata.ts:204-220)
    ├── comicinfo.rs  // ComicInfo.xml render + CBZ rewrite pass
    ├── pdf.rs        // lopdf-based XMP + Info-dict writer
    └── zip.rs        // hand-rolled STORE-only ZIP writer (S3)
```

Dependency rule: `metadata` may not depend on the DB, HTTP, or GUI layers.
Everything volatile (time, page lists, entry lists) arrives as parameters —
that is what makes the golden corpus freezable (§6). The scanner
([02-library-scanner.md](02-library-scanner.md)) consumes `context.rs` +
`filenames.rs`; the download manager
([03-download-manager.md](03-download-manager.md)) consumes `writers`.

## 2. Crates

| Need | Crate | Notes |
|---|---|---|
| Anchored regexes (PLACEHOLDER/BLOCK_OPEN/BLOCK_CLOSE, XMP/ComicInfo parse) | `regex` | JS non-multiline `^$` == Rust default text anchors |
| Inline-section backreference `\1` | hand-rolled scan, not `fancy-regex` | one `{{#name}}…{{/name}}` finder, ~30 lines; exactly mirrors the loop-until-stable semantics (src/main/services/metadata/template-engine.ts:99-107) and avoids a second regex engine |
| PDF read/write | `lopdf` | proven by spike S1 (07-metadata-spec §10.1); single PDF dependency shared with the download manager's assembler |
| CRC-32 for the ZIP writer | `crc32fast` | |
| SHA-1 for thumbnail names / temp stamp | `sha1` | |
| Time (`toISOString`, `getFullYear`, 2-digit pad) | `jiff` | UTC-only use; `chrono` acceptable if the workspace already pins it — do not mix |
| XML | none | both parse sides are per-field regexes by design (src/main/services/comicinfo.ts:53-58, src/main/services/library-scanner.worker.ts:123-149); porting them verbatim is the parity requirement, not a shortcut |

No version pinning here — `13-licence-audit.md` and the workspace `Cargo.toml`
own versions. The `zip` crate is **not** used for writes (S3, 07-metadata-spec
§10.2); reading CBZs for the scanner may use it, writes may not.

## 3. Public API sketch

```rust
// context.rs — field-for-field port of src/main/services/metadata/file-metadata.ts:117-176 (carry every
// field, including the unused-by-templates ones: mediaId, favorites, coverUrl,
// thumbnailUrl, scanlator, galleryPageCount — 07-metadata-spec §4)
pub struct FileMetadata { /* ... */ }
pub fn default_file_metadata() -> FileMetadata;             // src/main/services/metadata/file-metadata.ts:185-215
pub fn make_file_metadata(partial: Partial) -> FileMetadata; // :218-220
pub fn file_metadata_from_gallery(g: &GalleryDetail, o: Overrides) -> FileMetadata; // :277
pub fn file_metadata_from_library_item(row: &LibraryItemRow, o: Overrides) -> FileMetadata; // :317
pub fn file_metadata_from_payload(p: &MetadataPayload) -> FileMetadata; // :365

// mappers.rs — rule-for-rule port (07-metadata-spec §4 is the table of truth)
pub fn build_comic_info_xml(meta: &FileMetadata, templates: &TemplateStore) -> Result<Vec<u8>>;
pub fn build_xmp_xml(meta: &FileMetadata, templates: &TemplateStore, clock: &dyn Clock) -> Vec<u8>;
pub fn build_keyword_tokens(meta: &FileMetadata) -> Vec<String>;   // src/main/services/metadata/mappers.ts:267-281
pub fn build_doc_info(meta: &FileMetadata, clock: &dyn Clock) -> DocInfo; // :284-296

// writers/pdf.rs — replaces xmp-inject.ts wholesale (D3: no Python/pikepdf)
pub fn write_pdf_metadata(pdf_path: &Path, meta: &FileMetadata, clock: &dyn Clock) -> Result<()>;
pub fn generate_image_pdf(images: &[PathBuf], out: &Path, opts: PdfOptions, log: &dyn Log) -> Result<PathBuf>;

// writers/zip.rs — S3 writer; also the CBZ entry of generate_cbz
pub struct StoreZipWriter<W: Write> { /* mtime params, not clock reads */ }
impl<W: Write> StoreZipWriter<W> {
    pub fn new(sink: W) -> Result<Self>;
    pub fn add_first_entry(&mut self, name: "ComicInfo.xml", bytes: &[u8]) -> Result<()>; // flag 0x0800
    pub fn add_streamed(&mut self, name: &str, r: impl Read, mtime: SystemTime) -> Result<()>; // 0x0808 + descriptor
    pub fn finish(self) -> Result<()>;
}
pub fn rewrite_comic_info_in_cbz(path: &Path, meta: &FileMetadata, templates: &TemplateStore) -> Result<()>; // src/main/services/apply-metadata.ts:114-192

// writers/mod.rs — the one entry point every write path calls (src/main/services/apply-metadata.ts:204-220)
pub fn apply_metadata(path: &Path, format: Format, meta: &FileMetadata, clock: &dyn Clock, templates: &TemplateStore) -> Result<(), String>;

// filenames.rs
pub fn apply_gallery_id_to_filename(name: &str, gallery_id: Option<u32>) -> String; // src/main/services/gallery-filename.ts:42-54
pub fn temp_sibling_path(final_path: &Path) -> PathBuf;                             // src/main/services/temp-path.ts:79-90
pub fn truncate_to_bytes(value: &str, max: usize) -> String;                        // src/main/services/temp-path.ts:54-66
```

`Clock` is one trait (`now_iso8601()`, `now_system_time()`), threaded through
every writer and the XMP context — never `SystemTime::now()` inline (§6).

## 4. Template engine port notes

Port `src/main/services/metadata/template-engine.ts` line-for-line; the formal
spec (grammar, emptiness, drop rule, sections, each, newline handling) is
07-metadata-spec §2 and is **not** restated here. Implementation notes:

- **Two normalisations, nothing more (S1).** After `render`, the XMP artefact
  applies exactly: (a) self-close empty elements, (b) the packet-tail newline
  (07-metadata-spec §2, spike evidence §10.1). Implement as two explicit
  string/byte passes in `writers/pdf.rs`, documented as "the lxml emulation" —
  do not generalise them into a serialiser, do not apply them to ComicInfo.
- **Byte-level string handling.** The 1.x engine is UTF-16-JS; the port is
  UTF-8. All splitting/joining is on `\n` so no surrogate hazard exists, but:
  (1) line-drop and section matching must operate on `char` boundaries — never
  byte-slice a template line; (2) `String(value)` for numbers is *not* Rust's
  `f64` `Display` — `1e21` prints `1e+21` in JS, and `toFixed(2)` rounds by
  ECMAScript rules which differ from Rust's round-half-to-even `format!`.
  `js_number.rs` implements both with vectors from the JS harness (§7) —
  `seriesIndex.toFixed(2)` (src/main/services/metadata/mappers.ts:247) is the shipped template's only
  toFixed call but the context builder must be exactly right anyway.
- **Error messages are load-bearing.** `findClose` throws with 1-based line
  numbers and the exact strings of src/main/services/metadata/template-engine.ts:89, :95 — port them
  verbatim; the diff harness compares error strings, not just error presence.
- **No escaping in the engine** (src/main/services/metadata/template-engine.ts:24-27); `xml_utils::escape`
  (src/main/services/xml-utils.ts:28-36: illegal-char strip first, then `& < > " '`, ampersand
  first) lives in the mapper, `xml_utils::decode` (:47-56, ampersand last) in
  the parse sides.
- **Template resolution** (src/main/services/metadata/templates.ts:42-62, :105-120, :142-162): search
  order `$DOUJIN_TEMPLATE_DIR` → packaged resources dir → ≤6-level cwd walk;
  mtime-invalidated cache; throw with the multi-line "Looked in:" message;
  `install_user_templates` seeds `<dataDir>/metadata-templates/` without
  overwriting. In Rust there are no worker isolates, so the env-var
  inheritance dance collapses to one process-global `TemplateStore`; still
  honour `DOUJIN_TEMPLATE_DIR` (07-metadata-spec §4 item 6).

## 5. The writer split

All three writers take a `FileMetadata` and produce one artefact; no writer
computes policy (that is `mappers.rs`) and no writer invents a filename (that
is `filenames.rs` + callers).

- **ComicInfoWriter** — render `comicinfo.template` against
  `comicInfoContext` (src/main/services/metadata/mappers.ts:190-213), bytes as-is. Used fresh by
  `StoreZipWriter::add_first_entry` (src/main/services/cbz-generator.ts:110) and for the
  rewrite pass (src/main/services/apply-metadata.ts:114-192): pass 1 lists entry names to derive
  `PageCount` (`:121-127` — always derived, never trusted, src/main/services/cbz-generator.ts:63),
  pass 2 rebuilds into `temp_sibling_path`, ComicInfo first, every other entry
  copied STOREd in original order skipping directories, rename only after a
  clean finish, unlink the partial on any failure (:183-191).
- **PdfWriter (lopdf)** — the Python script's exact operations
  (src/main/services/xmp-inject.ts:20-54) become: open with `lopdf::Document::load`,
  `doc.trailer`/Root delete of any existing `/Metadata` (:38-40), set Info
  `/Title /Author /Keywords` (+ `/Producer` = `"Kopibon 2.x"` per D6 — a
  sanctioned deviation, and `/Trapped` as a proper `/False` name, not the
  string `'/False'`), insert the rendered XMP bytes as an **uncompressed**
  stream with `/Type /Metadata /Subtype /XML` (:42-46), save with object
  stream mode off / stream compression off (:50) so the Info dict is plainly
  readable, atomic replace into place (via `temp_sibling_path`, which also
  fixes the `.tmp`-bypasses-255-bytes bug for free — 07-metadata-spec §12.2).
 pikepdf's silent empty-metadata failure becomes loud (07-metadata-spec §12.1):
  a writer that produced a document without the packet must error, not warn.
  **Indirect-object caveat (S1):** lopdf inlines the metadata dict into the
  catalog object where pikepdf wrote an indirect object — both parse; keep the
  S1 note, and if a consumer ever objects, split the object out then (07
  §10.1). Whole-PDF bytes are explicitly not a target (07 §1).
- **ZipWriter** — hand-rolled STORE-only, the S3 field list is the test
  contract (07-metadata-spec §10.2): version-made-by 831 (6.3/Unix),
  version-needed 20, method 0, ComicInfo.xml first with local sizes and flag
  0x0800, pages streamed `%04d.{ext}` with flag 0x0808 + 16-byte data
  descriptor (sig `PK\x07\x08`), UT extra (`55 54 05 00 03 + mtime`) in the
  central directory only, internal attrs 0, external attrs 0x81B40000 (ComicInfo)
  / 0x81A40000 (pages), no comment. mtimes are parameters. Validate outputs
  with Python `zipfile` in the test harness as S3 did.

## 6. Volatile-field injection (normative table: 07-metadata-spec §9)

`xmp:MetadataDate`, `dc:date` now-fallback, `calibre:timestamp`,
`/CreationDate`, `/ModDate`, ZIP DOS time + `UT` mtimes — every one via the
`Clock` trait or explicit mtime parameters. Tests freeze the clock per fixture;
no test may read the wall clock. Page ordering is explicit in fixtures (07 §9).

## 7. Sanitiser triplet (rules: 07-metadata-spec §7 — port all three, verbatim)

| Sanitiser | Port to | TS cite |
|---|---|---|
| Download (`_`-substitute, 180 cap, ` [nhentai-{id}]` suffix) | `filenames.rs::sanitize_download_title` | src/main/services/download-manager.ts:552-553 |
| Custom entry (**deletes** the class, 120 cap, **prefix** `[nhentai-00000] `) | `filenames.rs::sanitize_custom_entry_title` | src/main/ipc/library.ipc.ts:1311-1317 |
| Directory segment (`_`-substitute + leading-dot strip + 180 + `'Unknown'`) | `filenames.rs::safe_path_segment` | src/main/services/convert-cbz.worker.ts:74-81 |

Plus the marker machinery (`/\s*\[nhentai-\d+\]\s*/g` matched anywhere,
stem-only byte truncation, `trimEnd`, empty stem → `Untitled`,
255-byte basename rule, code-point-safe truncation — src/main/services/gallery-filename.ts:14,
:42-54; src/main/services/temp-path.ts:37, :54-66, :79-90). Required tests: 251–255-byte
boundary with real Japanese titles; truncation never splits a code point;
OsStr/UTF-16 Windows hazard documented per 07-metadata-spec §7.

## 8. Differential testing against 1.x

**JS harness.** Phase A keeps a `tests/differential/harness.mjs` (dev tree
only, never shipped) importing the built 1.x modules from `dist/`: a Rust test
binary spawns `node harness.mjs <op> <context.json>` against
`buildComicInfoXml`, `buildXmpXml`, `buildDocInfo`/`buildKeywordTokens`,
`generateCbz`, `applyXmpWithPikepdf`, `parseComicInfoXml`,
`applyGalleryIdToFilename`, `tempSiblingPath`, and compares the returned
bytes against the Rust output at each artefact's parity level.

- **Fixtures:** the 3 golden files of 07-metadata-spec §11
  (`/mnt/bragi/Kavita/DoujinsTest/`): fixture 1 (51-entry CBZ, legacy Notes,
  one-shot), fixture 2 (36-entry CBZ, publisher/characters/Genre), fixture 3
  (16-page PDF, full Info dict + 1782-byte XMP). ComicInfo byte-parity tests
  exclude the `Notes` line (pre-rebrand fixtures; Q11 resolution, 07 §11).
- **Generated contexts:** for each of the three context builders, generate
  contexts over a matrix of inputs: empty/all-populated metadata, `galleryId`
  ∈ {absent, 0, 528499}, `seriesIndex` ∈ {absent, 0, 1, 2.5, 1e21},
  `releaseDate` ∈ {absent, fixed}, tags/parodies/categories 0..n,
  `titleJapanese` present/absent, CRLF and trailing-newline template variants,
  characters needing every XML escape and illegal-char strip.
- **Mutation matrix:** the 12 write paths of 07-metadata-spec §6 are exercised
  through `apply_metadata` against cloned golden files; each cell = one
  artefact diffed at its stated parity level. The write-path list is the
  matrix's rows; do not invent a 13th or drop one.
- **Fuzz plan (template engine).** Seed corpus = the 26 cases of
  `src/main/services/metadata/template-engine.test.ts` (substitution 12,
  optional lines 6, sections 9, each 4, file shape 3 — 07-metadata-spec §2).
  Generator: random nesting of block/inline/each, random `?` markers, random
  context shapes (missing keys, `0`, `'0'`, `true`, `false`, `[]`, arrays with
  commas/newlines), random CRLF/trailing-newline shapes. Each case must give
  equal output **and equal error string** in JS and Rust; minimum 10k cases
  per CI run plus a nightly 1M soak; any mismatch shrinks to a fixed vector.
  Fuzz the XML escaper/decoder the same way (`decode(escape(x)) == x`;
  known non-round-trip cases pinned as current behaviour).
- **PDF writer acceptance:** byte-compare the XMP packet stream inside the
  written PDF against the golden 1782 bytes; compare Info values semantically;
  page count preserved; lopdf caveat re-asserted each run (07 §10.1).
- **ZIP acceptance:** the S3 structural-field checklist, field by field, on a
  golden CBZ rebuild of fixture 1 (D7: current Notes string, so the ComicInfo
  entry diff excludes the Notes line).

## 9. Exit criteria

1. Field × mutation matrix (07 §4–§6) green at stated parity levels — the
   Phase A gate, no exceptions (05-baselines §5: parity over numbers).
2. Differential template fuzz: seed corpus 26/26 byte-exact incl. errors;
   nightly soak clean for three consecutive runs.
3. Golden corpus: 3/3 fixtures reproduce at their levels (Notes exclusion
   applied); Python `zipfile` validates every CBZ the writer emits.
4. All three sanitisers byte-identical to JS on the boundary suite.
5. No `SystemTime::now()` anywhere under `metadata/` outside `Clock` impls
   (grep-enforced in CI).

## 10. Risks

| Risk | Mitigation |
|---|---|
| JS/Rust regex whitespace-class drift on template lines | fuzz over unicode whitespace in templates; restrict templates to ASCII whitespace as a lint with the fuzz as the backstop |
| `toFixed`/`Number::toString` divergence on adversarial floats | `js_number.rs` tested against JS-generated vectors incl. 1e21, 2.675, 1.005 |
| lopdf version changes inlining behaviour | pin in workspace; the S1 caveat test re-runs on every bump |
| Golden corpus drift (fixtures on a network mount) | copy fixtures into the repo's test data area (read-only) at Phase A start; record provenance |
| Users' edited templates exercise engine corners the shipped ones don't | the fuzz's generated-template breadth exists for exactly this; do not "simplify" the engine when a corner looks unused |
