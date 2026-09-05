//! Hand-rolled STORE-only ZIP writer — the S3 deliverable
//! (07-metadata-spec §10.2, 08/01 §5). The `zip` crate is **not** used for
//! writes; its structural field list is the test contract:
//!
//! - version-made-by 831 (6.3 / create_system 3 Unix), version-needed 20
//! - method 0 (STORE)
//! - `ComicInfo.xml` first, buffered: local CRC+sizes, flag 0x0800
//! - pages streamed: flag 0x0808 + 16-byte data descriptor (sig `PK\x07\x08`)
//! - UT extra (`55 54 05 00 03 + mtime`) **in the central directory only**
//! - internal attrs 0; external attrs `0x81B40000` (0664) for ComicInfo,
//!   `0x81A40000` (0644) for pages
//! - no archive comment; 4-digit page names are the caller's job
//! - mtimes are parameters, never clock reads (07-metadata-spec §9)

use std::io::{Read, Write};

const LOCAL_SIG: u32 = 0x0403_4B50;
const DESC_SIG: u32 = 0x0807_4B50;
const CENTRAL_SIG: u32 = 0x0201_4B50;
const EOCD_SIG: u32 = 0x0605_4B50;
const VERSION_MADE_BY: u16 = 831; // 6.3, create_system 3 (Unix)
const VERSION_NEEDED: u16 = 20;
const FLAG_UTF8: u16 = 0x0800;
const FLAG_DESCRIPTOR: u16 = 0x0008;
const UT_EXTRA_LEN: u16 = 9; // 'UT' + u16 len + flags byte + u32 mtime

/// DOS date/time from unix seconds. yazl derives the fields from the entry
/// mtime's **local** civil components (yazl index.js:476), so the conversion
/// goes through the system timezone (TZ), matching the JS side under the
/// same environment.
fn secs_to_dos(secs: u64) -> (u16, u16) {
    let secs = i64::try_from(secs).unwrap_or(0);
    let Ok(ts) = jiff::Timestamp::from_second(secs) else {
        return (0, 0);
    };
    let z = ts.to_zoned(jiff::tz::TimeZone::system());
    let (h, m, s) = (z.hour(), z.minute(), z.second());
    let (y, mth, d) = (z.year(), z.month(), z.day());
    let date = (((y - 1980) as i32) << 9) | ((mth as i32) << 5) | (d as i32);
    let time = ((h as i32) << 11) | ((m as i32) << 5) | ((s / 2) as i32);
    (time as u16, date as u16)
}

fn crc32(data: &[u8]) -> u32 {
    let mut hasher = crc32fast::Hasher::new();
    hasher.update(data);
    hasher.finalize()
}

struct CentralRecord {
    name: String,
    flag: u16,
    crc: u32,
    size: u32,
    dos_time: u16,
    dos_date: u16,
    external_attrs: u32,
    mtime: u32,
    offset: u32,
}

/// STORE-only ZIP writer over any sink.
pub struct StoreZipWriter<W: Write> {
    sink: W,
    offset: u32,
    records: Vec<CentralRecord>,
}

impl<W: Write> StoreZipWriter<W> {
    pub fn new(sink: W) -> Self {
        StoreZipWriter {
            sink,
            offset: 0,
            records: Vec::new(),
        }
    }

    /// Add `ComicInfo.xml` as the first entry, buffered with local CRC+sizes
    /// and flag 0x0800, external attrs 0664 (yazl `addBuffer` shape,
    /// cbz-generator.ts:110 + the S3 field list).
    pub fn add_first_entry(&mut self, name: &str, bytes: &[u8], mtime: u64) -> std::io::Result<()> {
        self.add_buffered_mode(name, bytes, mtime, 0o100_664)
    }

    /// Buffered entry with local sizes and flag 0x0800.
    pub fn add_buffered_mode(
        &mut self,
        name: &str,
        bytes: &[u8],
        mtime: u64,
        mode: u32,
    ) -> std::io::Result<()> {
        let crc = crc32(bytes);
        let entry_offset = self.offset;
        self.write_local_header(name, FLAG_UTF8, mtime, Some((crc, bytes.len() as u32)))?;
        self.sink.write_all(bytes)?;
        self.push_record(
            name,
            FLAG_UTF8,
            crc,
            bytes.len() as u32,
            mtime,
            mode << 16,
            entry_offset,
        );
        self.offset += bytes.len() as u32;
        Ok(())
    }

    /// Streamed page entry: flag 0x0808 + data descriptor, external attrs
    /// 0644 (yazl `addReadStream` shape, apply-metadata.ts:174).
    pub fn add_streamed(&mut self, name: &str, r: impl Read, mtime: u64) -> std::io::Result<()> {
        self.add_streamed_mode(name, r, mtime, 0o100_644)
    }

