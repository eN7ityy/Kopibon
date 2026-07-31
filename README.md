# Doujin Downloader

A desktop app for downloading galleries from nhentai and keeping them organised
as a local library. It writes proper metadata into every file, so the result
works as a real collection in Kavita rather than a folder of loose files.

Built with Electron, React and TypeScript. Linux and Windows.

## What it does

**Browse and search.** Search by text or by artist, group, parody and character.
Sort by recent, popular today or all time. Your nhentai favourites show up as
their own tab once you add an API key.

**Download as PDF or CBZ.** Pick a default in Settings and override it per
gallery. CBZ is the better choice if you use Kavita, because it carries a real
`ComicInfo.xml` and Kavita reads genres and tags as separate fields from it. With
a PDF, everything lands in genres.

**Metadata that actually shows up.** Title, artist, group, series and volume,
language, tags, release date and age rating all get written into the file. The
PDF path writes XMP in the format calibre and Kavita expect, the CBZ path writes
ComicInfo v2.1.

**Scan an existing library.** Point it at a folder of PDFs or CBZs and it reads
the metadata back out, builds thumbnails, and matches items to galleries. It is
built to be careful with large libraries: it refuses to mass-delete rows when a
network mount disappears mid-scan, and it retries files that failed.

**Convert PDF to CBZ.** One file or a whole selection. Pages are copied out of
the PDF without re-compressing, so the conversion is lossless and the result is
usually smaller than the original. Every archive is verified by opening it before
the source PDF is touched, and you choose per run whether to keep the originals
in an `_originals/` folder or delete them.

**Read in the app.** There is a viewer for both formats, so you can check a file
without leaving the library.

**Edit metadata.** Change titles, tags, series and volume on anything in the
library, or re-sync an item from nhentai to pull fresh data.

## Requirements

Two external tools are not bundled with the app. Without them it still runs and
still downloads, it just stops writing PDF metadata and cannot convert anything,
so it is worth installing both. Settings has a Required Tools panel that checks
for them and shows the exact install command for your system.

| Tool | Needed for |
| --- | --- |
| Python 3 with `pikepdf` | Writing metadata into PDF files |
| poppler (`pdfinfo`, `pdfimages`, `pdftoppm`) | PDF thumbnails, and PDF to CBZ conversion |

Fedora:

```bash
sudo dnf install poppler-utils python3-pikepdf
```

Debian and Ubuntu:

```bash
sudo apt install poppler-utils python3-pikepdf
```

If you install the RPM build, dnf pulls both in for you.

On Windows, install pikepdf with `pip install pikepdf` and put poppler's `bin`
folder on your PATH.

## Getting started

Install dependencies and start it in development mode:

```bash
npm install
npm run dev
```

Then, in the app:

1. Open Settings and set your library path. This is where downloads go and where
   the scanner looks.
2. Check the Required Tools panel. If anything is missing, install it and press
   Re-check.
3. Add your nhentai API key if you want your favourites. Everything else works
   without one, though the rate limits are more generous when signed in.
4. Pick an output format. CBZ if you use Kavita, PDF otherwise.

## Building

```bash
npm run build:linux   # AppImage and RPM
npm run build:win     # NSIS installer
npm run build:unpack  # unpacked directory, useful for testing a packaged build
```

The AppImage is the release channel that can update itself. The RPM integrates
with dnf and declares the two external tools as dependencies, but it updates
through dnf rather than in-app.

There is no macOS target. Shipping a mac build that Gatekeeper will open needs a
paid Apple Developer account for signing and notarisation, and the in-app updater
refuses unsigned updates, so it is deliberately out of scope.

Native modules matter here. `better-sqlite3` and `sharp` both ship platform
specific binaries, so build on the platform you are targeting, or in CI. Building
Windows artifacts from Linux needs the Windows binaries installed first:

```bash
npm install --os=win32 --cpu=x64 sharp
```

## Development

```bash
npm run typecheck   # both the node and web tsconfigs
npm test            # unit tests
npm run lint
npm run format
```

Use `npm run typecheck` rather than calling tsc directly. A bare
`npx tsc --noEmit` checks nothing in this repo, because the root tsconfig only
holds project references.

The layout:

```
src/main        Electron main process: IPC handlers, services, worker threads
src/preload     The typed bridge between main and renderer
src/renderer    React app: pages, components, zustand stores
```

Anything CPU heavy runs in a worker thread rather than the main process, so the
window stays responsive. That covers PDF and CBZ generation, library scanning,
metadata writing, syncing and conversion. Workers open their own SQLite
connection and receive settings in their message payload rather than reading the
database for themselves.

Data lives in SQLite through Drizzle, in Electron's `userData` directory. Scratch
space for downloads and conversions goes there too rather than in `/tmp`, because
extracting a large PDF can run to hundreds of megabytes and `/tmp` is often a
RAM-backed filesystem.

## How it treats the API

Requests are rate limited per endpoint using the documented limits, with a token
bucket and a FIFO queue so a burst of work does not turn into a burst of
requests. Signing in with an API key raises those limits. Gallery detail
responses are cached, with a bound on the cache size.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

This covers the source in this repository. It says nothing about the content the
app downloads, and it is not a statement about nhentai's terms of service.
