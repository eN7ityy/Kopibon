import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { VirtuosoGrid } from 'react-virtuoso'
import type { LibraryItemData } from './LibraryCard'
import LibraryCard from './LibraryCard'
import SeriesAssignment from './SeriesAssignment'
import CustomEntryForm from './CustomEntryForm'
import LibraryDetail from './LibraryDetail'
import EmptyState from '../shared/EmptyState'
import ErrorState from '../shared/ErrorState'
import LoadingSkeleton from '../shared/LoadingSkeleton'

// ─── Types ───────────────────────────────────────────────────────────────────

type SortField = 'added' | 'title' | 'artist'

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

// ─── Library Page ────────────────────────────────────────────────────────────

export default function LibraryPage(): React.JSX.Element {
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
          setTotalCount((t) => t + newItems.length)
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
    setScanning(true)
    setScanProgress({ current: 0, total: 0, status: 'Starting scan...' })
    try {
      await window.api.library.scan('/mnt/bragi/Kavita/Doujins/')
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
    return React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
      (props, ref) => (
        <div
          ref={ref}
          {...props}
          className={
            `grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 ${props.className || ''}`
          }
        />
      )
    )
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

      {/* Error banner */}
      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm flex items-center justify-between">
          <span>⚠️ {error}</span>
          <button onClick={() => setError(null)} className="ml-2 text-red-500 hover:text-red-700 dark:hover:text-red-300">✕</button>
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
          <button onClick={handleRescan} className="px-4 py-2 rounded-lg bg-purple-600 text-white font-medium text-sm hover:bg-purple-700 transition-colors flex items-center gap-2">
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
              <div>
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Artists</h4>
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {artistNames.slice(0, 50).map((artist) => (
                    <label key={artist} className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer hover:text-gray-900 dark:hover:text-gray-200">
                      <input type="checkbox" checked={selectedArtistFilters.has(artist)} onChange={() => toggleArtistFilter(artist)} className="w-3.5 h-3.5 rounded border-gray-400 text-purple-600 focus:ring-purple-500" />
                      {artist}
                    </label>
                  ))}
                  {artistNames.length > 50 && <p className="text-xs text-gray-400">...and {artistNames.length - 50} more</p>}
                </div>
              </div>
            )}

            {seriesNames.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Series</h4>
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {seriesNames.slice(0, 50).map((series) => (
                    <label key={series} className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer hover:text-gray-900 dark:hover:text-gray-200">
                      <input type="checkbox" checked={selectedSeriesFilters.has(series)} onChange={() => toggleSeriesFilter(series)} className="w-3.5 h-3.5 rounded border-gray-400 text-purple-600 focus:ring-purple-500" />
                      {series}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {tagNames.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Tags</h4>
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {tagNames.slice(0, 50).map((tag) => (
                    <label key={tag} className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer hover:text-gray-900 dark:hover:text-gray-200">
                      <input type="checkbox" checked={selectedTagFilters.has(tag)} onChange={() => toggleTagFilter(tag)} className="w-3.5 h-3.5 rounded border-gray-400 text-purple-600 focus:ring-purple-500" />
                      {tag}
                    </label>
                  ))}
                </div>
              </div>
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
        libraryRoot="/mnt/bragi/Kavita/Doujins/"
        onClose={() => setShowCustomForm(false)}
        onCreated={() => {
          setShowCustomForm(false)
          fetchPage(0, true)
        }}
      />

      {/* Library Detail Panel */}
      <LibraryDetail
        item={detailItem}
        libraryRoot="/mnt/bragi/Kavita/Doujins/"
        onClose={() => setDetailItem(null)}
        onDeleted={() => {
          setDetailItem(null)
          fetchPage(0, true)
        }}
        onUpdated={() => {
          fetchPage(0, true)
        }}
      />
    </div>
  )
}
