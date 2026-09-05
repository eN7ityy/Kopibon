#!/usr/bin/env python3
"""CBZ validator — CRC check + structural field dump (WR-03; 08/01 §8).

Usage: python3 tests/zip/validate.py <archive.cbz>

Validates every entry's CRC via Python zipfile (the external validator of
08/01 §8 / WR-03) and prints one REC line per entry with the structural
fields of the S3 list, for the Rust tests to assert against.
"""
import sys
import zipfile


def main() -> int:
    path = sys.argv[1]
    with zipfile.ZipFile(path) as z:
        bad = z.testzip()
        if bad is not None:
            print(f"BAD_CRC: {bad}")
            return 1
        infos = z.infolist()
        print(f"ENTRIES {len(infos)}")
        for info in infos:
            # external attrs: high 16 bits = unix mode
            mode = info.external_attr >> 16
            print(
                f"REC {info.filename}|vmade={info.create_system}:{info.create_version}"
                f"|needed={info.extract_version}|method={info.compress_type}"
                f"|flag={info.flag_bits:#06x}|mode={mode:#o}"
                f"|extra={info.extra.hex()}|comment={bool(info.comment)}"
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