    pub fn add_streamed_mode(
        &mut self,
        name: &str,
        mut r: impl Read,
        mtime: u64,
        mode: u32,
    ) -> std::io::Result<()> {
        let entry_offset = self.offset;
        self.write_local_header(name, FLAG_UTF8 | FLAG_DESCRIPTOR, mtime, None)?;
        let mut hasher = crc32fast::Hasher::new();
        let mut size: u32 = 0;
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = r.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            self.sink.write_all(&buf[..n])?;
            size += n as u32;
        }
        let crc = hasher.finalize();
        let mut descriptor = Vec::with_capacity(16);
        descriptor.extend_from_slice(&DESC_SIG.to_le_bytes());
        descriptor.extend_from_slice(&crc.to_le_bytes());
        descriptor.extend_from_slice(&size.to_le_bytes());
        descriptor.extend_from_slice(&size.to_le_bytes());
        self.sink.write_all(&descriptor)?;
        self.push_record(
            name,
            FLAG_UTF8 | FLAG_DESCRIPTOR,
            crc,
            size,
            mtime,
            mode << 16,
            entry_offset,
        );
        self.offset += size + 16;
        Ok(())
    }

    fn write_local_header(
        &mut self,
        name: &str,
        flag: u16,
        mtime: u64,
        known: Option<(u32, u32)>,
    ) -> std::io::Result<()> {
        let (dos_time, dos_date) = secs_to_dos(mtime);
        let name_bytes = name.as_bytes();
        let mut header = Vec::with_capacity(30 + name_bytes.len());
        header.extend_from_slice(&LOCAL_SIG.to_le_bytes());
        header.extend_from_slice(&VERSION_NEEDED.to_le_bytes());
        header.extend_from_slice(&flag.to_le_bytes());
        header.extend_from_slice(&0u16.to_le_bytes()); // method STORE
        header.extend_from_slice(&dos_time.to_le_bytes());
        header.extend_from_slice(&dos_date.to_le_bytes());
        match known {
            Some((crc, size)) => {
                header.extend_from_slice(&crc.to_le_bytes());
                header.extend_from_slice(&size.to_le_bytes());
                header.extend_from_slice(&size.to_le_bytes());
            }
            None => {
                // Sizes/CRC follow in the data descriptor.
                header.extend_from_slice(&0u32.to_le_bytes());
                header.extend_from_slice(&0u32.to_le_bytes());
                header.extend_from_slice(&0u32.to_le_bytes());
            }
        }
        header.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        header.extend_from_slice(&0u16.to_le_bytes()); // no extra field
        header.extend_from_slice(name_bytes);
        self.sink.write_all(&header)?;
        self.offset += header.len() as u32;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn push_record(
        &mut self,
        name: &str,
        flag: u16,
        crc: u32,
        size: u32,
        mtime: u64,
        external_attrs: u32,
        offset: u32,
    ) {
        let (dos_time, dos_date) = secs_to_dos(mtime);
        self.records.push(CentralRecord {
            name: name.to_string(),
            flag,
            crc,
            size,
            dos_time,
            dos_date,
            external_attrs,
            mtime: mtime as u32,
            offset,
        });
    }

    /// Write the central directory + EOCD. No archive comment (S3 list).
    pub fn finish(mut self) -> std::io::Result<W> {
        let cd_offset = self.offset;
        let mut cd_len: u32 = 0;
        for rec in &self.records {
            let name_bytes = rec.name.as_bytes();
            let mut rec_bytes = Vec::with_capacity(46 + name_bytes.len() + 9);
            rec_bytes.extend_from_slice(&CENTRAL_SIG.to_le_bytes());
            rec_bytes.extend_from_slice(&VERSION_MADE_BY.to_le_bytes());
            rec_bytes.extend_from_slice(&VERSION_NEEDED.to_le_bytes());
            rec_bytes.extend_from_slice(&rec.flag.to_le_bytes());
            rec_bytes.extend_from_slice(&0u16.to_le_bytes()); // method STORE
            rec_bytes.extend_from_slice(&rec.dos_time.to_le_bytes());
            rec_bytes.extend_from_slice(&rec.dos_date.to_le_bytes());
            rec_bytes.extend_from_slice(&rec.crc.to_le_bytes());
            rec_bytes.extend_from_slice(&rec.size.to_le_bytes());
            rec_bytes.extend_from_slice(&rec.size.to_le_bytes());
            rec_bytes.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            rec_bytes.extend_from_slice(&UT_EXTRA_LEN.to_le_bytes());
            rec_bytes.extend_from_slice(&0u16.to_le_bytes()); // comment len
            rec_bytes.extend_from_slice(&0u16.to_le_bytes()); // disk
            rec_bytes.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
            rec_bytes.extend_from_slice(&rec.external_attrs.to_le_bytes());
            rec_bytes.extend_from_slice(&rec.offset.to_le_bytes());
            rec_bytes.extend_from_slice(name_bytes);
            // UT extra, central directory only: 55 54 05 00 03 + mtime.
            rec_bytes.extend_from_slice(b"UT");
            rec_bytes.extend_from_slice(&5u16.to_le_bytes());
            rec_bytes.push(0x03); // mtime present
            rec_bytes.extend_from_slice(&rec.mtime.to_le_bytes());
            self.sink.write_all(&rec_bytes)?;
            cd_len += rec_bytes.len() as u32;
        }
        let mut eocd = Vec::with_capacity(22);
        eocd.extend_from_slice(&EOCD_SIG.to_le_bytes());
        eocd.extend_from_slice(&0u16.to_le_bytes()); // disk
        eocd.extend_from_slice(&0u16.to_le_bytes()); // cd disk
        eocd.extend_from_slice(&(self.records.len() as u16).to_le_bytes());
        eocd.extend_from_slice(&(self.records.len() as u16).to_le_bytes());
        eocd.extend_from_slice(&cd_len.to_le_bytes());
        eocd.extend_from_slice(&cd_offset.to_le_bytes());
        eocd.extend_from_slice(&0u16.to_le_bytes()); // comment len
        self.sink.write_all(&eocd)?;
        self.sink.flush()?;
        Ok(self.sink)
    }
}
