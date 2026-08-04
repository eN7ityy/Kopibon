import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSearchStore } from '../../stores/search.store'
import { useLibraryStore, type LibraryRow } from '../../stores/library.store'
import { VirtuosoGrid, Virtuoso } from 'react-virtuoso'
import type { LibraryItemData } from './LibraryCard'
import LibraryCard from './LibraryCard'
import SeriesCard, { type SeriesCardModel } from './SeriesCard'
import SeriesDetail from './SeriesDetail'
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
import ResumeSyncBanner from './ResumeSyncBanner'
import { useCbzConversionStore } from '../../stores/cbz-conversion.store'
import { useGlobalJobs, type ProgressJob } from '../../stores/job-progress'
import { ProgressStack } from '../shared/ProgressBar'
import Button from '../shared/Button'
import Notice, { NoticeRegion } from '../shared/Notice'
import { mergeDisplayLanguages } from '../shared/language'
import { Check, FileArchive, Grid3x3, Layers, LayoutGrid, Library, List, ListChecks, ListX, Pause, Play, Plus, RefreshCw, SlidersHorizontal, Trash2, X } from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────────────────

type SortField = 'added' | 'title' | 'artist'
type ViewMode = 'grid' | 'compact' | 'list'

/** Every gallery a row stands for — one for an item, the matches for a series. */
function rowGalleryIds(row: LibraryRow): number[] {
  return row.kind === 'item' ? [row.item.id] : row.series.members.map((m) => m.id)
}

/**
 * A row's identity, for deduplicating pages and keying React.
 *
 * The kind has to be part of it. `series.id` and `library_item.id` come from
 * separate autoincrement sequences, so series 42 and gallery 42 both exist and
 * a bare id would treat them as the same row.
 */
