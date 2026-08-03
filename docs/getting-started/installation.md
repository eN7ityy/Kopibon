# Installation

Doujin Downloader is an Electron desktop app for Linux and Windows. It is not
distributed as a compiled download — you build it from source with `npm`, which
takes a couple of minutes and produces a native installer for your platform.
This page covers the requirements, how to install and run it, how to build the
packaged app, and what the internals look like.

## Requirements

Two external tools are **not** bundled with the app. They are only needed for
PDF features — see [External tools](../reference/external-tools.md) for the
full detail — so you can skip them, but it is worth installing both.

| Tool | Needed for |
| --- | --- |
| Python 3 with `pikepdf` | Writing metadata into PDF files |
| poppler (`pdfinfo`, `pdfimages`, `pdftoppm`) | PDF thumbnails, and PDF → CBZ conversion |

```bash
# Fedora
sudo dnf install poppler-utils python3-pikepdf

# Debian and Ubuntu
sudo apt install poppler-utils python3-pikepdf
```

On Windows, install pikepdf with `pip install pikepdf` and put poppler's `bin`
folder on your PATH.

## Install and run

```bash
npm install
npm run dev
```

`npm install` pulls the Electron runtime, React, and the native modules
(`better-sqlite3`, `sharp`). `npm run dev` starts the app with hot reload.

### First-run steps

Once the window opens:

1. **Set your library path.** Settings → Library. This is where downloads are
   written and where the scanner looks for files.
2. **Check the Required Tools panel.** Settings → Advanced → Required Tools.
   If anything is missing, install it and press **Re-check**.
3. **Add your nhentai API key (optional).** Settings → nhentai. Everything works
   without one, but see [`nhentai-api-key.md`](nhentai-api-key.md).
4. **Pick an output format.** Settings → Downloads. **CBZ** if you use Kavita,
   **PDF** otherwise.

## Building

```bash
npm run build:linux   # AppImage and RPM
npm run build:win     # NSIS installer
npm run build:unpack  # unpacked directory, useful for testing a packaged build
```

- The **AppImage** is the release channel that can update itself. It cannot
  express dependencies, so it relies on the in-app tool check instead.
- The **RPM** integrates with dnf and declares `poppler-utils` and
  `python3-pikepdf` as dependencies, so dnf installs them for you. It updates
  through dnf rather than in-app.
- There is **no macOS target**: a distributable mac build needs a paid Apple
  Developer account for signing and notarisation, and the in-app updater
  refuses unsigned updates. It is deliberately out of scope.

## Development setup

```bash
npm run typecheck   # both the node and web tsconfigs
npm test            # unit tests
npm run lint
npm run format
```

Use `npm run typecheck` rather than calling `tsc` directly. A bare
`npx tsc --noEmit` checks nothing in this repo, because the root tsconfig only
holds project references.

The repository layout:

```
src/main        Electron main process: IPC handlers, services, worker threads
src/preload     The typed bridge between main and renderer
src/renderer    React app: pages, components, zustand stores
```

## Native modules

`better-sqlite3` and `sharp` both ship platform-specific binaries, so build on
the platform you are targeting, or in CI. Building Windows artifacts from Linux
needs the Windows binaries installed first:

```bash
npm install --os=win32 --cpu=x64 sharp
```

## Architecture overview

Anything CPU-heavy runs in a **worker thread** rather than the main process, so
the window stays responsive. That covers PDF and CBZ generation, library
scanning, metadata writing, syncing and conversion. Workers open their own
SQLite connection and receive settings in their message payload rather than
reading the database for themselves.

Data lives in **SQLite** through Drizzle, in Electron's `userData` directory.
Scratch space for downloads and conversions goes there too rather than in
`/tmp`, because extracting a large PDF can run to hundreds of megabytes and
`/tmp` is often a RAM-backed filesystem.

## See also

- [External tools](../reference/external-tools.md) — the two non-bundled tools in detail
- [nhentai API key](nhentai-api-key.md) — your next step after installing
- [Downloading](../features/downloading.md) — how the app turns a gallery into a file
