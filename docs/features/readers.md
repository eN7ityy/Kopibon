# Readers

The app can read files without leaving the library. Galleries still on nhentai
open in the online **gallery viewer**. Files on disk open in the **PDF viewer**
or the **CBZ viewer** depending on their format. All three open from the
relevant detail panel and close with a click outside the panel or the **Escape**
key.

## Gallery viewer

The online viewer opens when you click a gallery's cover in Search or
Favorites. It has two modes:

- **Thumbnail grid**: all pages as a grid; click one to start reading.
- **Full-screen reading**: one page at a time. Navigate with the **left/right
  arrow keys** (or **A**/**D**), clicking the left/right zones of the screen,
  and **Home**/**End** to jump to the start/end. **Escape** returns to the grid.

The reader rotates through the live **CDN server list** when an image fails to
load (a "Try Next Server" fallback), and **preloads the adjacent pages** so
flipping feels instant.

## PDF viewer

The PDF viewer renders the file with **pdfjs-dist** into a vertically
scrollable strip of
full-width page canvases. It renders pages in batches (yielding to the event
loop so the UI stays responsive), tracks the visible page with an intersection
observer, and **releases memory on close**. The PDF document is destroyed and
every canvas pixel buffer is freed, so opening large files repeatedly does not
leak.

## CBZ viewer

The CBZ viewer reads individual page images from the archive over IPC (the
main process
streams single entries with `yauzl`, so it never inflates the whole file at
once). It uses **lazy rendering**: only the visible page plus a small window
around it is decoded, keeping memory use flat on long books. Keyboard
navigation scrolls by page; **PageDown**/**PageUp**, arrow keys or **J**/**K**.
with **Home**/**End** to jump.

## Common behaviour

- Both file viewers open from **Library detail** (or the library list).
- Both close with **click-outside** or **Escape**.
- The gallery viewer closes with Escape from the grid, and from reading mode
  with a second Escape to return to the grid first.

## See also

- [Library](library.md): where the file viewers are opened from
- [nhentai integration](nhentai-integration.md): how the gallery viewer is reached
- [Downloading](downloading.md): the formats these viewers read
