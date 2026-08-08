# Kopibon

A desktop app for downloading galleries from nhentai and organising them as a
local library. It writes metadata into every file, so Kavita can treat the
result as a collection instead of a folder of loose files. The app uses Electron,
React and TypeScript and runs on Linux and Windows.

## What it does

- Browse and search nhentai, with favourites, gallery details and related work.
- Download as **PDF or CBZ**, with compression controls and a concurrency slider.
- Embedded metadata: XMP for PDF, ComicInfo for CBZ.
- Scan, organise and read a local library, including series grouping, editing, PDF → CBZ
  conversion, and built-in viewers.

## Requirements

Python + pikepdf and poppler are needed for PDF features. See
[External tools](docs/reference/external-tools.md).

## Quickstart

```bash
npm install
npm run dev
```

Set your library path in Settings, check the Required Tools panel, add your
nhentai API key if you want favourites, and pick an output format. See
[Installation](docs/getting-started/installation.md).

## Documentation

**Getting started:** [Installation](docs/getting-started/installation.md) ·
[nhentai API key](docs/getting-started/nhentai-api-key.md)

**Features:** [Downloading](docs/features/downloading.md) ·
[nhentai integration](docs/features/nhentai-integration.md) ·
[Library](docs/features/library.md) ·
[Metadata pipeline](docs/features/metadata-pipeline.md) ·
[Kavita integration](docs/features/kavita-integration.md) ·
[Conversion](docs/features/conversion.md) ·
[Search settings](docs/features/search-settings.md) ·
[Readers](docs/features/readers.md) · [Sync](docs/features/sync.md)

**Reference:** [Library layout](docs/reference/library-layout.md) ·
[Metadata formats](docs/reference/metadata-formats.md) ·
[External tools](docs/reference/external-tools.md)

## Building

```bash
npm run build:linux   # AppImage and RPM
npm run build:win     # NSIS installer
npm run build:unpack  # unpacked directory
```

See [Installation → Building](docs/getting-started/installation.md#building).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

This covers the source in this repository. It says nothing about the content
the app downloads, and it is not a statement about nhentai's terms of service.
