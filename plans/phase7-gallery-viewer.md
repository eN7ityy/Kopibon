# Phase 7 — Built-in Gallery Reader: Component Spec

## Status: Ready for Implementation

---

## Answer to Question

Yes — `GET /api/v2/galleries/{id}` returns a `pages` array with CDN-relative paths (`path`, `thumbnail`, `width`, `height`) for every page. We already fetch this in GalleryDetail and cache it in-memory. The CDN servers are available from `GET /api/v2/cdn`. Full-page URL construction: `https://{image_server}/{page_path}`. Thumbnail URL: `https://{thumb_server}/{page.thumbnail}`.

---

## Architecture

```
GalleryDetail (existing slide-over)
  └── "Read" button
       └── Opens GalleryViewer (left panel)
            ├── Thumbnail Grid mode
            │    ├── Scrollable vertical grid of page thumbnails
            │    └── Click page → Reading Mode at that index
            └── Reading Mode (overlay)
                 ├── Single page full-screen display
                 ├── Keyboard navigation (← →, A/D, Esc)
                 ├── Bottom bar: page count + exit button
                 └── Black side bars
```

---

## Component: `GalleryViewer.tsx`

### Location
`src/renderer/src/components/gallery/GalleryViewer.tsx` (NEW)

### Props

```typescript
interface GalleryViewerProps {
  galleryId: number
  pages: PageInfo[]        // from GalleryDetail API response
  cdnServers: string[]     // from getCdnConfig().image_servers
  thumbServers: string[]   // from getCdnConfig().thumb_servers
  title: string            // gallery title for header
  onClose: () => void      // close viewer, return to GalleryDetail
}
```

### State

```typescript
const [mode, setMode] = useState<'grid' | 'reading'>('grid')
const [currentPage, setCurrentPage] = useState(0) // 0-indexed
```

### Sub-component: Thumbnail Grid Mode

**Layout:**
- Full left panel (same width as GalleryDetail's slide-over: `max-w-lg`, `w-full`)
- Dark background (`bg-gray-950`)
- Header: title + X close button + "Exit" text link
- Grid: responsive thumbnails in a scrollable div (`overflow-y-auto`)

**Each thumbnail:**
- Size: `w-full` with fixed 3:4 aspect container
- Source: `https://{thumbServer}/{page.thumbnail}`
- Overlay: page number badge (bottom-right, semi-transparent black)
- Hover: subtle scale + border highlight
- Click: `setMode('reading')` + `setCurrentPage(index)`
- Lazy loading: `loading="lazy"` on `<img>`
- Error fallback: 📖 icon placeholder

**Grid layout:**
```
grid grid-cols-3 gap-2 p-4
```

**States:**
- Loading: skeleton grid of thumbnail placeholders (12 shimmer rectangles)
- Empty: "No pages available" + close button
- Error (CDN failure per image): individual fallback icon

### Sub-component: Reading Mode

**Layout:**
- Full screen overlay (`fixed inset-0 z-50 bg-black`)
- Main content area: flex column, centered vertically
- Image: max-width: 80vw, max-height: calc(100vh - 80px) (leaving room for bottom bar), object-contain
- Side bars: fill remaining horizontal space with black
- Bottom bar: fixed `bottom-0 left-0 right-0 h-16 bg-black/80 backdrop-blur`

**Bottom bar content:**
- Left: gallery title (truncated)
- Center: page counter "3 / 17"
- Right: ✕ Exit button (white text on transparent bg, hover: red)

**Navigation:**
- Click left side of image → previous page
- Click right side of image → next page
- Keyboard:
  - `ArrowLeft` / `a` / `A` → previous page
  - `ArrowRight` / `d` / `D` → next page
  - `Escape` → exit reading mode (back to grid, not close viewer)
  - `Home` → first page
  - `End` → last page
- Wrap at boundaries: don't wrap (stop at 0 and last)
- Show brief flash/indicator when at boundary

**Image source:**
- `https://{imageServer}/{pages[currentPage].path}`
- Use the first CDN `image_server` from the config
- Fallback: try next server if image fails (CDN rotation — same pattern as download-manager)

**States:**
- Loading: centered spinner while image loads
- Error: "Failed to load page" + "Try Next Server" button
- Between pages: brief fade transition (200ms opacity)

### Sub-component: Navigation Overlays (Reading Mode)

**Previous page zone:**
- Left 30% of screen, full height, transparent
- Hover: subtle left arrow indicator
- Click: previous page

**Next page zone:**
- Right 30% of screen, full height, transparent
- Hover: subtle right arrow indicator
- Click: next page

**Center zone:**
- Middle 40% — click toggles bottom bar visibility

### Events & Accessibility

- `useEffect` for keyboard listeners, cleaned up on unmount
- `prefers-reduced-motion`: skip fade transitions
- Focus trap: focus stays within reader panel
- ARIA: `role="dialog"`, `aria-label="Gallery viewer"`

---

## Integration Points

### GalleryDetail.tsx (MODIFY)

Add to action buttons section (between Download button and Open in Browser):

```tsx
<button
  onClick={() => setShowViewer(true)}
  className="w-full px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
>
  📖 Read
</button>
```

State additions:
- `const [showViewer, setShowViewer] = useState(false)`
- `const [cdnServers, setCdnServers] = useState<string[]>([])`
- On mount, fetch CDN config: `window.api.getCdnConfig()` → store servers

When `showViewer && detail`:
```tsx
<GalleryViewer
  galleryId={detail.id}
  pages={detail.pages}
  cdnServers={cdnServers}
  thumbServers={cdnServers} // or thumb_servers from CDN config
  title={detail.title.pretty}
  onClose={() => setShowViewer(false)}
/>
```

### SearchPage.tsx + FavoritesPage.tsx (NO CHANGES)

GalleryDetail is already rendered in both pages. The "Read" button and viewer state are internal to GalleryDetail — no changes needed in parent components.

### CDN Server Fetching

GalleryDetail currently doesn't fetch CDN config. Add a `useEffect`:
```typescript
useEffect(() => {
  window.api.getCdnConfig().then(result => {
    if (result.success && result.data) {
      setCdnServers(result.data.image_servers)
    }
  })
}, [])
```

Alternatively, reuse the CDN config that was already fetched for image downloads — it's cached for 1 hour in the API client.

---

## Performance Considerations

- **Thumbnail grid**: Uses CDN thumbnails (~300px) which are small files. 30 pages = ~3MB total.
- **Reading mode**: Uses full-resolution images from CDN. Lazy-load only the current + 1 adjacent page. Preload next page while viewing current.
- **CDN caching**: Browser cache handles repeat visits to same pages.
- **Scroll position**: Preserve grid scroll position when returning from reading mode.

---

## Files Summary

| File | Type | Purpose |
|------|------|---------|
| `src/renderer/src/components/gallery/GalleryViewer.tsx` | NEW | Thumbnail grid + reading mode viewer |
| `src/renderer/src/components/gallery/GalleryDetail.tsx` | MODIFY | Add "Read" button, CDN config fetch, viewer state |

## Order of Implementation

1. Create `GalleryViewer.tsx` with grid mode + reading mode
2. Add CDN config fetch to GalleryDetail
3. Add "Read" button to GalleryDetail action buttons
4. Wire viewer open/close state

## Verification

- `npm run build` passes with zero type errors
- Clicking "Read" opens thumbnail grid with all pages
- Scrolling through pages works
- Clicking a thumbnail opens reading mode at that page
- Arrow keys, A/D, Home, End navigate pages
- Esc returns to grid, second Esc/clicking X closes viewer entirely
- Error state works when CDN image fails
