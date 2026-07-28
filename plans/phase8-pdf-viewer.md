# Phase 8 — Library PDF Viewer: Component Spec

## Status: Ready for Implementation

---

## Approach

A scrollable PDF viewer using Mozilla's `pdfjs-dist`. All pages are rendered to canvas and stacked vertically — the user scrolls through them. This is simpler than the gallery's grid+reading dual mode and matches how most web PDF viewers work.

The viewer opens in the same left-panel position as the GalleryViewer (adjacent to LibraryDetail).

---

## Dependency

`pdfjs-dist` — Mozilla's PDF rendering library. Install via npm:

```bash
npm install pdfjs-dist
```

Bundle size: ~500KB. Already used by countless Electron apps (VS Code, Slack, etc.).

---

## Architecture

```
LibraryDetail (existing slide-over)
  └── Cover image (clickable)
       └── Opens PdfViewer (left panel, same dimensions as GalleryViewer)
            ├── Scrollable vertical stack of page canvases
            ├── Floating bottom bar: page counter + exit button
            ├── Keyboard: PgUp/PgDn, Home/End, +/- zoom
            └── Each page: rendered from PDF file via pdfjs-dist
```

---

## Component: `PdfViewer.tsx`

### Location
`src/renderer/src/components/library/PdfViewer.tsx` (NEW)

### Props

```typescript
interface PdfViewerProps {
  filePath: string          // full filesystem path to the PDF
  title: string             // display title (from library item)
  onClose: () => void       // close viewer, return to LibraryDetail
}
```

### Internal State

```typescript
const [loading, setLoading] = useState(true)
const [totalPages, setTotalPages] = useState(0)
const [error, setError] = useState<string | null>(null)
const [scale, setScale] = useState(1.5)  // render scale (affects quality + memory)
const [pageCanvases, setPageCanvases] = useState<HTMLCanvasElement[]>([])
const [visiblePage, setVisiblePage] = useState(1)
const containerRef = useRef<HTMLDivElement>(null)
const bottomBarRef = useRef<HTMLDivElement>(null)
```

### PDF Loading (useEffect on mount)

```typescript
useEffect(() => {
  const loadPdf = async () => {
    setLoading(true)
    try {
      // Read the file as ArrayBuffer (from local filesystem)
      const arrayBuffer = await window.api.readFile(filePath)
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
      setTotalPages(pdf.numPages)

      // Render all pages to canvases
      const canvases: HTMLCanvasElement[] = []
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i)
        const viewport = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = viewport.width
        canvas.height = viewport.height
        const ctx = canvas.getContext('2d')!
        await page.render({ canvasContext: ctx, viewport }).promise
        canvases.push(canvas)
        // Yield to event loop every 5 pages to prevent UI freeze
        if (i % 5 === 0) await new Promise(r => setTimeout(r, 0))
      }
      setPageCanvases(canvases)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load PDF')
    } finally {
      setLoading(false)
    }
  }
  loadPdf()
}, [filePath, scale])
```

**Note on `readFile`:** Need a new IPC handler to read a file from the filesystem and return it as an ArrayBuffer/Base64 to the renderer. `pdfjs-dist` needs the raw bytes. Add:

```typescript
// In some IPC file (e.g., library.ipc.ts or new file.ipc.ts)
ipcMain.handle('file:read', async (_event, filePath: string) => {
  try {
    const buffer = readFileSync(filePath)
    return { success: true, data: buffer.toString('base64') }
  } catch (error) {
    return { success: false, error: String(error) }
  }
})
```

And in preload:
```typescript
readFile: (filePath: string) => ipcRenderer.invoke('file:read', filePath)
```

### Scroll Detection (Intersection Observer)

Track which page is currently visible at the top of the viewport:

```typescript
useEffect(() => {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const pageNum = Number(entry.target.getAttribute('data-page'))
          if (!isNaN(pageNum)) setVisiblePage(pageNum)
        }
      }
    },
    { threshold: 0.5, root: containerRef.current }
  )
  // Observe all page containers
  const elements = containerRef.current?.querySelectorAll('[data-page]')
  elements?.forEach(el => observer.observe(el))
  return () => observer.disconnect()
}, [pageCanvases])
```

### Layout (return JSX)

