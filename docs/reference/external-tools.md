# External tools

Two toolchains are **not** bundled with the app: Python with **pikepdf**, and
**poppler**. Without them the app still starts and still downloads — it just
quietly stops doing half of what you expect, which is why a **Required Tools**
panel exists in Settings and why the app probes for them at startup. This page
covers what each tool does, how to install it, and what degrades when it is
missing. The probe itself is [`toolchain.ts`](../../src/main/services/toolchain.ts)
and its UI is [`ToolchainStatus.tsx`](../../src/renderer/src/components/settings/ToolchainStatus.tsx).

## Python 3 + pikepdf

**What it does:** writes all PDF metadata. The app shells out to pikepdf to
inject the XMP packet and the Info dictionary; nothing else can produce the
exact byte format Kavita and calibre expect (pdf-lib cannot write custom XMP
namespaces, and exiftool flattens nested structures). See
[`metadata-formats.md`](metadata-formats.md).

**Install:**

```bash
# Fedora
sudo dnf install python3-pikepdf

# Debian and Ubuntu
sudo apt install python3-pikepdf
```

Windows: `pip install pikepdf`.

## poppler tools

**What they do:**

| Tool | Used for |
| --- | --- |
| `pdfinfo` | Page counts used to verify a PDF → CBZ conversion |
| `pdfimages` | Lossless page extraction for PDF → CBZ conversion (`-all`, copies image streams byte-for-byte) |
| `pdftoppm` | PDF thumbnails in the library, and the lossy re-rasterisation fallback |

**Install:**

```bash
# Fedora
sudo dnf install poppler-utils

# Debian and Ubuntu
sudo apt install poppler-utils
```

Windows: install poppler for Windows and put its `bin\` folder on PATH.

If you install the **RPM** build, dnf pulls both tools in for you as declared
dependencies.

## Toolchain probe

The app checks for all four tools (pikepdf, pdfinfo, pdfimages, pdftoppm)
**at startup** and **on demand** via the **Re-check** button in Settings →
Advanced → Required Tools. The panel shows each tool with its detected version,
what stops working without it, and a copy-pasteable install command for your
platform. The probe is cached, so re-checking after an install re-runs it
without restarting the app.

## What degrades without them

| Missing | Effect |
| --- | --- |
| **pikepdf** | PDFs are written with **no metadata** — no title, artist or tags. Downloads still succeed; the file is just blank metadata-wise. |
| **poppler (pdfimages)** | **PDF → CBZ conversion is disabled** — there is no lossless extraction path. |
| **poppler (pdftoppm)** | **Library thumbnails for PDFs won't generate**, and the conversion fallback is gone. |
| **poppler (pdfinfo)** | Conversion verification (page counting) cannot run, so conversion is disabled. |

Because the app degrades silently, the Required Tools panel exists to surface
it: a fresh install that skipped the tools would otherwise appear to work while
quietly writing PDFs with empty metadata.

## CBZ is immune

CBZ generation and CBZ metadata writing need **no external tools at all** — the
archive and its `ComicInfo.xml` are built in-process. If you only ever use CBZ,
you can run without pikepdf and poppler (though PDFs you already own would
still lack thumbnails). This is one of the reasons [`../features/conversion.md`](../features/conversion.md)
is worth doing.

## See also

- [Installation](../getting-started/installation.md) — install commands up front
- [Metadata formats](metadata-formats.md) — what pikepdf writes into PDFs
- [Conversion](../features/conversion.md) — how poppler drives PDF → CBZ
