import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSearchStore } from '../../stores/search.store'
import { VirtuosoGrid, Virtuoso } from 'react-virtuoso'
import type { LibraryItemData } from './LibraryCard'
import LibraryCard from './LibraryCard'
import AutocompleteInput from '../shared/AutocompleteInput'
import SeriesAssignment from './SeriesAssignment'
import CustomEntryForm from './CustomEntryForm'
import LibraryDetail from './LibraryDetail'
import EmptyState from '../shared/EmptyState'
import ErrorState from '../shared/ErrorState'
import LoadingSkeleton from '../shared/LoadingSkeleton'
import { useConversionStore } from '../../stores/conversion.store'
import { useSettingsStore } from '../../stores/settings.store'
import ConvertToCbzDialog from './ConvertToCbzDialog'
import ResumeConversionBanner from './ResumeConversionBanner'
import { useCbzConversionStore } from '../../stores/cbz-conversion.store'
import { useGlobalJobs, type ProgressJob } from '../../stores/job-progress'
import { ProgressStack } from '../shared/ProgressBar'
import Button from '../shared/Button'
import Notice, { NoticeRegion } from '../shared/Notice'
import { Check, FileArchive, Grid3x3, Layers, LayoutGrid, Library, List, Pause, Play, Plus, RefreshCw, SlidersHorizontal, Trash2, X } from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────────────────

type SortField = 'added' | 'title' | 'artist'
type ViewMode = 'grid' | 'compact' | 'list'

const VIEW_MODE_KEY = 'library.viewMode'

interface ScanProgress {
  current: number
  total: number
  status: string
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PAGE_SIZE = 100

// ─── Searchable Filter Dropdown ──────────────────────────────────────────────

function SearchableFilterDropdown({
  label,
  allItems,
  selected,
  onToggle,
  placeholder
}: {
  label: string
  allItems: string[]
  selected: Set<string>
  onToggle: (item: string) => void
  placeholder: string
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    if (!query.trim()) return allItems.slice(0, 50)
    const lower = query.toLowerCase()
    return allItems.filter((i) => i.toLowerCase().includes(lower)).slice(0, 50)
  }, [allItems, query])

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={containerRef} className="min-w-[180px] max-w-[240px]">
      <h4 className="text-sm font-medium text-fg mb-2">{label}</h4>

      {/* Search input */}
      <div className="relative mb-2">
        <input
          type="text"
          placeholder={placeholder}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setShowDropdown(true) }}
          onFocus={() => setShowDropdown(true)}
          className="w-full pl-7 pr-2 py-1.5 text-xs rounded-lg border border-line bg-surface text-fg focus:ring-2 focus:ring-accent focus:border-transparent"
        />
        <svg className="absolute left-2 top-2 h-3 w-3 text-fg-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </div>

      {/* Dropdown */}
      {showDropdown && filtered.length > 0 && (
        <div className="max-h-40 overflow-y-auto rounded-lg border border-line bg-surface shadow-lg mb-2">
          {filtered.map((item) => (
            <label
              key={item}
              className="flex items-center gap-2 px-2 py-1.5 text-xs text-fg-muted cursor-pointer hover:bg-raised"
            >
              <input
                type="checkbox"
                checked={selected.has(item)}
                onChange={() => onToggle(item)}
                className="w-3 h-3 rounded border-line text-accent focus:ring-accent"
              />
              <span className="truncate">{item}</span>
            </label>
          ))}
        </div>
      )}

      {/* Selected chips */}
      {selected.size > 0 && (
        <div className="flex flex-wrap gap-1">
          {[...selected].slice(0, 15).map((item) => (
            <span
              key={item}
              onClick={() => onToggle(item)}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs bg-accent-wash text-accent cursor-pointer hover:bg-accent-wash transition-colors"
            >
              {item.length > 20 ? item.slice(0, 20) + '…' : item}
              <span className="ml-0.5 text-accent">×</span>
            </span>
          ))}
          {selected.size > 15 && (
            <span className="text-xs text-fg-faint self-center">+{selected.size - 15} more</span>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Inline Edit Cell (list mode) ────────────────────────────────────────────

function InlineEditCell({
  value,
  displayValue,
  itemId,
  field,
  className = '',
  autocompleteKind
}: {
  value: string
  displayValue: string
  itemId: number
  field: string
  className?: string
  autocompleteKind?: 'artist' | 'series'
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && !autocompleteKind) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing, autocompleteKind])

  const persist = useCallback(async (newValue: string) => {
    const trimmed = newValue.trim()
    if (trimmed !== value) {
      try {
        const updateData: Record<string, string | number | null> = {}
        if (field === 'seriesIndex') {
          const num = parseFloat(trimmed)
          updateData[field] = isNaN(num) ? null : num
        } else {
          updateData[field] = trimmed || null
        }
        await window.api.library.updateMetadata(itemId, updateData)
      } catch { /* ignore */ }
    }
    setEditing(false)
  }, [value, field, itemId])

  const cancel = useCallback(() => {
    setDraft(value)
    setEditing(false)
  }, [value])

  const handleAutocompleteChange = useCallback((newVal: string) => {
    setDraft(newVal)
  }, [])

  const handleAutocompleteSubmit = useCallback(() => {
    persist(draft)
  }, [draft, persist])

  if (editing) {
    if (autocompleteKind) {
      return (
        <div onClick={(e) => e.stopPropagation()} className="min-w-[120px]">
          <AutocompleteInput
            kind={autocompleteKind}
            value={draft}
            onChange={handleAutocompleteChange}
            placeholder={autocompleteKind === 'artist' ? 'Artist...' : 'Series...'}
            className="text-xs"
          />
          <div className="flex gap-1 mt-1">
            <button
              onClick={handleAutocompleteSubmit}
              className="text-xs px-2 py-0.5 rounded bg-accent-fill text-white hover:bg-accent-hover"
            >
              <Check size={14} aria-hidden="true" />
            </button>
            <button
              onClick={cancel}
              className="text-xs px-2 py-0.5 rounded bg-raised text-fg hover:bg-raised"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      )
    }

    return (
      <input
        ref={inputRef}
        type={field === 'seriesIndex' ? 'number' : 'text'}
        step={field === 'seriesIndex' ? 'any' : undefined}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); persist(draft) }
          if (e.key === 'Escape') { e.preventDefault(); cancel() }
        }}
        onBlur={() => persist(draft)}
        onClick={(e) => e.stopPropagation()}
        className={`w-full px-1 py-0.5 text-xs rounded border border-accent bg-surface text-fg focus:ring-2 focus:ring-accent focus:outline-none ${className}`}
      />
    )
  }

  return (
    <p
      className={`text-xs cursor-pointer hover:text-accent transition-colors ${className}`}
      onClick={(e) => { e.stopPropagation(); setEditing(true) }}
      title="Click to edit"
    >
      {displayValue}
    </p>
  )
}

