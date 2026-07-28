# Phase 6 — Library QoL Enhancements: Handoff Brief

## Status: Ready for Implementation

---

## Current State Analysis

### Search (line 104-109 of `library.repo.ts`)
```sql
custom_title LIKE '%{q}%' OR primary_artist LIKE '%{q}%' OR series_name LIKE '%{q}%'
```
Missing: `custom_tags`, `publisher`, `language`, `description`. Also `COLLATE NOCASE` only on sort, not search.

### Filters (LibraryPage.tsx lines 593-653)
Checkbox lists capped at 50 items per category. No search within filters. With 1,800+ artists and 3,000+ series, scrolling to find one is impractical.

### Series Assignment (SeriesAssignment.tsx lines 40-48)
Volumes default to sequential (1, 2, 3...). No attempt to parse title for volume/chapter info.

### Selection Mode
Does not auto-exit when last item is deselected — user must manually toggle "Select" button off.

---

## Tasks

### Q1 — Extended Full-Text Search

**Files:** `src/main/db/repositories/library.repo.ts`

Extend the search WHERE clause (line 106-108) from 3 fields to 7:

```sql
(custom_title LIKE '%{q}%' OR primary_artist LIKE '%{q}%' OR series_name LIKE '%{q}%'
 OR custom_tags LIKE '%{q}%' OR publisher LIKE '%{q}%' OR language LIKE '%{q}%'
 OR description LIKE '%{q}%')
```

Also add `COLLATE NOCASE` to each LIKE for case-insensitive matching.

### Q2 — Searchable Filter Dropdowns

**Files:** `src/renderer/src/components/library/LibraryPage.tsx`

Replace the three checkbox-list filter sections (Artists, Series, Tags) with searchable dropdowns using the existing `AutocompleteInput` component:

| Old | New |
|-----|-----|
| Checkbox list (capped at 50) | `AutocompleteInput` dropdown filtering as user types |
| Click to filter | Select to add chip, click chip to remove |
| Artist/Series/Tag names | Same data, but with typeahead from existing list |

Each filter section becomes:
```
[h4] Artists ↕
[AutocompleteInput placeholder="Search artists..."]
[chip: artist1 ×] [chip: artist2 ×]
```

The filters still apply the same backend logic (artistFilters/seriesFilters/tagFilters arrays passed to libraryRepo.findPaginated).

### Q3 — Multiple View Modes

**Files:** `src/renderer/src/components/library/LibraryPage.tsx`, `src/renderer/src/components/library/LibraryCard.tsx`

Add a view toggle button in the toolbar with three modes:

| Mode | Icon | Card Layout | Thumbnail | Metadata |
|------|------|-------------|-----------|----------|
| Grid | ▦ | Responsive grid (current) | Large (3:4 aspect) | Title, artist, series |
| Compact | ⊞ | Smaller grid | Small (2:3 aspect) | Title, artist only |
| List | ☰ | Single-column rows | None | Full row: title, artist, series, volume, pages, language, tags, file size |

**List mode specifics:**
- Each row shows all metadata in a horizontal layout
- Selection checkbox still present
- Inline editing: clicking title/artist/series/volume text turns it into an `<input>` or `<textarea>`, pressing Enter saves via `library:updateMetadata`, pressing Escape cancels
- Right-click context menu still works
- Clicking the row opens LibraryDetail (same as grid mode)

**State:** Add `viewMode` state to LibraryPage (`'grid' | 'compact' | 'list'`), persist to settings or localStorage. Default: `'grid'`.

### Q4 — Inline Editing (List Mode Only)

**Files:** `src/renderer/src/components/library/LibraryPage.tsx`

In list mode, make title, artist, series, and volume cells click-to-edit:

1. Click on a cell → text replaced by `<input>` with current value
2. Press Enter → call `window.api.library.updateMetadata(id, { field: newValue })` → updates DB → refreshes item
3. Press Escape → revert to original text
4. Click outside → blur saves (same as Enter)

Editable fields: `customTitle`, `primaryArtist`, `seriesName`, `seriesIndex`.

### Q5 — UTF-8 Symbol Fix

**Files:** `src/main/db/connection.ts`

The database connection should explicitly set encoding. Add after opening the SQLite connection:

