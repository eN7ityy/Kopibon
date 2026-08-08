# Installation

Kopibon is an Electron desktop app for Linux and Windows. This page covers the
requirements, how to install and run it, and how to build the packaged app from
source.

## Requirements

Two external tools are **not** bundled with the app. They are only needed for
PDF features. See [External tools](../reference/external-tools.md) for the
full detail. You can skip them, but it is worth installing both.

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

`npm install` pulls the Electron runtime, React, and the native modules.
`npm run dev` starts the app with hot reload.

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
npm run build:linux   # AppImage, RPM and deb
npm run build:win     # NSIS installer
npm run build:unpack  # unpacked directory, useful for testing a packaged build
```

### Linux

`npm run build:linux` produces three packages:

- The **AppImage** is the release channel that can update itself. It cannot
  express dependencies, so it relies on the in-app tool check instead.
- The **RPM** integrates with dnf and declares `poppler-utils` and
  `python3-pikepdf` as dependencies, so dnf installs them for you. It updates
  through dnf rather than in-app.
- The **deb** integrates with apt and declares the same dependencies.

### Windows

`npm run build:win` produces an NSIS installer. Windows users must install the
external tools themselves: `pip install pikepdf`, and poppler for Windows with
its `bin\` folder on PATH.

### macOS

There is **no macOS target**: a distributable mac build needs a paid Apple
Developer account for signing and notarisation, and the in-app updater refuses
unsigned updates. It is deliberately out of scope.

## See also

- [External tools](../reference/external-tools.md): the two non-bundled tools in detail
- [nhentai API key](nhentai-api-key.md): your next step after installing
- [Downloading](../features/downloading.md): how the app turns a gallery into a file
