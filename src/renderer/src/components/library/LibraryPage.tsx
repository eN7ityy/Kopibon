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
import SyncProgressBar from './SyncProgressBar'

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
      <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{label}</h4>

      {/* Search input */}
      <div className="relative mb-2">
        <input
          type="text"
          placeholder={placeholder}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setShowDropdown(true) }}
          onFocus={() => setShowDropdown(true)}
          className="w-full pl-7 pr-2 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-purple-500 focus:border-transparent"
        />
        <svg className="absolute left-2 top-2 h-3 w-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </div>

      {/* Dropdown */}
      {showDropdown && filtered.length > 0 && (
        <div className="max-h-40 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg mb-2">
          {filtered.map((item) => (
            <label
              key={item}
              className="flex items-center gap-2 px-2 py-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <input
                type="checkbox"
                checked={selected.has(item)}
                onChange={() => onToggle(item)}
                className="w-3 h-3 rounded border-gray-400 text-purple-600 focus:ring-purple-500"
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
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 cursor-pointer hover:bg-purple-200 dark:hover:bg-purple-900/60 transition-colors"
            >
              {item.length > 20 ? item.slice(0, 20) + '…' : item}
              <span className="ml-0.5 text-purple-500">×</span>
            </span>
          ))}
          {selected.size > 15 && (
            <span className="text-xs text-gray-400 self-center">+{selected.size - 15} more</span>
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
              className="text-xs px-2 py-0.5 rounded bg-purple-600 text-white hover:bg-purple-700"
            >
              ✓
            </button>
            <button
              onClick={cancel}
              className="text-xs px-2 py-0.5 rounded bg-gray-300 dark:bg-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-400"
            >
              ✕
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
        className={`w-full px-1 py-0.5 text-xs rounded border border-purple-400 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-purple-500 focus:outline-none ${className}`}
      />
    )
  }

  return (
    <p
      className={`text-xs cursor-pointer hover:text-purple-600 dark:hover:text-purple-400 transition-colors ${className}`}
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

  if (loading && items.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Library</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Loading your doujinshi collection...
          </p>
        </div>
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
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Library</h1>
        </div>
        <ErrorState message={error} onRetry={() => fetchPage(0, true)} />
      </div>
    )
  }

  // ─── Main Render ───────────────────────────────────────────────────────────

  const hasMore = items.length < totalCount

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Library</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {totalCount > 0
            ? `${totalCount} items in library`
            : 'Browse your downloaded doujinshi collection'}
          {lastScan && (
            <span className="ml-2 text-xs text-gray-400">
              (last scan: {formatDate(lastScan.scannedAt)})
            </span>
          )}
        </p>
      </div>
      <SyncProgressBar />

      {/* Error banner */}
      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm flex items-center justify-between">
          <span>⚠️ {error}</span>
          <button onClick={() => setError(null)} className="ml-2 text-red-500 hover:text-red-700 dark:hover:text-red-300">✕</button>
          {conversionStore.running && (
            <div className="mt-1 p-1.5 rounded bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 text-orange-700 dark:text-orange-400 text-xs flex items-center gap-2">
              <div className="w-3 h-3 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
              Converting metadata... {conversionStore.current}/{conversionStore.total}
            </div>
          )}
        </div>
      )}

      {/* Path inaccessible warning */}
      {items.length > 0 && pathAccessible === false && (
        <div className="mb-3 p-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-xs">
          ⚠️ Library storage is not accessible. The network drive may be disconnected. Showing cached metadata only.
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        {/* Rescan / Pause / Resume button */}
        {!scanning && !scanPaused && (
          <button
            onClick={handleRescan}
            disabled={conversionStore.running}
            title={conversionStore.running ? 'Scan disabled during metadata conversion' : 'Rescan Library'}
            className="px-4 py-2 rounded-lg bg-purple-600 text-white font-medium text-sm hover:bg-purple-700 transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            🔄 Rescan Library
          </button>
        )}
        {scanning && !scanPaused && (
          <>
            <button onClick={handlePauseScan} className="px-4 py-2 rounded-lg bg-yellow-600 text-white font-medium text-sm hover:bg-yellow-700 transition-colors flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
              Pause Scan
            </button>
            <button onClick={handleCancelScan} className="px-3 py-2 rounded-lg bg-red-600 text-white font-medium text-sm hover:bg-red-700 transition-colors">✕ Cancel</button>
          </>
        )}
        {scanPaused && (
          <>
            <button onClick={handleResumeScan} className="px-4 py-2 rounded-lg bg-green-600 text-white font-medium text-sm hover:bg-green-700 transition-colors flex items-center gap-2">▶ Resume Scan</button>
            <button onClick={handleCancelScan} className="px-3 py-2 rounded-lg bg-red-600 text-white font-medium text-sm hover:bg-red-700 transition-colors">✕ Cancel</button>
          </>
        )}

        <button onClick={() => setShowCustomForm(true)} className="px-4 py-2 rounded-lg bg-green-600 text-white font-medium text-sm hover:bg-green-700 transition-colors">
          + Add Custom
        </button>

        {items.length > 0 && (
          <button
            onClick={() => { setSelectMode(!selectMode); if (selectMode) { setSelectedIds(new Set()); setSelectionTick((t) => t + 1) } }}
            className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${selectMode ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
          >
            {selectMode ? `Selected (${selectedIds.size})` : 'Select'}
          </button>
        )}

        {selectMode && selectedIds.size > 0 && (
          <>
            <button onClick={() => setShowSeriesModal(true)} className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors">Assign Series</button>
            <button onClick={handleBatchUnassignSeries} className="px-3 py-2 rounded-lg bg-gray-600 text-white text-sm font-medium hover:bg-gray-700 transition-colors">Unassign Series</button>
            <button
              onClick={async () => {
                const ids = [...selectedIds]
                if (ids.length === 0) return
                setBatchSyncing(true)
                try {
                  await window.api.library.syncBatch(ids)
                } catch (e) {
                  console.error('Batch sync error:', e)
                }
                setBatchSyncing(false)
              }}
              disabled={batchSyncing}
              className="px-3 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 disabled:opacity-40 transition-colors"
            >
              {batchSyncing ? 'Syncing...' : 'Sync with Nhentai'}
            </button>
            <button onClick={handleBatchRemove} className="px-3 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:bg-orange-700 transition-colors">Remove from Library</button>
            <button onClick={handleBatchDelete} className="px-3 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors">Delete Files</button>
          </>
        )}

        <div className="flex-1" />

        {/* Search input */}
        <div className="relative">
          <input
            type="text"
            placeholder="Search library..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-48 md:w-56 pl-8 pr-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-purple-500 focus:border-transparent"
          />
          <svg className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>

        {/* Sort dropdown */}
        <select
          value={sortField}
          onChange={(e) => setSortField(e.target.value as SortField)}
          className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-purple-500"
        >
          <option value="added">Date Added</option>
          <option value="title">Title</option>
          <option value="artist">Artist</option>
        </select>

        {/* Filters toggle */}
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${showFilters || selectedArtistFilters.size > 0 || selectedSeriesFilters.size > 0 || showUnmatchedOnly ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
        >
          🔍 Filters
          {(selectedArtistFilters.size > 0 || selectedSeriesFilters.size > 0 || showUnmatchedOnly) && (
            <span className="ml-1 text-xs">({selectedArtistFilters.size + selectedSeriesFilters.size + (showUnmatchedOnly ? 1 : 0)})</span>
          )}
        </button>

        {/* View mode toggle */}
        <div className="flex rounded-lg border border-gray-300 dark:border-gray-600 overflow-hidden">
          {(['grid', 'compact', 'list'] as ViewMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => setViewModePersisted(mode)}
              className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${
                viewMode === mode
                  ? 'bg-purple-600 text-white'
                  : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
              title={mode === 'grid' ? 'Grid view' : mode === 'compact' ? 'Compact view' : 'List view'}
            >
              {mode === 'grid' ? '⊞' : mode === 'compact' ? '▦' : '☰'}
            </button>
          ))}
        </div>
      </div>

      {/* Scan progress bar */}
      {scanning && scanProgress && (
        <div className="mb-4">
          <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
            <span>{scanProgress.status}</span>
            <span>{scanProgress.total > 0 ? `${scanProgress.current}/${scanProgress.total}` : '...'}</span>
          </div>
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
            <div className="bg-purple-600 h-2 rounded-full transition-all duration-300" style={{ width: scanProgress.total > 0 ? `${(scanProgress.current / scanProgress.total) * 100}%` : '10%' }} />
          </div>
        </div>
      )}

      {/* Filter panel */}
      {showFilters && (
        <div className="mb-4 p-4 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700">
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
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Other</h4>
              <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer hover:text-gray-900 dark:hover:text-gray-200">
                <input type="checkbox" checked={showUnmatchedOnly} onChange={() => setShowUnmatchedOnly(!showUnmatchedOnly)} className="w-3.5 h-3.5 rounded border-gray-400 text-purple-600 focus:ring-purple-500" />
                Unmatched only
              </label>
            </div>
          </div>

          {(selectedArtistFilters.size > 0 || selectedSeriesFilters.size > 0 || showUnmatchedOnly) && (
            <button onClick={() => { setSelectedArtistFilters(new Set()); setSelectedSeriesFilters(new Set()); setShowUnmatchedOnly(false) }} className="mt-3 text-xs text-purple-600 dark:text-purple-400 hover:underline">
              Clear all filters
            </button>
          )}
        </div>
      )}

      {/* Select all bar */}
      {selectMode && items.length > 0 && (
        <div className="mb-3 flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
            <input type="checkbox" checked={selectedIds.size === items.length && items.length > 0} onChange={toggleSelectAll} className="w-4 h-4 rounded border-gray-400 text-purple-600 focus:ring-purple-500" />
            Select all ({items.length})
          </label>
        </div>
      )}

      {/* Content area */}
      {items.length === 0 ? (
        <EmptyState icon="📚" title="Library is empty" description="Download your first doujin or add a custom entry to get started" actionLabel="Rescan Library" onAction={handleRescan} />
      ) : viewMode === 'list' ? (
        <div className="flex-1">
          {/* Column headers */}
          <div className="flex items-center gap-3 px-4 py-2 border-b-2 border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800/80 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
            <div className="w-3.5 shrink-0" />
            <div className="flex-1 min-w-0">Title</div>
            <div className="w-32 shrink-0">Artist</div>
            <div className="w-28 shrink-0">Series</div>
            <div className="w-12 shrink-0 text-right">Vol</div>
            <div className="w-16 shrink-0">Lang</div>
            <div className="w-14 shrink-0">Fmt</div>
            <div className="w-20 shrink-0 text-right">Size</div>
            <div className="w-24 shrink-0 text-right">Date</div>
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
                      <div className="w-6 h-6 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
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
                  className={`flex items-center gap-3 px-4 py-2 border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors ${selectedIds.has(item.id) ? 'bg-purple-50 dark:bg-purple-900/20' : ''}`}
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
                      className="w-3.5 h-3.5 rounded border-gray-400 text-purple-600 focus:ring-purple-500"
                    />
                  </div>
                  {/* Title */}
                  <div className="flex-1 min-w-0">
                    <InlineEditCell
                      value={item.customTitle || ''}
                      displayValue={title}
                      itemId={item.id}
                      field="customTitle"
                      className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate"
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
                      className="text-xs text-gray-500 dark:text-gray-400 truncate"
                    />
                  </div>
                  {/* Series */}
                  <div className="w-28 shrink-0">
                    <InlineEditCell
                      value={item.seriesName || ''}
                      displayValue={item.seriesName || '—'}
                      itemId={item.id}
                      field="seriesName"
                      autocompleteKind="series"
                      className="text-xs text-blue-600 dark:text-blue-400 truncate"
                    />
                  </div>
                  {/* Volume */}
                  <div className="w-12 shrink-0 text-right">
                    <InlineEditCell
                      value={item.seriesIndex != null ? String(item.seriesIndex) : ''}
                      displayValue={item.seriesIndex != null ? `V${item.seriesIndex}` : '—'}
                      itemId={item.id}
                      field="seriesIndex"
                      className="text-xs text-gray-500 dark:text-gray-400"
                    />
                  </div>
                  {/* Language */}
                  <div className="w-16 shrink-0">
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{item.language || item.customLanguage || '—'}</p>
                  </div>
                  {/* Format */}
                  <div className="w-14 shrink-0">
                    <span className="text-xs px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300">{item.format?.toUpperCase() || 'PDF'}</span>
                  </div>
                  {/* Size */}
                  <div className="w-20 shrink-0 text-right">
                    <p className="text-xs text-gray-500 dark:text-gray-400">{formatSize(item.fileSize)}</p>
                  </div>
                  {/* Date */}
                  <div className="w-24 shrink-0 text-right">
                    <p className="text-xs text-gray-400">{addedDate}</p>
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
                      <div className="w-6 h-6 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
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