```typescript
db.pragma('encoding = "UTF-8"')
db.pragma('journal_mode = WAL')
```

Verify that `custom_tags`, `custom_title`, and other text columns store and retrieve UTF-8 characters correctly. If symbols are scrambled, the issue is likely in the filter checkboxes rendering (React key/display mismatch) rather than the database itself. Check that filter checkbox labels use the actual string value, not a hashed/index key.

### Q6 — Auto-Exit Selection Mode

**Files:** `src/renderer/src/components/library/LibraryPage.tsx`

In the `toggleSelect` function (around line 221-232), after removing an item from `selectedIds`, if the resulting set is empty AND `selectMode` is true, set `selectMode` to `false`.

```typescript
const toggleSelect = useCallback((id: number) => {
  setSelectedIds((prev) => {
    const next = new Set(prev)
    if (next.has(id)) {
      next.delete(id)
      if (next.size === 0) setSelectMode(false)
    } else {
      next.add(id)
    }
    return next
  })
  setSelectionTick((t) => t + 1)
}, [])
```

### Q7 — Volume Pre-Fill from Title Patterns

**Files:** `src/renderer/src/components/library/SeriesAssignment.tsx`

In the `useEffect` that pre-fills volumes (lines 40-48), add regex parsing for volume/chapter patterns. Priority: existing `seriesIndex` > parsed title > sequential fallback.

Regex patterns to detect (case-insensitive):
```typescript
const patterns = [
  /vol\.?\s*(\d+(?:\.\d+)?)/i,          // Vol. 3, vol 5, Vol.1.5
  /ch\.?\s*(\d+(?:\.\d+)?)/i,          // Ch. 2, Ch 7
  /chapter\s*(\d+(?:\.\d+)?)/i,        // Chapter 10
  /ep\.?\s*(\d+(?:\.\d+)?)/i,          // EP.8, Ep 4
  /episode\s*(\d+(?:\.\d+)?)/i,        // Episode 12
  /part\s*(\d+(?:\.\d+)?)/i,           // Part 3
  /#(\d+(?:\.\d+)?)/,                  // #5
]
```

Apply to `item.customTitle || ''`, take the first match. If no existing `seriesIndex` and no pattern match, fall back to sequential (index + 1).

### Q8 — Scrollable Series Dropdown

**Files:** `src/renderer/src/components/library/SeriesAssignment.tsx`

The series name `AutocompleteInput` should show the full series name. Currently AutocompleteInput limits to a fixed width. Ensure the dropdown list:
- Has `max-h-60 overflow-y-auto` for scrolling
- Shows full series names (no truncation within the dropdown)
- The input field itself can truncate (current behavior is fine)

---

## Files Affected

| File | Changes |
|------|---------|
| `src/main/db/repositories/library.repo.ts` | Q1: extend search to 7 fields + COLLATE NOCASE |
| `src/renderer/src/components/library/LibraryPage.tsx` | Q2: searchable filter dropdowns, Q3: view mode toggle, Q4: inline editing inputs, Q6: auto-exit selection |
| `src/renderer/src/components/library/LibraryCard.tsx` | Q3: compact mode rendering |
| `src/renderer/src/components/library/SeriesAssignment.tsx` | Q7: volume regex parsing, Q8: scrollable dropdown |
| `src/renderer/src/components/shared/AutocompleteInput.tsx` | Q2: verify it supports the filter use case (chips display) |
| `src/main/db/connection.ts` | Q5: UTF-8 pragma |

## Implementation Order

Q1 (search) → Q2 (filters) → Q5 (UTF-8) → Q6 (auto-exit) → Q3 (view modes) → Q4 (inline edit) → Q7 (volume parse) → Q8 (scrollable dropdown)

## Verification

- `npm run build` passes with zero type errors
- Search "english" matches items with language "english" (wasn't previously)
- Filter dropdowns let you type to find an artist/series/tag instead of scrolling
- View mode toggle cycles: Grid → Compact → List → Grid
- In list mode, clicking title changes to input, Enter saves, Escape cancels
- UTF-8 symbols (é, 猫, ☆) display correctly in filter dropdowns and inline edits
- Deselecting last item in select mode auto-exits select mode
- Title "My Series Vol. 3" pre-fills volume "3" in series assignment
- Series dropdown shows full series names with scroll