// ─── Library Page ────────────────────────────────────────────────────────────

export default function LibraryPage(): React.JSX.Element {
  const navigate = useNavigate()
  const conversionStore = useConversionStore()
  const cbzRunning = useCbzConversionStore((s) => s.running)
  // Single source of truth for where the library lives — this page used to
  // hardcode a path, so changing the setting had no effect on scanning.
  const libraryRoot = useSettingsStore((s) => s.libraryPath)

  // Paginated data
  const [items, setItems] = useState<LibraryItemData[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const currentOffset = useRef(0)

  // Artist/series/tag lists for filters (still load all names for filter UI)
  const [artistNames, setArtistNames] = useState<string[]>([])
  const [seriesNames, setSeriesNames] = useState<string[]>([])
  const [tagNames, setTagNames] = useState<string[]>([])

  // UI state
  const [searchQuery, setSearchQuery] = useState('')
  const debouncedSearch = useDebounce(searchQuery, 150)
  const [sortField, setSortField] = useState<SortField>('added')
  const [selectedArtistFilters, setSelectedArtistFilters] = useState<Set<string>>(new Set())
  const [selectedSeriesFilters, setSelectedSeriesFilters] = useState<Set<string>>(new Set())
  const [selectedTagFilters, setSelectedTagFilters] = useState<Set<string>>(new Set())
  const [showUnmatchedOnly, setShowUnmatchedOnly] = useState(false)
  const [showFilters, setShowFilters] = useState(false)

  // Selection state (for batch operations)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [, setSelectionTick] = useState(0)
  const [batchSyncing, setBatchSyncing] = useState(false)
  const [showConvertDialog, setShowConvertDialog] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [showSeriesModal, setShowSeriesModal] = useState(false)
  const [showCustomForm, setShowCustomForm] = useState(false)
  const [detailItem, setDetailItem] = useState<LibraryItemData | null>(null)

  // Scan state
  const [scanning, setScanning] = useState(false)
  const [scanPaused, setScanPaused] = useState(false)
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null)
  const [lastScan, setLastScan] = useState<{ scannedAt: number; newItems: number; totalItems: number } | null>(null)

  // Path accessibility
  const [pathAccessible, setPathAccessible] = useState<boolean | null>(null)

  // View mode (persisted to localStorage)
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const saved = localStorage.getItem(VIEW_MODE_KEY)
      if (saved === 'grid' || saved === 'compact' || saved === 'list') return saved
    } catch { /* ignore */ }
    return 'grid'
  })

  // ─── Fetch page from DB ────────────────────────────────────────────────────

  const fetchPage = useCallback(async (offset: number, replace: boolean) => {
    if (replace) {
      setLoading(true)
      setError(null)
    } else {
      setLoadingMore(true)
    }

    try {
      const result = await window.api.library.getPaginated({
        offset,
        limit: PAGE_SIZE,
        sortField,
        searchQuery: debouncedSearch || undefined,
        artistFilters: selectedArtistFilters.size > 0 ? [...selectedArtistFilters] : undefined,
        seriesFilters: selectedSeriesFilters.size > 0 ? [...selectedSeriesFilters] : undefined,
        tagFilters: selectedTagFilters.size > 0 ? [...selectedTagFilters] : undefined,
        showUnmatchedOnly: showUnmatchedOnly || undefined
      })

      if (result.success && result.data) {
        const newItems = result.data.items as unknown as LibraryItemData[]
        setTotalCount(result.data.total)
        currentOffset.current = offset + newItems.length

        if (replace) {
          setItems(newItems)
        } else {
          setItems((prev) => {
            const existingIds = new Set(prev.map((i) => i.id))
            const unique = newItems.filter((item) => !existingIds.has(item.id))
            return [...prev, ...unique]
          })
        }
      } else {
        if (replace) setError(result.error || 'Failed to load library')
      }
    } catch (err) {
      if (replace) setError(String(err))
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [sortField, debouncedSearch, selectedArtistFilters, selectedSeriesFilters, selectedTagFilters, showUnmatchedOnly])

  // ─── Load more (infinite scroll) ───────────────────────────────────────────

  const loadMore = useCallback(() => {
    if (loadingMore || items.length >= totalCount) return
    fetchPage(currentOffset.current, false)
  }, [loadingMore, items.length, totalCount, fetchPage])

  // ─── Reset and fetch when filters/sort/search change ───────────────────────

  useEffect(() => {
    fetchPage(0, true)
  }, [fetchPage]) // fetchPage already depends on sortField, debouncedSearch, filters

  // ─── Initial filter data load ──────────────────────────────────────────────

  useEffect(() => {
    Promise.all([
      window.api.library.getAllArtistNames(),
      window.api.library.getAllSeriesNames(),
      window.api.library.getAllTagNames()
    ]).then(([artistsR, seriesR, tagsR]) => {
      if (artistsR.success) setArtistNames(artistsR.data as string[])
      if (seriesR.success) setSeriesNames(seriesR.data as string[])
      if (tagsR.success) setTagNames(tagsR.data as string[])
    }).catch(() => {})
  }, [])

  // ─── Scan status ───────────────────────────────────────────────────────────

  const fetchScanStatus = useCallback(async () => {
    try {
      const result = await window.api.library.getScanStatus()
      if (result.success && result.data) {
        setScanning(result.data.scanning)
        if (result.data.lastScan) {
          setLastScan({
            scannedAt: result.data.lastScan.scannedAt,
            newItems: result.data.lastScan.newItems,
            totalItems: result.data.lastScan.totalItems
          })
        }
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchScanStatus()
  }, [fetchScanStatus])

  // ─── Path accessibility check ──────────────────────────────────────────────

  useEffect(() => {
    if (items.length === 0) { setPathAccessible(null); return }
    const firstItem = items[0]
    if (!firstItem?.filePath) { setPathAccessible(null); return }
    const parentDir = firstItem.filePath.replace(/[/\\][^/\\]+$/, '')
    window.api.library.isPathAccessible(parentDir).then((result) => {
      setPathAccessible(result.success ? (result.data as boolean) : null)
    }).catch(() => setPathAccessible(null))
  }, [items])

  // ─── Scan Event Listeners ──────────────────────────────────────────────────

  useEffect(() => {
    const unsubProgress = window.api.onLibraryScanProgress((progress) => {
      setScanProgress(progress)
      setScanPaused(false)
    })
    const unsubComplete = window.api.onLibraryScanComplete((result) => {
      setScanning(false)
      setScanPaused(false)
      setScanProgress(null)
      setLastScan({
        scannedAt: Date.now(),
        newItems: result.newItems,
        totalItems: result.total
      })
      // The scanner skips removing "missing" items when discovery looked
      // incomplete. Surface that, otherwise the guard is invisible and stale
      // rows look like a bug.
      if (result.removalSkippedReason) {
        setError(result.removalSkippedReason)
      }
      // Refresh data after scan completes
      fetchPage(0, true)
    })
    const unsubError = window.api.onLibraryScanError((err) => {
      setScanning(false)
      setScanPaused(false)
      setScanProgress(null)
      setError(err)
    })

    // Live item streaming: prepend batched new items during active scan
    const unsubNewItems = window.api.onLibraryNewItems((batch) => {
      setItems((prev) => {
        const existingIds = new Set(prev.map((i) => i.id))
        const newItems: LibraryItemData[] = []
        for (const item of batch) {
          if (existingIds.has(item.id)) continue
          newItems.push({
            id: item.id,
            galleryId: null,
            isCustom: 0,
            customTitle: item.title,
            customTags: null,
            customLanguage: null,
            customDate: null,
            customCoverPath: null,
            filePath: '',
            fileSize: null,
            format: 'pdf',
            primaryArtist: item.artist,
            seriesName: null,
            seriesIndex: null,
            language: null,
            publisher: null,
            description: null,
            readProgress: 0,
            addedAt: Date.now(),
            updatedAt: Date.now()
          })
        }
        if (newItems.length > 0) {
          return [...newItems, ...prev]
        }
        return prev
      })
    })

    const unsubPaused = window.api.onLibraryScanPaused(() => setScanPaused(true))
    const unsubCancelled = window.api.onLibraryScanCancelled(() => {
      setScanning(false)
      setScanPaused(false)
      setScanProgress(null)
    })

    return () => {
      unsubProgress()
      unsubComplete()
      unsubError()
      unsubNewItems()
      unsubPaused()
      unsubCancelled()
    }
  }, [fetchPage])

  // ─── Rescan ────────────────────────────────────────────────────────────────

  const handleRescan = async () => {
    if (!libraryRoot.trim()) {
      setError('No library path configured. Set one in Settings first.')
      return
    }
    setScanning(true)
    setScanProgress({ current: 0, total: 0, status: 'Starting scan...' })
    try {
      const result = await window.api.library.scan(libraryRoot)
      if (!result?.success) {
        setScanning(false)
        setError(result?.error || 'Failed to start scan')
      }
    } catch (err) {
      setScanning(false)
      setError(String(err))
    }
  }

  const handlePauseScan = async () => { try { await window.api.library.pauseScan() } catch { /* */ } }
  const handleResumeScan = async () => { try { await window.api.library.resumeScan() } catch { /* */ } }
  const handleCancelScan = async () => { try { await window.api.library.cancelScan() } catch { /* */ } }

  // ─── Selection ─────────────────────────────────────────────────────────────

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setSelectionTick((t) => t + 1)
  }, [])

  const handleCheckboxToggle = useCallback((id: number) => {
    if (!selectMode) setSelectMode(true)
    toggleSelect(id)
  }, [selectMode, toggleSelect])

  // Auto-exit selection mode when no items are selected
  useEffect(() => {
    if (selectedIds.size === 0 && selectMode) {
      setSelectMode(false)
    }
  }, [selectedIds.size, selectMode])

  // ─── Batch Actions ─────────────────────────────────────────────────────────

  const handleBatchRemove = async () => {
    const ids = [...selectedIds]
    for (const id of ids) {
      try { await window.api.library.delete(id) } catch { /* */ }
    }
    setSelectedIds(new Set())
    setSelectionTick((t) => t + 1)
    fetchPage(0, true)
  }

  const handleBatchDelete = async () => {
    const ids = [...selectedIds]
    for (const id of ids) {
      try { await window.api.library.deleteFile(id) } catch { /* */ }
    }
    setSelectedIds(new Set())
    setSelectionTick((t) => t + 1)
    fetchPage(0, true)
  }

  /**
   * Convert the selected PDFs to CBZ.
   *
   * Only PDFs are sent; the main process filters again and reports `skipped`, so
   * a mixed selection is fine. The await runs for as long as the whole batch
   * does — progress arrives on its own channel, and the store is driven by those
   * events rather than by this promise.
   */
  const handleBatchConvertToCbz = async (keepOriginal: boolean): Promise<void> => {
    const ids = items.filter((i) => selectedIds.has(i.id) && (i.format || 'pdf') === 'pdf').map((i) => i.id)
    if (ids.length === 0) return
    useCbzConversionStore.getState().begin(ids.length)
    try {
      const r = await window.api.library.convertToCbz(ids, false, { keepOriginal })
      if (!r?.success) setError(r?.error || 'Conversion failed')
      else if (r.data?.forcedKeeps > 0) {
        setError(
          `${r.data.forcedKeeps} original PDF${r.data.forcedKeeps === 1 ? ' was' : 's were'} kept ` +
          `because that conversion needed the fallback converter — the PDF is the better copy. ` +
          `They are in _originals/_lossy/.`
        )
      }
    } catch (e) {
      setError(String(e))
    } finally {
      // The store is also finished by the running:false event; this covers a
      // handler that returned early (e.g. the library-path guard) and never
      // emitted one.
      useCbzConversionStore.getState().finish()
      setSelectedIds(new Set())
      setSelectionTick((t) => t + 1)
      fetchPage(0, true)
    }
  }

  const handleBatchUnassignSeries = async () => {
    const ids = [...selectedIds]
    for (const id of ids) {
      try { await window.api.library.updateMetadata(id, { seriesName: null, seriesIndex: null }) } catch { /* */ }
    }
    setSelectedIds(new Set())
    setSelectionTick((t) => t + 1)
    fetchPage(0, true)
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === items.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(items.map((i) => i.id)))
    }
    setSelectionTick((t) => t + 1)
  }

  /**
   * How many of the selected items can actually be converted.
   *
   * Shown in the button label so a selection of already-converted CBZs reads as
   * "nothing to do" rather than starting a batch that silently skips everything.
   */
  const pdfSelectionCount = items.reduce(
    (n, i) => (selectedIds.has(i.id) && (i.format || 'pdf') === 'pdf' ? n + 1 : n),
    0
  )

  // ─── Progress ──────────────────────────────────────────────────────────────

  // Global jobs (sync, both conversions) come from their stores; the scan is
  // owned by this page, so it is prepended here. All of them render through the
  // same component in one stack under the header.
  const globalJobs = useGlobalJobs()
  const jobs: ProgressJob[] = []
  if (scanning && scanProgress) {
    jobs.push({
      id: 'scan',
      label: scanProgress.status || 'Scanning library',
      current: scanProgress.current,
      // 0 until the walk finishes counting — the bar shows motion rather than a
      // fake 10% fill, which is what it used to do.
      total: scanProgress.total,
      tone: 'read',
      onCancel: handleCancelScan
    })
  }
  jobs.push(...globalJobs)

  // ─── Filter Toggles ────────────────────────────────────────────────────────

  const toggleArtistFilter = (artist: string) => {
    setSelectedArtistFilters((prev) => {
      const next = new Set(prev)
      if (next.has(artist)) { next.delete(artist) } else { next.add(artist) }
      return next
    })
  }

  const toggleSeriesFilter = (series: string) => {
    setSelectedSeriesFilters((prev) => {
      const next = new Set(prev)
      if (next.has(series)) { next.delete(series) } else { next.add(series) }
      return next
    })
  }

  const toggleTagFilter = (tag: string) => {
    setSelectedTagFilters((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) { next.delete(tag) } else { next.add(tag) }
      return next
    })
  }

  // ─── Format Helpers ────────────────────────────────────────────────────────

  const formatDate = (ts: number): string => {
    return new Date(ts).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    })
  }

  // ─── Virtuoso Grid List Component ──────────────────────────────────────────

  const virtuosoList = useMemo(() => {
    const gridCols = viewMode === 'compact'
      ? 'grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 xl:grid-cols-12 gap-2'
      : 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4'
    return React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
      (props, ref) => (
        <div
          ref={ref}
          {...props}
          className={`${gridCols} ${props.className || ''}`}
        />
      )
    )
  }, [viewMode])

  // ─── View mode persistence ─────────────────────────────────────────────────

  const setViewModePersisted = useCallback((mode: ViewMode) => {
    setViewMode(mode)
    try { localStorage.setItem(VIEW_MODE_KEY, mode) } catch { /* ignore */ }
  }, [])

  // ─── Loading State ─────────────────────────────────────────────────────────

  const hasMore = items.length < totalCount

  // One header for all three states. It was repeated in each branch, and the
  // error branch had already lost the subtitle the other two carried.
  const header = (
    <div className="mb-4 shrink-0">
      <h1 className="text-2xl font-bold tracking-tight text-fg">Library</h1>
      <p className="mt-1 text-sm text-fg-muted">
        {totalCount > 0 ? (
          <>
            <span className="tnum">{totalCount}</span> items in library
          </>
        ) : (
          'Browse your downloaded doujinshi collection'
        )}
        {lastScan && (
          <span className="ml-2 text-xs text-fg-faint">
            (last scan: {formatDate(lastScan.scannedAt)})
          </span>
        )}
      </p>
    </div>
  )

  if (loading && items.length === 0) {
    return (
      <div className="flex flex-col h-full">
        {header}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          <LoadingSkeleton count={12} variant="card" />
        </div>
      </div>
    )
  }

  // ─── Error State ───────────────────────────────────────────────────────────

  if (error && items.length === 0) {
    return (
      <div className="flex flex-col h-full">
        {header}
        <ErrorState message={error} onRetry={() => fetchPage(0, true)} />
      </div>
    )
  }

  // ─── Main Render ───────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {header}
      {/*
        One notification region. These were four separately styled banners with
        their own paddings and margins; with two visible at once the grid began
        below the fold. Now they share a container, a gap and a shape.

        The storage warning is `warning`, not `error` — it previously wore the
        same red as a genuine failure despite the app still working from cached
        metadata.
      */}
      <ProgressStack jobs={jobs} />
      <NoticeRegion>
        <ResumeConversionBanner />
        {error && (
          <Notice tone="error" onDismiss={() => setError(null)}>
            {error}
          </Notice>
        )}
        {items.length > 0 && pathAccessible === false && (
          <Notice tone="warning">
            Library storage is not accessible. The network drive may be disconnected, so this
            is cached metadata only.
          </Notice>
        )}
      </NoticeRegion>

      {/*
        Toolbar. Only view-level actions live here; batch actions moved to the
        selection bar below the grid, so entering select mode no longer grows
        this row from three buttons to eight and pushes the grid off screen.

        The scan control is one button whose label, icon and handler change with
        state, rather than four differently coloured buttons across three
        branches.
      */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {!scanning && !scanPaused && (
          <Button
            role="primary"
            icon={<RefreshCw size={16} />}
            onClick={handleRescan}
            disabled={conversionStore.running}
            title={conversionStore.running ? 'Scan disabled during metadata conversion' : 'Rescan Library'}
          >
            Rescan Library
          </Button>
        )}
        {scanning && !scanPaused && (
          <>
            <Button role="secondary" icon={<Pause size={16} />} onClick={handlePauseScan}>
              Pause Scan
            </Button>
            <Button role="ghost" onClick={handleCancelScan}>
              Cancel
            </Button>
          </>
        )}
        {scanPaused && (
          <>
            <Button role="primary" icon={<Play size={16} />} onClick={handleResumeScan}>
              Resume Scan
            </Button>
            <Button role="ghost" onClick={handleCancelScan}>
              Cancel
            </Button>
          </>
        )}

        <Button icon={<Plus size={16} />} onClick={() => setShowCustomForm(true)}>
          Add Custom
        </Button>

        <div className="flex-1" />

        {/* Search input */}
        <div className="relative">
          <input
            type="text"
            placeholder="Search library..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-48 md:w-56 pl-8 pr-3 py-2 rounded-lg border border-line bg-surface text-sm text-fg focus:ring-2 focus:ring-accent focus:border-transparent"
          />
          <svg className="absolute left-2.5 top-2.5 h-4 w-4 text-fg-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>

        {/* Sort dropdown */}
        <select
          value={sortField}
          onChange={(e) => setSortField(e.target.value as SortField)}
          className="px-3 py-2 rounded-lg border border-line bg-surface text-sm text-fg focus:ring-2 focus:ring-accent"
        >
          <option value="added">Date Added</option>
          <option value="title">Title</option>
          <option value="artist">Artist</option>
        </select>

        {/* Filters toggle */}
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${showFilters || selectedArtistFilters.size > 0 || selectedSeriesFilters.size > 0 || showUnmatchedOnly ? 'bg-accent-wash text-accent' : 'bg-raised text-fg-muted hover:bg-raised'}`}
        >
          <SlidersHorizontal size={16} aria-hidden="true" /> Filters
          {(selectedArtistFilters.size > 0 || selectedSeriesFilters.size > 0 || showUnmatchedOnly) && (
            <span className="ml-1 text-xs">({selectedArtistFilters.size + selectedSeriesFilters.size + (showUnmatchedOnly ? 1 : 0)})</span>
          )}
        </button>

        {/* View mode toggle */}
        <div className="flex rounded-lg border border-line overflow-hidden">
          {(['grid', 'compact', 'list'] as ViewMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => setViewModePersisted(mode)}
              className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${
                viewMode === mode
                  ? 'bg-accent-fill text-white'
                  : 'bg-surface text-fg-muted hover:bg-raised'
              }`}
              title={mode === 'grid' ? 'Grid view' : mode === 'compact' ? 'Compact view' : 'List view'}
            >
              {mode === 'grid' ? (
                <LayoutGrid size={16} aria-hidden="true" />
              ) : mode === 'compact' ? (
                <Grid3x3 size={16} aria-hidden="true" />
              ) : (
                <List size={16} aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/*
        Selection bar.

        Above the grid, directly under the toolbar. Below the grid it was easy to
        miss entirely — with a full page of cards it sat off screen, so the
        actions for a selection you had just made were somewhere you had to go
        looking for. It is still its own bar rather than part of the toolbar, so
        entering select mode does not reflow the toolbar row.

        Destructive actions sit last, after a divider, in the `danger` role —
        outlined rather than filled, since a filled red would read as the
        primary action of the view.
      */}
      {selectMode && (
        <div className="shrink-0 mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent-wash px-3 py-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={selectedIds.size === items.length && items.length > 0}
              onChange={toggleSelectAll}
              className="h-4 w-4 rounded border-line text-accent focus:ring-accent"
            />
            <span>
              <span className="tnum font-semibold">{selectedIds.size}</span> selected
            </span>
          </label>

          <span className="mx-1 h-5 w-px bg-line" />

          <Button size="sm" icon={<Layers size={14} />} onClick={() => setShowSeriesModal(true)}>
            Assign Series
          </Button>
          <Button size="sm" role="ghost" onClick={handleBatchUnassignSeries}>
            Unassign
          </Button>
          <Button
            size="sm"
            icon={<RefreshCw size={14} />}
            onClick={async () => {
              const ids = [...selectedIds]
              if (ids.length === 0) return
              setBatchSyncing(true)
              try {
                await window.api.library.syncBatch(ids)
              } catch {
                /* the sync worker reports its own failures to the log */
              }
              setBatchSyncing(false)
            }}
            disabled={batchSyncing}
          >
            {batchSyncing ? 'Syncing…' : 'Sync'}
          </Button>
          <Button
            size="sm"
            icon={<FileArchive size={14} />}
            onClick={() => setShowConvertDialog(true)}
            disabled={cbzRunning || pdfSelectionCount === 0}
            count={pdfSelectionCount}
            title={
              pdfSelectionCount === 0
                ? 'None of the selected files are PDFs'
                : `Convert ${pdfSelectionCount} PDF${pdfSelectionCount === 1 ? '' : 's'} to CBZ`
            }
          >
            {cbzRunning ? 'Converting…' : 'Convert to CBZ'}
          </Button>

          <span className="mx-1 h-5 w-px bg-line" />

          <Button size="sm" role="ghost" onClick={handleBatchRemove}>
            Remove from Library
          </Button>
          <Button size="sm" role="danger" icon={<Trash2 size={14} />} onClick={handleBatchDelete}>
            Delete Files
          </Button>

          {/*
            Done, far right. Selection mode is entered by ticking a card's
            checkbox, so there is no longer a Select button in the toolbar — that
            button could not work anyway: it set selectMode with nothing selected,
            and the effect that exits selection mode when the set is empty
            immediately turned it back off.
          */}
          <Button
            size="sm"
            role="ghost"
            icon={<Check size={14} />}
            onClick={() => {
              setSelectedIds(new Set())
              setSelectMode(false)
              setSelectionTick((tick) => tick + 1)
            }}
            extraClass="ml-auto"
          >
            Done
          </Button>
        </div>
      )}

      {/* Scan progress bar */}
      {/* Filter panel */}
      {showFilters && (
        <div className="mb-4 p-4 rounded-lg bg-raised/50 border border-line">
          <div className="flex flex-wrap gap-6">
            {artistNames.length > 0 && (
              <SearchableFilterDropdown
                label="Artists"
                allItems={artistNames}
                selected={selectedArtistFilters}
                onToggle={toggleArtistFilter}
                placeholder="Search artists..."
              />
            )}

            {seriesNames.length > 0 && (
              <SearchableFilterDropdown
                label="Series"
                allItems={seriesNames}
                selected={selectedSeriesFilters}
                onToggle={toggleSeriesFilter}
                placeholder="Search series..."
              />
            )}

            {tagNames.length > 0 && (
              <SearchableFilterDropdown
                label="Tags"
                allItems={tagNames}
                selected={selectedTagFilters}
                onToggle={toggleTagFilter}
                placeholder="Search tags..."
              />
            )}

            <div>
              <h4 className="text-sm font-medium text-fg mb-2">Other</h4>
              <label className="flex items-center gap-2 text-sm text-fg-muted cursor-pointer hover:text-fg">
                <input type="checkbox" checked={showUnmatchedOnly} onChange={() => setShowUnmatchedOnly(!showUnmatchedOnly)} className="w-3.5 h-3.5 rounded border-line text-accent focus:ring-accent" />
                Unmatched only
              </label>
            </div>
          </div>

          {(selectedArtistFilters.size > 0 || selectedSeriesFilters.size > 0 || showUnmatchedOnly) && (
            <button onClick={() => { setSelectedArtistFilters(new Set()); setSelectedSeriesFilters(new Set()); setShowUnmatchedOnly(false) }} className="mt-3 text-xs text-accent hover:underline">
              Clear all filters
            </button>
          )}
        </div>
      )}

      {/* Content area */}
      {items.length === 0 ? (
        <EmptyState icon={Library} title="Library is empty" description="Download your first doujin or add a custom entry to get started" actionLabel="Rescan Library" onAction={handleRescan} />
      ) : viewMode === 'list' ? (
        <div className="flex-1">
          {/* Column headers */}
          <div className="flex items-center gap-3 px-4 py-2 border-b-2 border-line bg-raised/80 text-xs font-semibold text-fg-muted uppercase tracking-wider">
            <div className="w-3.5 shrink-0" />
            <div className="flex-1 min-w-0">Title</div>
            <div className="w-32 shrink-0">Artist</div>
            {/*
              Series gets the width freed from Size and Date. Volume is no longer
              right-aligned: a short "V1" pushed to the right edge of its cell
              left an obvious gap after a truncated series name, which read as
              the series being cut off early for no reason. Left-aligned, the two
              sit together as the pair they are.
            */}
            <div className="w-36 shrink-0">Series</div>
            <div className="w-10 shrink-0">Vol</div>
            <div className="w-16 shrink-0">Lang</div>
            <div className="w-14 shrink-0">Fmt</div>
            {/* Size never exceeds '999.9 KB'; the date is at most 'dd.mm.yyyy'. */}
            <div className="w-16 shrink-0 text-right">Size</div>
            <div className="w-20 shrink-0 text-right">Date</div>
          </div>
          <Virtuoso
            totalCount={items.length}
            endReached={loadMore}
            overscan={400}
            useWindowScroll={false}
            components={{
              Footer: hasMore
                ? () => (
                    <div className="flex justify-center py-4">
                      <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                    </div>
                  )
                : undefined as any
            }}
            itemContent={(index) => {
              const item = items[index]
              if (!item) return null
              const title = item.customTitle || item.primaryArtist || `Item #${item.id}`
              const formatSize = (bytes: number | null): string => {
                if (!bytes) return '—'
                if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
                return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
              }
              const addedDate = new Date(item.addedAt).toLocaleDateString()
              return (
                <div
                  className={`flex items-center gap-3 px-4 py-2 border-b border-line hover:bg-raised cursor-pointer transition-colors ${selectedIds.has(item.id) ? 'bg-accent-wash' : ''}`}
                  onClick={() => {
                    if (selectMode) {
                      toggleSelect(item.id)
                    } else {
                      const found = items.find((i) => i.id === item.id)
                      if (found) setDetailItem(found)
                    }
                  }}
                >
                  {/* Checkbox */}
                  <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(item.id)}
                      onChange={() => handleCheckboxToggle(item.id)}
                      className="w-3.5 h-3.5 rounded border-line text-accent focus:ring-accent"
                    />
                  </div>
                  {/* Title */}
                  <div className="flex-1 min-w-0">
                    <InlineEditCell
                      value={item.customTitle || ''}
                      displayValue={title}
                      itemId={item.id}
                      field="customTitle"
                      className="text-sm font-medium text-fg truncate"
                    />
                  </div>
                  {/* Artist */}
                  <div className="w-32 shrink-0">
                    <InlineEditCell
                      value={item.primaryArtist || ''}
                      displayValue={item.primaryArtist || '—'}
                      itemId={item.id}
                      field="primaryArtist"
                      autocompleteKind="artist"
                      className="text-xs text-fg-muted truncate"
                    />
                  </div>
                  {/* Series */}
                  <div className="w-36 shrink-0">
                    <InlineEditCell
                      value={item.seriesName || ''}
                      displayValue={item.seriesName || '—'}
                      itemId={item.id}
                      field="seriesName"
                      autocompleteKind="series"
                      className="text-xs text-info truncate"
                    />
                  </div>
                  {/* Volume */}
                  <div className="w-10 shrink-0">
                    <InlineEditCell
                      value={item.seriesIndex != null ? String(item.seriesIndex) : ''}
                      displayValue={item.seriesIndex != null ? `V${item.seriesIndex}` : '—'}
                      itemId={item.id}
                      field="seriesIndex"
                      className="text-xs text-fg-muted"
                    />
                  </div>
                  {/* Language */}
                  <div className="w-16 shrink-0">
                    <p className="text-xs text-fg-muted truncate">{item.language || item.customLanguage || '—'}</p>
                  </div>
                  {/* Format */}
                  <div className="w-14 shrink-0">
                    <span className="text-xs px-1.5 py-0.5 rounded bg-accent-wash text-accent">{item.format?.toUpperCase() || 'PDF'}</span>
                  </div>
                  {/* Size */}
                  <div className="w-16 shrink-0 text-right">
                    <p className="tnum text-xs text-fg-muted">{formatSize(item.fileSize)}</p>
                  </div>
                  {/* Date */}
                  <div className="w-20 shrink-0 text-right">
                    <p className="tnum text-xs text-fg-faint">{addedDate}</p>
                  </div>
                </div>
              )
            }}
            style={{ height: '100%' }}
          />
        </div>
      ) : (
        <div className="flex-1">
          <VirtuosoGrid
            totalCount={items.length}
            endReached={loadMore}
            overscan={400}
            useWindowScroll={false}
            components={{
              List: virtuosoList as any,
              Footer: hasMore
                ? () => (
                    <div className="flex justify-center py-4">
                      <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                    </div>
                  )
                : undefined as any
            }}
            itemContent={(index) => {
              const item = items[index]
              if (!item) return null
              return (
                <LibraryCard
                  key={item.id}
                  item={item}
                  selected={selectedIds.has(item.id)}
                  onToggleSelect={handleCheckboxToggle}
                  compact={viewMode === 'compact'}
                  onClick={(id) => {
                    if (selectMode) {
                      toggleSelect(id)
                    } else {
                      const found = items.find((i) => i.id === id)
                      if (found) setDetailItem(found)
                    }
                  }}
                />
              )
            }}
            style={{ height: '100%' }}
          />
        </div>
      )}

      {/* Convert to CBZ — asks what to do with the source PDFs */}
      {showConvertDialog && (
        <ConvertToCbzDialog
          count={pdfSelectionCount}
          onCancel={() => setShowConvertDialog(false)}
          onConfirm={(keepOriginal) => {
            setShowConvertDialog(false)
            void handleBatchConvertToCbz(keepOriginal)
          }}
        />
      )}

      {/* Series Assignment Modal */}
      <SeriesAssignment
        isOpen={showSeriesModal}
        items={items.filter((item) => selectedIds.has(item.id))}
        onClose={() => setShowSeriesModal(false)}
        onAssigned={() => {
          setShowSeriesModal(false)
          setSelectedIds(new Set())
          setSelectMode(false)
          fetchPage(0, true)
        }}
      />

      {/* Custom Entry Form Modal */}
      <CustomEntryForm
        isOpen={showCustomForm}
        libraryRoot={libraryRoot}
        onClose={() => setShowCustomForm(false)}
        onCreated={() => {
          setShowCustomForm(false)
          fetchPage(0, true)
        }}
      />

      {/* Library Detail Panel */}
      <LibraryDetail
        item={detailItem}
        libraryRoot={libraryRoot}
        onClose={() => setDetailItem(null)}
        onDeleted={() => {
          setDetailItem(null)
          fetchPage(0, true)
        }}
        onUpdated={() => {
          fetchPage(0, true)
        }}
        onFilterArtist={(artist) => {
          setSelectedArtistFilters(new Set([artist]))
          setShowFilters(true)
          fetchPage(0, true)
        }}
        onFilterPublisher={(publisher) => {
          setSelectedArtistFilters(new Set([publisher]))
          setShowFilters(true)
          fetchPage(0, true)
        }}
        onFilterTag={(tag) => {
          setSelectedTagFilters(new Set([tag]))
          setShowFilters(true)
          fetchPage(0, true)
        }}
        onOpenInSearch={(galleryId) => {
          useSearchStore.getState().setPendingGalleryId(galleryId)
          navigate('/search')
        }}
      />
    </div>
  )
}