function rowKey(row: LibraryRow): string {
  return row.kind === 'item' ? `i${row.item.id}` : `s${row.series.id}`
}

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
  const libraryRoot = useSettingsStore((s) => s.libraryPath)
  const kavitaUrl = useSettingsStore((s) => s.kavitaUrl)
  const kavitaApiKey = useSettingsStore((s) => s.kavitaApiKey)
  const kavitaLibraryId = useSettingsStore((s) => s.kavitaLibraryId)
  const kavitaEnabled = useSettingsStore((s) => s.kavitaEnabled)
  // The toggle used to be checked nowhere, so switching it off did not hide
  // the "also remove from Kavita" option below.
  const kavitaConfigured = Boolean(
    kavitaEnabled && kavitaUrl.trim() && kavitaApiKey.trim() && kavitaLibraryId.trim()
  )

  // ── Store state (persisted across tab switches) ──────────────────────────
  const rows = useLibraryStore((s) => s.rows)
  const totalCount = useLibraryStore((s) => s.totalCount)
  const galleryCount = useLibraryStore((s) => s.galleryCount)
  const loading = useLibraryStore((s) => s.loading)
  const error = useLibraryStore((s) => s.error)
  const searchQuery = useLibraryStore((s) => s.searchQuery)
  const sortField = useLibraryStore((s) => s.sortField)
  const selectedArtistFilters = useLibraryStore((s) => s.selectedArtistFilters)
  const selectedSeriesFilters = useLibraryStore((s) => s.selectedSeriesFilters)
  const selectedTagFilters = useLibraryStore((s) => s.selectedTagFilters)
  const showUnmatchedOnly = useLibraryStore((s) => s.showUnmatchedOnly)
  const viewMode = useLibraryStore((s) => s.viewMode)
  const showFilters = useLibraryStore((s) => s.showFilters)
  const detailItem = useLibraryStore((s) => s.detailItem)
  const detailSeries = useLibraryStore((s) => s.detailSeries)

  // Derive Sets for SearchableFilterDropdown (store holds string[])
  const artistFilterSet = useMemo(() => new Set(selectedArtistFilters), [selectedArtistFilters])
  const seriesFilterSet = useMemo(() => new Set(selectedSeriesFilters), [selectedSeriesFilters])
  const tagFilterSet = useMemo(() => new Set(selectedTagFilters), [selectedTagFilters])

  const debouncedSearch = useDebounce(searchQuery, 150)

  // ── Transient state (not persisted) ──────────────────────────────────────
  const [artistNames, setArtistNames] = useState<string[]>([])
  const [seriesNames, setSeriesNames] = useState<string[]>([])
  const [tagNames, setTagNames] = useState<string[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [, setSelectionTick] = useState(0)
  const [batchSyncing, setBatchSyncing] = useState(false)
  const [showConvertDialog, setShowConvertDialog] = useState(false)
  const [batchRemoveConfirm, setBatchRemoveConfirm] = useState(false)
  const [batchAlsoFromKavita, setBatchAlsoFromKavita] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selectingAll, setSelectingAll] = useState(false)
  const [selectionFormats, setSelectionFormats] = useState<Map<number, string>>(new Map())
  const [scanning, setScanning] = useState(false)
  const [scanPaused, setScanPaused] = useState(false)
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null)
  const [lastScan, setLastScan] = useState<{ scannedAt: number; newItems: number; totalItems: number } | null>(null)
  const [pathAccessible, setPathAccessible] = useState<boolean | null>(null)
  const [showSeriesModal, setShowSeriesModal] = useState(false)
  const [showCustomForm, setShowCustomForm] = useState(false)

  // ── Derived ──────────────────────────────────────────────────────────────
  const items = useMemo<LibraryItemData[]>(
    () => rows.flatMap((row) => (row.kind === 'item' ? [row.item] : [])),
    [rows]
  )

  const visibleGalleryIds = useMemo(() => rows.flatMap(rowGalleryIds), [rows])

  const allVisibleSelected =
    visibleGalleryIds.length > 0 && visibleGalleryIds.every((id) => selectedIds.has(id))

  // ─── Fetch page from DB ────────────────────────────────────────────────────

  const fetchPage = useCallback(async (offset: number, replace: boolean) => {
    const state = useLibraryStore.getState()
    if (replace) {
      state.setLoading(true)
    } else {
      state.setLoadingMore(true)
    }

    try {
      const result = await window.api.library.getPaginatedGrouped({
        offset,
        limit: PAGE_SIZE,
        sortField: state.sortField,
        searchQuery: state.searchQuery || undefined,
        artistFilters: state.selectedArtistFilters.length > 0 ? state.selectedArtistFilters : undefined,
        seriesFilters: state.selectedSeriesFilters.length > 0 ? state.selectedSeriesFilters : undefined,
        tagFilters: state.selectedTagFilters.length > 0 ? state.selectedTagFilters : undefined,
        showUnmatchedOnly: state.showUnmatchedOnly || undefined
      })

      if (result.success && result.data) {
        const newRows = result.data.rows as unknown as LibraryRow[]
        state.setResults(newRows, result.data.total, result.data.galleries, replace)
        state.setOffset(offset + newRows.length)
      } else {
        if (replace) state.setError(result.error || 'Failed to load library')
        else state.setLoadingMore(false)
      }
    } catch (err) {
      if (replace) state.setError(String(err))
      else state.setLoadingMore(false)
    }
  }, [])

  const refreshLoaded = useCallback(async () => {
    const state = useLibraryStore.getState()
    const loaded = Math.max(state.currentOffset, PAGE_SIZE)
    try {
      const result = await window.api.library.getPaginatedGrouped({
        offset: 0,
        limit: loaded,
        sortField: state.sortField,
        searchQuery: state.searchQuery || undefined,
        artistFilters: state.selectedArtistFilters.length > 0 ? state.selectedArtistFilters : undefined,
        seriesFilters: state.selectedSeriesFilters.length > 0 ? state.selectedSeriesFilters : undefined,
        tagFilters: state.selectedTagFilters.length > 0 ? state.selectedTagFilters : undefined,
        showUnmatchedOnly: state.showUnmatchedOnly || undefined
      })
      if (result.success && result.data) {
        const newRows = result.data.rows as unknown as LibraryRow[]
        state.setResults(newRows, result.data.total, result.data.galleries, true)
        state.setOffset(newRows.length)
      }
    } catch {
      // keep showing what we had
    }
  }, [])

  // ─── Load more (infinite scroll) ───────────────────────────────────────────

  const loadMore = useCallback(() => {
    const state = useLibraryStore.getState()
    if (state.loadingMore || state.rows.length >= state.totalCount) return
    fetchPage(state.currentOffset, false)
  }, [fetchPage])

  // ─── Mount: show cached rows or fetch ──────────────────────────────────────

  const mountedRef = useRef(false)
  useEffect(() => {
    window.api.library.isPathAccessible(libraryRoot).then(setPathAccessible)
    // Always fetch on mount: if the store has cached rows they render immediately,
    // and the grid updates when fresh data arrives (silent background refresh).
    fetchPage(0, true)
    mountedRef.current = true
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Reset and fetch when filters/sort/search change ───────────────────────

  useEffect(() => {
    if (!mountedRef.current) return
    fetchPage(0, true)
  }, [sortField, debouncedSearch, selectedArtistFilters, selectedSeriesFilters, selectedTagFilters, showUnmatchedOnly]) // eslint-disable-line react-hooks/exhaustive-deps

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
      if (result.removalSkippedReason) {
        useLibraryStore.getState().setError(result.removalSkippedReason)
      }
      fetchPage(0, true)
    })
    const unsubError = window.api.onLibraryScanError((err) => {
      setScanning(false)
      setScanPaused(false)
      setScanProgress(null)
      useLibraryStore.getState().setError(err)
    })

    const unsubNewItems = window.api.onLibraryNewItems((batch) => {
      useLibraryStore.setState((prev) => {
        const existingIds = new Set(
          prev.rows.flatMap((row) => (row.kind === 'item' ? [row.item.id] : []))
        )
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
          return {
            rows: [...newItems.map((item) => ({ kind: 'item' as const, item })), ...prev.rows]
          }
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

  // ─── Download Event Listener ──────────────────────────────────────────────
  //
  // When a download finishes, the placeholder row gains its cover path and a
  // real file path. Refresh the loaded rows so LibraryCard's thumbnail effect
  // (keyed on customCoverPath) re-fires and the cover appears without a remount.
  // Cheap and fire-and-forget; only the currently loaded page is re-fetched.
  useEffect(() => {
    const unsubProgress = window.api.onDownloadProgress((progress) => {
      if (progress.status === 'completed') {
        void refreshLoaded()
      }
    })
    return unsubProgress
  }, [refreshLoaded])

  // ─── Rescan ────────────────────────────────────────────────────────────────

  const handleRescan = async () => {
    if (!libraryRoot.trim()) {
      useLibraryStore.getState().setError('No library path configured. Set one in Settings first.')
      return
    }
    setScanning(true)
    setScanProgress({ current: 0, total: 0, status: 'Starting scan...' })
    try {
      const result = await window.api.library.scan(libraryRoot)
      if (!result?.success) {
        setScanning(false)
        useLibraryStore.getState().setError(result?.error || 'Failed to start scan')
      }
    } catch (err) {
      setScanning(false)
      useLibraryStore.getState().setError(String(err))
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

  const handleSeriesToggle = useCallback(
    (series: SeriesCardModel) => {
      if (!selectMode) setSelectMode(true)
      const allSelected = series.members.every((m) => selectedIds.has(m.id))

      setSelectedIds((prev) => {
        const next = new Set(prev)
        for (const member of series.members) {
          if (allSelected) next.delete(member.id)
          else next.add(member.id)
        }
        return next
      })

      setSelectionFormats((prev) => {
        const next = new Map(prev)
        for (const member of series.members) {
          if (allSelected) next.delete(member.id)
          else next.set(member.id, member.format || 'pdf')
        }
        return next
      })

      setSelectionTick((t) => t + 1)
    },
    [selectMode, selectedIds]
  )

  // Auto-exit selection mode when no items are selected
  useEffect(() => {
    if (selectedIds.size === 0 && selectMode) {
      setSelectMode(false)
    }
  }, [selectedIds.size, selectMode])

  // ─── Batch Actions ─────────────────────────────────────────────────────────

  const runBatchRemove = async (alsoFromKavita: boolean): Promise<void> => {
    const ids = [...selectedIds]
    try { await window.api.library.deleteMultiple(ids, alsoFromKavita) } catch { /* */ }
    setSelectedIds(new Set()); setSelectionFormats(new Map())
    setSelectionTick((t) => t + 1)
    fetchPage(0, true)
  }

  const handleBatchRemove = async () => {
    // When Kavita is connected, ask whether the items should leave Kavita too.
    if (kavitaConfigured) {
      setBatchAlsoFromKavita(false)
      setBatchRemoveConfirm(true)
      return
    }
    await runBatchRemove(false)
  }

  const handleBatchDelete = async () => {
    const ids = [...selectedIds]
    try { await window.api.library.deleteFileMultiple(ids) } catch { /* */ }
    setSelectedIds(new Set()); setSelectionFormats(new Map())
    setSelectionTick((t) => t + 1)
    fetchPage(0, true)
  }

  const handleBatchConvertToCbz = async (keepOriginal: boolean): Promise<void> => {
    const ids = pdfSelectionIds
    if (ids.length === 0) return
    useCbzConversionStore.getState().begin(ids.length)
    try {
      const r = await window.api.library.convertToCbz(ids, false, { keepOriginal })
      if (!r?.success) useLibraryStore.getState().setError(r?.error || 'Conversion failed')
      else if (r.data?.forcedKeeps > 0) {
        useLibraryStore.getState().setError(
          `${r.data.forcedKeeps} original PDF${r.data.forcedKeeps === 1 ? ' was' : 's were'} kept ` +
          `because that conversion needed the fallback converter — the PDF is the better copy. ` +
          `They are in _originals/_lossy/.`
        )
      }
    } catch (e) {
      useLibraryStore.getState().setError(String(e))
    } finally {
      useCbzConversionStore.getState().finish()
      setSelectedIds(new Set()); setSelectionFormats(new Map())
      setSelectionTick((t) => t + 1)
      fetchPage(0, true)
    }
  }

  const handleSelectAllInLibrary = async (): Promise<void> => {
    setSelectingAll(true)
    try {
      const state = useLibraryStore.getState()
      const result = await window.api.library.getAllIds({
        searchQuery: state.searchQuery || undefined,
        artistFilters: state.selectedArtistFilters.length > 0 ? state.selectedArtistFilters : undefined,
        seriesFilters: state.selectedSeriesFilters.length > 0 ? state.selectedSeriesFilters : undefined,
        tagFilters: state.selectedTagFilters.length > 0 ? state.selectedTagFilters : undefined,
        showUnmatchedOnly: state.showUnmatchedOnly || undefined
      })
      if (result.success && Array.isArray(result.data)) {
        const matched = result.data as Array<{ id: number; format: string }>
        setSelectedIds(new Set(matched.map((row) => row.id)))
        setSelectionFormats(new Map(matched.map((row) => [row.id, row.format || 'pdf'])))
        setSelectionTick((tick) => tick + 1)
      }
    } catch {
      /* leaving the existing selection alone is the safe failure here */
    } finally {
      setSelectingAll(false)
    }
  }

  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelectedIds(new Set()); setSelectionFormats(new Map())
    } else {
      setSelectedIds(new Set(visibleGalleryIds))
    }
    setSelectionTick((t) => t + 1)
  }

  const formatOf = useCallback(
    (id: number): string => {
      const loaded = items.find((i) => i.id === id)
      if (loaded) return loaded.format || 'pdf'
      return selectionFormats.get(id) || 'pdf'
    },
    [items, selectionFormats]
  )

  const pdfSelectionIds = useMemo(
    () => [...selectedIds].filter((id) => formatOf(id) === 'pdf'),
    [selectedIds, formatOf]
  )
  const pdfSelectionCount = pdfSelectionIds.length

  // ─── Progress ──────────────────────────────────────────────────────────────

  const globalJobs = useGlobalJobs()
  const jobs: ProgressJob[] = []
  if (scanning && scanProgress) {
    jobs.push({
      id: 'scan',
      label: scanProgress.status || 'Scanning library',
      current: scanProgress.current,
      total: scanProgress.total,
      tone: 'read',
      onCancel: handleCancelScan
    })
  }
  jobs.push(...globalJobs)

  // ─── Filter Toggles ────────────────────────────────────────────────────────

  const toggleArtistFilter = (artist: string) => {
    const prev = useLibraryStore.getState().selectedArtistFilters
    const next = prev.includes(artist)
      ? prev.filter((a) => a !== artist)
      : [...prev, artist]
    useLibraryStore.getState().setSelectedArtistFilters(next)
  }

  const toggleSeriesFilter = (series: string) => {
    const prev = useLibraryStore.getState().selectedSeriesFilters
    const next = prev.includes(series)
      ? prev.filter((s) => s !== series)
      : [...prev, series]
    useLibraryStore.getState().setSelectedSeriesFilters(next)
  }

  const toggleTagFilter = (tag: string) => {
    const prev = useLibraryStore.getState().selectedTagFilters
    const next = prev.includes(tag)
      ? prev.filter((t) => t !== tag)
      : [...prev, tag]
    useLibraryStore.getState().setSelectedTagFilters(next)
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

  // ─── Loading State ─────────────────────────────────────────────────────────

  const hasMore = rows.length < totalCount

  // One header for all three states.
  const header = (
    <div className="mb-4 shrink-0">
      <h1 className="text-2xl font-bold tracking-tight text-fg">Library</h1>
      <p className="mt-1 text-sm text-fg-muted">
        {galleryCount > 0 ? (
          <>
            <span className="tnum">{galleryCount}</span> items in library
            {totalCount !== galleryCount && (
              <span className="text-fg-faint">
                {' '}
                · <span className="tnum">{totalCount}</span> rows
              </span>
            )}
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

  // Only show the skeleton on the initial empty-library load. Guard on
  // debouncedSearch: while the user is typing, a mid-search loading state would
  // replace the whole view (including the search input) and drop focus.
  if (loading && items.length === 0 && !debouncedSearch) {
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

  if (error && items.length === 0 && !debouncedSearch) {
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
      <ProgressStack jobs={jobs} />
      <NoticeRegion>
        <ResumeConversionBanner />
      <ResumeSyncBanner />
        {error && (
          <Notice tone="error" onDismiss={() => useLibraryStore.getState().setError(null)}>
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
            onChange={(e) => useLibraryStore.getState().setSearchQuery(e.target.value)}
            className="w-48 md:w-56 pl-8 pr-3 py-2 rounded-lg border border-line bg-surface text-sm text-fg focus:ring-2 focus:ring-accent focus:border-transparent"
          />
          <svg className="absolute left-2.5 top-2.5 h-4 w-4 text-fg-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>

        {/* Sort dropdown */}
        <select
          value={sortField}
          onChange={(e) => useLibraryStore.getState().setSortField(e.target.value as SortField)}
          className="px-3 py-2 rounded-lg border border-line bg-surface text-sm text-fg focus:ring-2 focus:ring-accent"
        >
          <option value="added">Date Added</option>
          <option value="title">Title</option>
          <option value="artist">Artist</option>
        </select>

        <button
          onClick={() => useLibraryStore.getState().setShowFilters(!showFilters)}
          className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${showFilters || selectedArtistFilters.length > 0 || selectedSeriesFilters.length > 0 || showUnmatchedOnly ? 'bg-accent-wash text-accent' : 'bg-raised text-fg-muted hover:bg-raised'}`}
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
          Filters
          {(selectedArtistFilters.length > 0 || selectedSeriesFilters.length > 0 || showUnmatchedOnly) && (
            <span className="tnum text-xs">({selectedArtistFilters.length + selectedSeriesFilters.length + (showUnmatchedOnly ? 1 : 0)})</span>
          )}
        </button>
      </div>

      {/* View mode row */}
      <div className="mb-4 flex shrink-0 items-center">
        <div className="flex rounded-lg border border-line overflow-hidden">
          {(['grid', 'compact', 'list'] as ViewMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => useLibraryStore.getState().setViewMode(mode)}
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

      {/* Selection bar */}
      {selectMode && (
        <div className="shrink-0 mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent-wash px-3 py-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleSelectAll}
              className="h-4 w-4 rounded border-line text-accent focus:ring-accent"
            />
            <span>
              <span className="tnum font-semibold">{selectedIds.size}</span> selected
            </span>
          </label>

          {galleryCount > visibleGalleryIds.length && (
            <Button
              size="sm"
              role="ghost"
              icon={<ListChecks size={14} />}
              onClick={handleSelectAllInLibrary}
              disabled={selectingAll}
              title={`Select all ${galleryCount} items matching the current filters`}
            >
              {selectingAll ? 'Selecting…' : `Select all ${galleryCount}`}
            </Button>
          )}

          <span className="mx-1 h-5 w-px bg-line" />

          <Button size="sm" icon={<Layers size={14} />} onClick={() => setShowSeriesModal(true)}>
            Assign Series
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
              void refreshLoaded()
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

          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              role="secondary"
              icon={<ListX size={14} />}
              onClick={handleBatchRemove}
            >
              Remove from Library
            </Button>
            <Button size="sm" role="danger" icon={<Trash2 size={14} />} onClick={handleBatchDelete}>
              Delete Files
            </Button>

            <span className="mx-1 h-5 w-px bg-line" />

            <Button
              size="sm"
              role="primary"
              icon={<Check size={14} />}
              onClick={() => {
                setSelectedIds(new Set()); setSelectionFormats(new Map())
                setSelectMode(false)
                setSelectionTick((tick) => tick + 1)
              }}
            >
              Done
            </Button>
          </div>
        </div>
      )}

      {/* Filter panel */}
      {showFilters && (
        <div className="mb-4 p-4 rounded-lg bg-raised/50 border border-line">
          <div className="flex flex-wrap gap-6">
            {artistNames.length > 0 && (
              <SearchableFilterDropdown
                label="Artists"
                allItems={artistNames}
                selected={artistFilterSet}
                onToggle={toggleArtistFilter}
                placeholder="Search artists..."
              />
            )}

            {seriesNames.length > 0 && (
              <SearchableFilterDropdown
                label="Series"
                allItems={seriesNames}
                selected={seriesFilterSet}
                onToggle={toggleSeriesFilter}
                placeholder="Search series..."
              />
            )}

            {tagNames.length > 0 && (
              <SearchableFilterDropdown
                label="Tags"
                allItems={tagNames}
                selected={tagFilterSet}
                onToggle={toggleTagFilter}
                placeholder="Search tags..."
              />
            )}

            <div>
              <h4 className="text-sm font-medium text-fg mb-2">Other</h4>
              <label className="flex items-center gap-2 text-sm text-fg-muted cursor-pointer hover:text-fg">
                <input
                  type="checkbox"
                  checked={showUnmatchedOnly}
                  onChange={() => useLibraryStore.getState().setShowUnmatchedOnly(!showUnmatchedOnly)}
                  className="w-3.5 h-3.5 rounded border-line text-accent focus:ring-accent"
                />
                No nhentai ID
              </label>
            </div>
          </div>

          {(selectedArtistFilters.length > 0 || selectedSeriesFilters.length > 0 || showUnmatchedOnly) && (
            <button
              onClick={() => useLibraryStore.getState().resetFilters()}
              className="mt-3 text-xs text-accent hover:underline"
            >
              Clear all filters
            </button>
          )}
        </div>
      )}

      {/* Content area */}
      {rows.length === 0 ? (
        <EmptyState icon={Library} title="Library is empty" description="Download your first doujin or add a custom entry to get started" actionLabel="Rescan Library" onAction={handleRescan} />
      ) : viewMode === 'list' ? (
        <div className="flex-1">
          {/* Column headers */}
          <div className="flex items-center gap-3 px-4 py-2 border-b-2 border-line bg-raised/80 text-xs font-semibold text-fg-muted uppercase tracking-wider">
            <div className="w-3.5 shrink-0" />
            <div className="flex-1 min-w-0">Title</div>
            <div className="w-32 shrink-0">Artist</div>
            <div className="w-36 shrink-0">Series</div>
            <div className="w-10 shrink-0">Vol</div>
            <div className="w-16 shrink-0">Lang</div>
            <div className="w-14 shrink-0">Fmt</div>
            <div className="w-16 shrink-0 text-right">Size</div>
            <div className="w-20 shrink-0 text-right">Date</div>
          </div>
          <Virtuoso
            totalCount={rows.length}
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
              const row = rows[index]
              if (!row) return null

              const formatSize = (bytes: number | null): string => {
                if (!bytes) return '—'
                if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
                return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
              }

              if (row.kind === 'series') {
                const series = row.series
                const members = series.members
                const selectedCount = members.filter((m) => selectedIds.has(m.id)).length
                const allSelected = members.length > 0 && selectedCount === members.length
                const languages = mergeDisplayLanguages(series.languages)
                return (
                  <div
                    className={`flex cursor-pointer items-center gap-3 border-b border-line px-4 py-2 transition-colors hover:bg-raised ${
                      selectedCount > 0 ? 'bg-accent-wash' : ''
                    }`}
                    onClick={() => {
                      if (selectMode) handleSeriesToggle(series)
                      else useLibraryStore.getState().setDetailSeries(series)
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = !allSelected && selectedCount > 0
                      }}
                      onChange={() => handleSeriesToggle(series)}
                      onClick={(e) => e.stopPropagation()}
                      className="h-4 w-4 shrink-0 rounded border-line text-accent focus:ring-accent"
                    />
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <Layers size={14} className="shrink-0 text-accent" aria-hidden="true" />
                      <span className="truncate text-sm font-medium text-fg">{series.name}</span>
                      <span className="tnum shrink-0 rounded bg-raised px-1.5 py-0.5 text-xs text-fg-muted">
                        {series.matchCount < series.totalCount
                          ? `${series.matchCount} of ${series.totalCount}`
                          : series.totalCount}
                      </span>
                    </div>
                    <div className="w-32 shrink-0 truncate text-xs text-accent">
                      {series.artists[0] ?? '—'}
                      {series.artists.length > 1 && (
                        <span className="text-fg-faint"> +{series.artists.length - 1}</span>
                      )}
                    </div>
                    <div className="w-36 shrink-0 truncate text-xs text-fg-muted">—</div>
                    <div className="w-10 shrink-0 text-xs text-fg-faint">—</div>
                    <div className="w-16 shrink-0 truncate text-xs text-fg-muted">
                      {languages[0] ?? '—'}
                    </div>
                    <div className="w-14 shrink-0 text-xs uppercase text-fg-muted">
                      {series.format ?? '—'}
                    </div>
                    <div className="w-16 shrink-0 text-right">
                      <p className="tnum text-xs text-fg-faint">{formatSize(series.fileSize)}</p>
                    </div>
                    <div className="w-20 shrink-0 text-right">
                      <p className="tnum text-xs text-fg-faint">
                        {new Date(series.addedAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                )
              }

              const item = row.item
              const title = item.customTitle || item.primaryArtist || `Item #${item.id}`
              const addedDate = new Date(item.addedAt).toLocaleDateString()
              return (
                <div
                  className={`flex items-center gap-3 px-4 py-2 border-b border-line hover:bg-raised cursor-pointer transition-colors ${selectedIds.has(item.id) ? 'bg-accent-wash' : ''}`}
                  onClick={() => {
                    if (selectMode) {
                      toggleSelect(item.id)
                    } else {
                      const found = items.find((i) => i.id === item.id)
                      if (found) useLibraryStore.getState().setDetailItem(found)
                    }
                  }}
                >
                  <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(item.id)}
                      onChange={() => handleCheckboxToggle(item.id)}
                      className="w-3.5 h-3.5 rounded border-line text-accent focus:ring-accent"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <InlineEditCell
                      value={item.customTitle || ''}
                      displayValue={title}
                      itemId={item.id}
                      field="customTitle"
                      className="text-sm font-medium text-fg truncate"
                    />
                  </div>
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
                  <div className="w-10 shrink-0">
                    <InlineEditCell
                      value={item.seriesIndex != null ? String(item.seriesIndex) : ''}
                      displayValue={item.seriesIndex != null ? `V${item.seriesIndex}` : '—'}
                      itemId={item.id}
                      field="seriesIndex"
                      className="text-xs text-fg-muted"
                    />
                  </div>
                  <div className="w-16 shrink-0">
                    <p className="text-xs text-fg-muted truncate">{item.language || item.customLanguage || '—'}</p>
                  </div>
                  <div className="w-14 shrink-0">
                    <span className="text-xs px-1.5 py-0.5 rounded bg-accent-wash text-accent">{item.format?.toUpperCase() || 'PDF'}</span>
                  </div>
                  <div className="w-16 shrink-0 text-right">
                    <p className="tnum text-xs text-fg-muted">{formatSize(item.fileSize)}</p>
                  </div>
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
            totalCount={rows.length}
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
              const row = rows[index]
              if (!row) return null

              if (row.kind === 'series') {
                const members = row.series.members
                const selectedCount = members.filter((m) => selectedIds.has(m.id)).length
                return (
                  <SeriesCard
                    key={rowKey(row)}
                    series={row.series}
                    selected={members.length > 0 && selectedCount === members.length}
                    partiallySelected={selectedCount > 0 && selectedCount < members.length}
                    onToggleSelect={handleSeriesToggle}
                    compact={viewMode === 'compact'}
                    onClick={(series) => {
                      if (selectMode) handleSeriesToggle(series)
                      else useLibraryStore.getState().setDetailSeries(series)
                    }}
                  />
                )
              }

              const item = row.item
              return (
                <LibraryCard
                  key={rowKey(row)}
                  item={item}
                  selected={selectedIds.has(item.id)}
                  onToggleSelect={handleCheckboxToggle}
                  compact={viewMode === 'compact'}
                  onClick={(id) => {
                    if (selectMode) {
                      toggleSelect(id)
                    } else {
                      const found = items.find((i) => i.id === id)
                      if (found) useLibraryStore.getState().setDetailItem(found)
                    }
                  }}
                />
              )
            }}
            style={{ height: '100%' }}
          />
        </div>
      )}

      {/* Convert to CBZ dialog */}
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
        allSelectedIds={[...selectedIds]}
        onClose={() => setShowSeriesModal(false)}
        onAssigned={() => {
          setShowSeriesModal(false)
          setSelectedIds(new Set()); setSelectionFormats(new Map())
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

      {/* Batch remove — confirms before it runs, and asks about Kavita. */}
      {batchRemoveConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setBatchRemoveConfirm(false)}
        >
          <div
            className="w-full max-w-sm rounded-xl bg-surface p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-section font-semibold text-fg mb-2">Remove from library?</h3>
            <p className="text-sm text-fg-muted mb-3">
              Remove {selectedIds.size} item{selectedIds.size === 1 ? '' : 's'} from the library.
              Files on disk are kept.
            </p>
            <label className="flex items-start gap-2 text-sm text-fg mb-3">
              <input
                type="checkbox"
                checked={batchAlsoFromKavita}
                onChange={(e) => setBatchAlsoFromKavita(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-line text-accent focus:ring-accent bg-surface"
              />
              <span>Also remove from the Kavita library</span>
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setBatchRemoveConfirm(false)
                  void runBatchRemove(batchAlsoFromKavita)
                }}
                className="flex-1 px-4 py-2 rounded-lg bg-warning-fill text-white text-sm font-medium hover:bg-warning-fill"
              >
                Remove
              </button>
              <button
                onClick={() => setBatchRemoveConfirm(false)}
                className="px-4 py-2 rounded-lg bg-raised text-sm font-medium text-fg"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Series Detail */}
      {detailSeries && (
        <SeriesDetail
          key={detailSeries.id}
          series={detailSeries}
          filters={{
            searchQuery: debouncedSearch || undefined,
            artistFilters: selectedArtistFilters.length > 0 ? selectedArtistFilters : undefined,
            seriesFilters: selectedSeriesFilters.length > 0 ? selectedSeriesFilters : undefined,
            tagFilters: selectedTagFilters.length > 0 ? selectedTagFilters : undefined,
            showUnmatchedOnly: showUnmatchedOnly || undefined
          }}
          onClose={() => useLibraryStore.getState().setDetailSeries(null)}
          onOpenItem={(item) => {
            useLibraryStore.getState().setDetailSeries(null)
            useLibraryStore.getState().setDetailItem(item)
          }}
          onChanged={() => fetchPage(0, true)}
        />
      )}

      {/* Library Detail Panel */}
      <LibraryDetail
        item={detailItem}
        libraryRoot={libraryRoot}
        onClose={() => useLibraryStore.getState().setDetailItem(null)}
        onDeleted={() => {
          useLibraryStore.getState().setDetailItem(null)
          fetchPage(0, true)
        }}
        onUpdated={() => {
          void refreshLoaded()
        }}
        onFilterArtist={(artist) => {
          useLibraryStore.getState().setSelectedArtistFilters([artist])
          useLibraryStore.getState().setShowFilters(true)
          fetchPage(0, true)
        }}
        onFilterPublisher={(publisher) => {
          useLibraryStore.getState().setSelectedArtistFilters([publisher])
          useLibraryStore.getState().setShowFilters(true)
          fetchPage(0, true)
        }}
        onFilterTag={(tag) => {
          useLibraryStore.getState().setSelectedTagFilters([tag])
          useLibraryStore.getState().setShowFilters(true)
          fetchPage(0, true)
        }}
        onOpenSeries={(ref) => {
          useLibraryStore.getState().setDetailItem(null)
          useLibraryStore.getState().setDetailSeries(ref)
        }}
        onOpenInSearch={(galleryId) => {
          useSearchStore.getState().setPendingGalleryId(galleryId)
          navigate('/search')
        }}
      />
    </div>
  )
}