```tsx
<div className="fixed right-0 top-0 h-full w-full max-w-lg bg-gray-100 dark:bg-gray-950 shadow-2xl z-50 flex flex-col">
  {/* Header */}
  <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
    <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate flex-1 mr-2">
      {title}
    </h3>
    <button onClick={onClose} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-500">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-5 h-5">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  </div>

  {/* Page canvases (scrollable) */}
  <div ref={containerRef} className="flex-1 overflow-y-auto px-2 py-4 flex flex-col items-center gap-2">
    {loading && <LoadingSpinner />}
    {error && <ErrorState message={error} />}
    {pageCanvases.map((canvas, i) => (
      <div
        key={i}
        data-page={i + 1}
        className="shadow-lg bg-white rounded overflow-hidden"
        ref={el => { if (el && canvas.parentElement !== el) el.appendChild(canvas) }}
      />
    ))}
  </div>

  {/* Bottom bar */}
  <div ref={bottomBarRef} className="flex items-center justify-between px-4 py-2 border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
    <div className="flex items-center gap-3">
      <button onClick={zoomOut} className="text-gray-500 hover:text-gray-700" title="Zoom out">−</button>
      <span className="text-xs text-gray-400">{Math.round(scale * 100)}%</span>
      <button onClick={zoomIn} className="text-gray-500 hover:text-gray-700" title="Zoom in">+</button>
    </div>
    <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
      {visiblePage} / {totalPages}
    </span>
    <span className="text-xs text-gray-400">PDF</span>
  </div>
</div>
```

### Zoom

```typescript
const zoomIn = () => setScale(s => Math.min(s + 0.25, 4))
const zoomOut = () => setScale(s => Math.max(s - 0.25, 0.5))
```

Zoom triggers a full re-render of all pages.

### Keyboard Navigation

```typescript
useEffect(() => {
  const handleKey = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'Escape': onClose(); break
      case 'PageDown':
      case 'ArrowDown':
      case 'j':
        containerRef.current?.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' }); break
      case 'PageUp':
      case 'ArrowUp':
      case 'k':
        containerRef.current?.scrollBy({ top: -window.innerHeight * 0.8, behavior: 'smooth' }); break
      case 'Home':
        containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); break
      case 'End':
        containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: 'smooth' }); break
      case '+': case '=': zoomIn(); break
      case '-': zoomOut(); break
    }
  }
  document.addEventListener('keydown', handleKey)
  return () => document.removeEventListener('keydown', handleKey)
}, [onClose])
```

---

## Files Summary

| File | Type | Purpose |
|------|------|---------|
| `package.json` | MODIFY | Add `pdfjs-dist` dependency |
| `src/renderer/src/components/library/PdfViewer.tsx` | NEW | Scrollable PDF viewer with canvas rendering |
| `src/renderer/src/components/library/LibraryDetail.tsx` | MODIFY | Make cover clickable → open PdfViewer |
| `src/main/ipc/library.ipc.ts` (or new `file.ipc.ts`) | MODIFY | Add `file:read` IPC handler |
| `src/preload/index.ts` | MODIFY | Expose `readFile` to renderer |

---

## States

| State | Display |
|-------|---------|
| Loading | Centered spinner with "Opening PDF..." text |
| Error | "Failed to load PDF" + error message + Retry button |
| Empty PDF | "This PDF has no pages" + close button |
| Large PDF (100+ pages) | Progress indicator during render: "Rendering page 47/150..." |
| Zoomed in | Horizontal scrollbar appears on container |

---

## Memory Considerations

- **100-page PDF at scale 1.5**: Each page ~2-4MB canvas memory = ~200-400MB total. This is a lot for a single panel.
- **Mitigation**: Render only visible + 2 adjacent pages. On scroll, render new pages and discard distant ones (virtualized rendering).
- **Simpler approach for MVP**: Render all at once at default scale 1.0 (~100MB for 100 pages). Add virtualization if needed later.

---

## Integration with LibraryDetail.tsx

Make the cover image clickable (same pattern as GalleryDetail):

```tsx
// In LibraryDetail, around the cover image section:
<button
  onClick={() => setShowPdfViewer(true)}
  className="aspect-[3/4] max-w-[200px] mx-auto rounded-lg overflow-hidden bg-gray-200 dark:bg-gray-700 group relative"
>
  {thumbDataUrl ? (
    <img src={thumbDataUrl} alt={...} draggable={false} className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
  ) : (
    <div className="w-full h-full flex items-center justify-center text-gray-400"><span>📖</span></div>
  )}
  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
    <span className="text-white font-medium opacity-0 group-hover:opacity-100 transition-opacity">📖 Read</span>
  </div>
</button>
```

When `showPdfViewer` is true, render:
```tsx
<PdfViewer filePath={detail.filePath} title={detail.customTitle || 'Untitled'} onClose={() => setShowPdfViewer(false)} />
```

---

## Implementation Order

1. Install `pdfjs-dist`: `npm install pdfjs-dist`
2. Add `file:read` IPC handler + preload bridge
3. Create `PdfViewer.tsx` with canvas rendering + scroll + keyboard nav + zoom
4. Modify `LibraryDetail.tsx` — make cover clickable, add viewer state
5. Build, test, commit
