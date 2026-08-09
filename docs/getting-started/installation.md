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

`npm run build:win` produces an NSIS installer (`kopibon-<version>-setup.exe`)
alongside `latest.yml`, the update feed the installed app reads.

**Build this on Windows.** It is not a preference — two dependencies resolve
their native binaries by platform at install time, and neither fails loudly if
the wrong one is packaged:

- **sharp** installs through CPU/OS-gated optional dependencies. On Linux,
  `npm ci` fetches only `@img/sharp-linux-*`; a Windows package built there
  would contain no usable sharp at all, and sharp failing means thumbnails
  silently never generate rather than raising an error.
- **better-sqlite3** needs `prebuilds/win32-x64.node`. Without it the app
  cannot open its database and will not start.

Running `npm ci` on Windows resolves both correctly with no extra steps. This
is why CI builds Windows on a `windows-latest` runner rather than
cross-compiling from the self-hosted Linux one — cross-compiling additionally
needs Wine, and produces a binary that cannot be smoke-tested on the machine
that built it.

#### Build requirements

| Requirement | Notes |
| --- | --- |
| Node.js 22 | Matches the version CI builds with |
| Visual Studio Build Tools (C++ workload) | Only if npm falls back to compiling a native module from source; the shipped prebuilds normally avoid this |
| Python 3 | Same fallback case — `node-gyp` needs it |

Neither poppler nor pikepdf is needed **to build** — they are runtime
dependencies of the finished app, not build-time ones.

#### Runtime tools on Windows

There is no package manager to declare dependencies to, as the RPM and deb do,
so Windows users install the external tools by hand:

```powershell
pip install pikepdf
```

Then download poppler for Windows and add its `bin\` folder to PATH. The app
checks for both at startup — **Settings → Advanced → Required Tools** reports
what is missing.

#### Code signing

The installer is unsigned. Windows SmartScreen will warn on first run, and the
user has to choose *More info → Run anyway*. Signing needs a paid code-signing
certificate and is deliberately out of scope, the same reasoning applied to the
macOS target below.

### macOS

There is **no macOS target**: a distributable mac build needs a paid Apple
Developer account for signing and notarisation, and the in-app updater refuses
unsigned updates. It is deliberately out of scope.

## See also

- [External tools](../reference/external-tools.md): the two non-bundled tools in detail
- [nhentai API key](nhentai-api-key.md): your next step after installing
- [Downloading](../features/downloading.md): how the app turns a gallery into a file
