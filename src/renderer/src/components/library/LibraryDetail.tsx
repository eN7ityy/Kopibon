import { useState, useEffect, useCallback } from 'react'
import AutocompleteInput from '../shared/AutocompleteInput'
import PdfViewer from './PdfViewer'
import CbzViewer from './CbzViewer'
import type { LibraryItemData } from './LibraryCard'
import { useCbzConversionStore, useIsConverting } from '../../stores/cbz-conversion.store'
import ConvertToCbzDialog from './ConvertToCbzDialog'
import { AlertTriangle, BookOpen, FileArchive, FolderOpen, ListX, Loader2, Pencil, Trash2, X } from 'lucide-react'
import { sortTags, tagClass, type TagLike } from '../shared/tags'
import { useBlocked, blockedChipClass, blockedChipTitle } from '../shared/use-blocked'

// ─── Types ───────────────────────────────────────────────────────────────────

interface LibraryDetailProps {
  item: LibraryItemData | null
  onClose: () => void
  onDeleted: () => void
  onUpdated: () => void
  libraryRoot?: string
  onFilterArtist?: (artist: string) => void
  onFilterPublisher?: (publisher: string) => void
  onFilterTag?: (tag: string) => void
  onOpenInSearch?: (galleryId: number) => void
  /**
   * Open the series this gallery belongs to.
   *
   * Only offered when the name really resolves to a group — see `seriesRef`
   * below — so a one-shot does not get a link to a series of itself.
   */
  onOpenSeries?: (ref: { id: number; name: string; totalCount: number }) => void
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatFileSize(bytes: number | null): string {
  if (!bytes) return 'Unknown'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}

const LANGUAGES = ['English', 'Japanese', 'Chinese', 'Other']

// ─── Component ───────────────────────────────────────────────────────────────

export default function LibraryDetail({
  item, onClose, onDeleted, onUpdated, libraryRoot,
  onFilterArtist, onFilterPublisher, onFilterTag, onOpenInSearch, onOpenSeries
}: LibraryDetailProps): React.JSX.Element | null {
  const [editingRaw, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editSeries, setEditSeries] = useState('')
  const [editVolume, setEditVolume] = useState('')
  const [editTags, setEditTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [editLanguage, setEditLanguage] = useState('')
  const [editPublisher, setEditPublisher] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleteConfirmRaw, setDeleteConfirm] = useState<'none' | 'remove' | 'deleteFile'>('none')
  const [deleting, setDeleting] = useState(false)
  const [detailSyncing, setDetailSyncing] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [thumbDataUrl, setThumbDataUrl] = useState<string | null>(null)
  const [showPdfViewer, setShowPdfViewer] = useState(false)
  const [converting, setConverting] = useState(false)
  const [convertError, setConvertError] = useState<string | null>(null)
  const [showConvertDialog, setShowConvertDialog] = useState(false)

  // True while THIS item is being converted (or is queued for it). The main
  // process refuses edits, deletes, series changes and sync on such an item, so
  // the panel must not offer them.
  const isConverting = useIsConverting(item?.id)

  // A batch conversion can start while this panel is open in edit mode, and the
  // main process will refuse the save. Rather than reset the state in an effect
  // (which cascades a render and can flash the form), the locked state simply
  // wins when read: the form and the delete confirmations collapse for as long
  // as the item is converting, and reappear untouched if it fails.
  const editing = editingRaw && !isConverting
  const deleteConfirm = isConverting ? 'none' : deleteConfirmRaw

  // Autocomplete suggestions for tags
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([])
  const [showTagSuggestions, setShowTagSuggestions] = useState(false)

  // Re-fetch fresh data from DB whenever the selected item changes.
  // This ensures series, tags, thumbnail etc. are up-to-date after a scan
  // completes, rather than showing the stale snapshot from the grid.
  const { matcher: blockedMatch } = useBlocked()
  const [freshItem, setFreshItem] = useState<LibraryItemData | null>(null)

  /**
   * Typed tags for this item, used for the Genre and Parody rows.
   *
   * Empty for scanner-created items, which only ever stored a flat comma-joined
   * `custom_tags`. Syncing an item now backfills these.
   */
  const [typedTags, setTypedTags] = useState<{ galleryId: number; tags: TagLike[] } | null>(
    null
  )
  /** The openable group for this gallery's series, keyed by the name it is for. */
  const [seriesRef, setSeriesRef] = useState<{
    name: string
    ref: { id: number; name: string; totalCount: number }
  } | null>(null)

  useEffect(() => {
    if (!item) { setFreshItem(null); return }
    let cancelled = false

    window.api.library.getById(item.id).then((r) => {
      if (cancelled) return
      if (r.success && r.data) {
        setFreshItem(r.data as unknown as LibraryItemData)
      } else {
        setFreshItem(item) // fallback to prop if DB fetch fails
      }
    }).catch(() => {
      if (!cancelled) setFreshItem(item)
    })

    return () => { cancelled = true }
  }, [item?.id, refreshKey])

  // Populate edit fields from fresh data
  useEffect(() => {
    const src = freshItem
    if (src) {
      setEditTitle(src.customTitle || '')
      setEditSeries(src.seriesName || '')
      setEditVolume(src.seriesIndex != null ? String(src.seriesIndex) : '')
      setEditTags(src.customTags ? src.customTags.split(',').map(t => t.trim()).filter(Boolean) : [])
      setEditLanguage(src.customLanguage || '')
      setEditPublisher(src.publisher || '')
      setEditDescription(src.description || '')
      setEditing(false)
      setDeleteConfirm('none')
      setTagInput('')
      // Fetch thumbnail
      setThumbDataUrl(null)
      if (src.customCoverPath) {
        window.api.library.getThumbnail(src.id).then((r) => {
          if (r.success && r.data) setThumbDataUrl(r.data)
        }).catch(() => {})
      }
    }
  }, [freshItem])

  // ─── Tag autocomplete ─────────────────────────────────────────────────────

  const fetchTagSuggestions = useCallback(async (query: string) => {
    if (!query.trim()) { setTagSuggestions([]); setShowTagSuggestions(false); return }
    try {
      const result = await window.api.library.autocompleteTags(query)
      if (result.success && Array.isArray(result.data)) {
        const names = (result.data as string[]).slice(0, 8)
        setTagSuggestions(names)
        setShowTagSuggestions(names.length > 0)
      }
    } catch { setTagSuggestions([]) }
  }, [])

  const addTag = (tag: string) => {
    const t = tag.trim()
    if (!t || editTags.includes(t)) return
    setEditTags([...editTags, t])
    setTagInput('')
    setShowTagSuggestions(false)
  }

  const removeTag = (tag: string) => { setEditTags(editTags.filter(t => t !== tag)) }

  const handleTagKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); addTag(tagInput) }
    if (e.key === 'Backspace' && !tagInput && editTags.length > 0) removeTag(editTags[editTags.length - 1])
  }

  // ─── Actions ──────────────────────────────────────────────────────────────

  const handleOpenFile = async () => { try { await window.api.shell.openPath(detail.filePath) } catch { /* */ } }
  const handleOpenFolder = async () => {
    try {
      // Use parent directory path with openPath — shell.showItemInFolder is unreliable on Linux
      const dirPath = detail.filePath.replace(/[/\\][^/\\]+$/, '') || detail.filePath
      await window.api.shell.openPath(dirPath)
    } catch { /* */ }
  }

  /**
   * Convert this single file to CBZ.
   *
   * `begin(1)` primes the shared progress store so the bar on the library page
   * appears immediately, rather than only once the first progress event lands —
   * extraction of a large PDF can take a while before anything is reported.
   */
  const handleConvertToCbz = async (keepOriginal: boolean): Promise<void> => {
    if (!detail) return
    setConverting(true)
    useCbzConversionStore.getState().begin(1)
    try {
      const r = await window.api.library.convertToCbz([detail.id], false, { keepOriginal })
      if (!r?.success) {
        setConvertError(r?.error || 'Conversion failed')
      } else if (r.data && r.data.failed > 0) {
        setConvertError(r.data.errors?.[0] || 'Conversion failed')
      } else if (r.data?.forcedKeeps > 0) {
        // Not an error, but the user asked for a deletion that did not happen.
        setConvertError(
          'Converted, but the original PDF was kept: this file needed the fallback converter, ' +
          'so the PDF is the better copy. It is in _originals/_lossy/.'
        )
        onUpdated()
      } else {
        onUpdated()
      }
    } catch (e) {
      setConvertError(String(e))
    } finally {
      useCbzConversionStore.getState().finish()
      setConverting(false)
      setRefreshKey((k) => k + 1)
    }
  }

  const handleSaveMetadata = async () => {
    setSaving(true)
    try {
      const result = await window.api.library.updateMetadata(detail.id, {
        customTitle: editTitle,
        customTags: editTags.join(', '),
        customLanguage: editLanguage,
        seriesName: editSeries,
        seriesIndex: editVolume.trim() ? parseFloat(editVolume.trim()) : null,
        publisher: editPublisher.trim() || null,
        description: editDescription.trim() || null
      }, libraryRoot)
      if (result.success) {
        setEditing(false)
        setRefreshKey(k => k + 1)
        onUpdated()
      }
    } catch { /* */ }
    finally { setSaving(false) }
  }

  const handleDelete = async (mode: 'remove' | 'deleteFile') => {
    setDeleting(true)
    try {
      if (mode === 'deleteFile') {
        await window.api.library.deleteFile(detail.id)
      } else {
        await window.api.library.delete(detail.id)
      }
      onDeleted()
      onClose()
    } catch { /* */ }
    finally { setDeleting(false) }
  }

  /*
   * Typed tags for the Genre and Parody rows.
   *
   * Must sit above the `if (!item)` return below — a hook after an early return
   * is called conditionally, which breaks React's hook ordering.
   *
   * Keyed by galleryId, and state is only ever set from the promise callback.
   * Clearing it synchronously when there is no gallery would set state during
   * the effect and cascade a render; keying it instead means a previous item's
   * tags can never render against the current one.
   */
  useEffect(() => {
    const galleryId = (freshItem || item)?.galleryId
    if (!galleryId) return
    let cancelled = false
    window.api.library
      .getGalleryTags(galleryId)
      .then((r) => {
        if (!cancelled && r.success && Array.isArray(r.data)) {
          setTypedTags({ galleryId, tags: r.data as TagLike[] })
        }
      })
      .catch(() => {
        /* genre and parody are additive; absence is the normal case */
      })
    return () => { cancelled = true }
  }, [freshItem, item])

  /*
   * Whether this gallery's series is one that can be opened.
   *
   * Asked of main rather than assumed from `seriesName` being set, because the
   * name alone does not mean there is a group: grouping may be off, and 2,337
   * items default their series to their own title, which names only themselves.
   * A link that opened a series of one would be worse than plain text.
   *
   * Keyed by name for the same reason the tags above are keyed by galleryId —
   * so a previous item's series can never be attributed to the current one.
   */
  useEffect(() => {
    const name = (freshItem || item)?.seriesName
    if (!name) return
    let cancelled = false
    window.api.library
      .findSeries(name)
      .then((r) => {
        if (!cancelled && r?.success && r.data) {
          setSeriesRef({ name, ref: r.data as { id: number; name: string; totalCount: number } })
        }
      })
      .catch(() => {
        /* the field stays plain text, which is the pre-grouping behaviour */
      })
    return () => {
      cancelled = true
    }
  }, [freshItem, item])

  if (!item) return null

  // Use freshly fetched data when available, fall back to prop
  const detail = freshItem || item

  const activeTags =
    typedTags && typedTags.galleryId === detail.galleryId ? typedTags.tags : []
  const genreTags = sortTags(activeTags.filter((tg) => tg.type === 'category')).map((tg) => tg.name)
  const parodyTags = sortTags(activeTags.filter((tg) => tg.type === 'parody')).map((tg) => tg.name)

  // Choose viewer by format
  const isCbz = detail.format === 'cbz'

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
        {/* Viewer — sits to the left of the detail panel */}
        {showPdfViewer && !isCbz && (
          <PdfViewer
            filePath={detail.filePath}
            title={detail.customTitle || 'Untitled'}
            onClose={() => setShowPdfViewer(false)}
          />
        )}
        {showPdfViewer && isCbz && (
          <CbzViewer
            filePath={detail.filePath}
            title={detail.customTitle || 'Untitled'}
            onClose={() => setShowPdfViewer(false)}
          />
        )}

        {showConvertDialog && (
          <ConvertToCbzDialog
            count={1}
            onCancel={() => setShowConvertDialog(false)}
            onConfirm={(keepOriginal) => {
              setShowConvertDialog(false)
              void handleConvertToCbz(keepOriginal)
            }}
          />
        )}

        <div className="relative w-full max-w-md bg-surface shadow-2xl overflow-y-auto" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="sticky top-0 bg-surface border-b border-line px-6 py-4 flex items-center justify-between z-10">
          <h2 className="text-section font-semibold text-fg truncate">{detail.customTitle || 'Item Detail'}</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-raised text-fg-faint hover:text-fg">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-6 py-4 space-y-6">
          {thumbDataUrl ? (
            <button
              onClick={() => setShowPdfViewer(true)}
              className="aspect-[3/4] w-full rounded-lg overflow-hidden bg-raised group relative"
            >
              <img src={thumbDataUrl} alt={detail.customTitle || 'Cover'} draggable={false} className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                <span className="text-white font-medium opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1"><BookOpen size={14} aria-hidden="true" /> Read</span>
              </div>
            </button>
          ) : (
            <button
              onClick={() => setShowPdfViewer(true)}
              className="aspect-[3/4] w-full rounded-lg overflow-hidden bg-raised group relative"
            >
              <div className="w-full h-full flex items-center justify-center text-fg-faint">
                <BookOpen size={36} strokeWidth={1.5} aria-hidden="true" />
              </div>
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                <span className="text-white font-medium opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1"><BookOpen size={14} aria-hidden="true" /> Read</span>
              </div>
            </button>
          )}

          <div className="space-y-3">
            {/* Title */}
            {editing ? (
              <div><label className="block text-xs font-medium text-fg-muted mb-1">Title</label>
                <input type="text" value={editTitle} onChange={e => setEditTitle(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm text-fg focus:ring-2 focus:ring-accent" />
              </div>
            ) : (
              <div><span className="text-xs font-medium text-fg-muted">Title</span><p className="text-sm text-fg">{detail.customTitle || 'Untitled'}</p></div>
            )}

            {/* Series with autocomplete */}
            {editing ? (
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-fg-muted mb-1">Series</label>
                  <AutocompleteInput kind="series" value={editSeries} onChange={setEditSeries} placeholder="Search series..." />
                </div>
                <div>
                  <label className="block text-xs font-medium text-fg-muted mb-1">Volume</label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={editVolume}
                    onChange={(e) => setEditVolume(e.target.value)}
                    placeholder="1"
                    className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm text-fg focus:ring-2 focus:ring-accent"
                  />
                </div>
              </div>
            ) : detail.seriesName ? (
              <div>
                <span className="text-xs font-medium text-fg-muted">Series</span>
                {/*
                  A link only when the name resolves to a group that exists and
                  holds more than this one gallery. Otherwise it stays the plain
                  text it has always been.
                */}
                {onOpenSeries && seriesRef && seriesRef.name === detail.seriesName ? (
                  <p className="text-sm">
                    <button
                      onClick={() => onOpenSeries(seriesRef.ref)}
                      className="text-info hover:underline cursor-pointer"
                      title={`Open this series (${seriesRef.ref.totalCount} galleries)`}
                    >
                      {detail.seriesName}
                    </button>
                    {detail.seriesIndex != null && (
                      <span className="text-fg-faint ml-1">Vol. {detail.seriesIndex}</span>
                    )}
                  </p>
                ) : (
                  <p className="text-sm text-info">
                    {detail.seriesName}
                    {detail.seriesIndex != null && <span className="text-fg-faint ml-1">Vol. {detail.seriesIndex}</span>}
                  </p>
                )}
              </div>
            ) : null}

            <div><span className="text-xs font-medium text-fg-muted">Artist</span>
              {onFilterArtist ? (
                <button onClick={() => { onClose(); onFilterArtist(detail.primaryArtist) }} className="block text-sm text-accent hover:underline cursor-pointer">
                  {detail.primaryArtist || 'Unknown'}
                </button>
              ) : (
                <p className="text-sm text-fg">{detail.primaryArtist || 'Unknown'}</p>
              )}
            </div>

            {/* Group — `publisher` internally, which is what Kavita reads. */}
            {editing ? (
              <div><label className="block text-xs font-medium text-fg-muted mb-1">Group</label>
                <input type="text" value={editPublisher} onChange={e => setEditPublisher(e.target.value)} placeholder="Publisher/Group name..." className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm text-fg focus:ring-2 focus:ring-accent" />
              </div>
            ) : detail.publisher ? (
              <div><span className="text-xs font-medium text-fg-muted">Group</span>
                {onFilterPublisher ? (
                  <button onClick={() => { onClose(); onFilterPublisher(detail.publisher!) }} className="block text-sm text-accent hover:underline cursor-pointer">
                    {detail.publisher}
                  </button>
                ) : (
                  <p className="text-sm text-fg">{detail.publisher}</p>
                )}
              </div>
            ) : null}

            {/* Language with dropdown + free-text */}
            {editing ? (
              <div><label className="block text-xs font-medium text-fg-muted mb-1">Language</label>
                <div className="flex gap-2">
                  <select value={editLanguage} onChange={e => setEditLanguage(e.target.value)} className="flex-1 px-3 py-2 rounded-lg border border-line bg-surface text-sm">
                    <option value="">Select...</option>
                    {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                  <input type="text" value={editLanguage} onChange={e => setEditLanguage(e.target.value)} placeholder="Custom..." className="flex-1 px-3 py-2 rounded-lg border border-line bg-surface text-sm" />
                </div>
              </div>
            ) : detail.customLanguage ? (
              <div><span className="text-xs font-medium text-fg-muted">Language</span><p className="text-sm text-fg">{detail.customLanguage}</p></div>
            ) : null}


            {/*
              Genre and parody come from the typed tags on the cached gallery
              row, because `custom_tags` keeps only a comma-joined string with
              the types discarded. Downloaded items have them; scanned items do
              not until they are synced, so these rows simply do not render
              rather than showing empty labels.
            */}
            {!editing && genreTags.length > 0 && (
              <div>
                <span className="text-xs font-medium text-fg-muted">Genre</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {genreTags.map((name) => {
                    const blocked = blockedMatch('category', name)
                    return (
                      <span
                        key={name}
                        title={blockedChipTitle(blocked)}
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${tagClass('category')} ${blockedChipClass(blocked)}`}
                      >
                        {name}
                      </span>
                    )
                  })}
                </div>
              </div>
            )}

            {!editing && parodyTags.length > 0 && (
              <div>
                <span className="text-xs font-medium text-fg-muted">Parody</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {parodyTags.map((name) => {
                    const blocked = blockedMatch('parody', name)
                    return (
                      <span
                        key={name}
                        title={blockedChipTitle(blocked)}
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${tagClass('parody')} ${blockedChipClass(blocked)}`}
                      >
                        {name}
                      </span>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Tags with chip editor */}
            {editing ? (
              <div>
                <label className="block text-xs font-medium text-fg-muted mb-1">Tags</label>
                <div className="flex flex-wrap gap-1 p-2 rounded-lg border border-line bg-surface min-h-[42px]">
                  {editTags.map(tag => (
                    <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent-wash text-accent text-xs font-medium">
                      {tag}<button onClick={() => removeTag(tag)} className="hover:text-danger">×</button>
                    </span>
                  ))}
                  <div className="flex-1 min-w-[80px] relative">
                    <input
                      type="text" value={tagInput}
                      onChange={e => { setTagInput(e.target.value); fetchTagSuggestions(e.target.value) }}
                      onKeyDown={handleTagKeyDown}
                      onFocus={() => { if (tagInput) fetchTagSuggestions(tagInput) }}
                      placeholder={editTags.length === 0 ? 'Type tag and press Enter...' : ''}
                      className="w-full bg-transparent text-sm text-fg outline-none border-none"
                    />
                    {showTagSuggestions && tagSuggestions.length > 0 && (
                      <ul className="absolute z-50 top-full left-0 mt-1 w-full max-h-32 overflow-y-auto rounded-lg border border-line bg-surface shadow-lg">
                        {tagSuggestions.map(s => (
                          <li key={s} onClick={() => addTag(s)} className="px-3 py-1.5 text-sm cursor-pointer hover:bg-raised text-fg">{s}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            ) : detail.customTags ? (
              <div><span className="text-xs font-medium text-fg-muted">Tags</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {detail.customTags.split(',').map((tag) => {
                    const trimmed = tag.trim()
                    if (!trimmed) return null
                    /*
                      `custom_tags` is flat, with the types discarded, so a name
                      here could be any type. Both 'tag' and 'artist' are checked
                      so an artist blocked by name still shows struck through.
                    */
                    const blocked = blockedMatch('tag', trimmed) ?? blockedMatch('artist', trimmed)
                    const struck = blockedChipClass(blocked)
                    return onFilterTag ? (
                      <button
                        key={trimmed}
                        onClick={() => {
                          onClose()
                          onFilterTag(trimmed)
                        }}
                        title={blockedChipTitle(blocked)}
                        className={`px-2 py-0.5 rounded-full bg-accent-wash text-accent text-xs hover:bg-accent-wash cursor-pointer ${struck}`}
                      >
                        {trimmed}
                      </button>
                    ) : (
                      <span
                        key={trimmed}
                        title={blockedChipTitle(blocked)}
                        className={`px-2 py-0.5 rounded-full bg-raised text-xs text-fg-muted ${struck}`}
                      >
                        {trimmed}
                      </span>
                    )
                  })}
                </div>
              </div>
            ) : null}

            {/* Description */}
            {editing ? (
              <div><label className="block text-xs font-medium text-fg-muted mb-1">Summary</label>
                <textarea value={editDescription} onChange={e => setEditDescription(e.target.value)} placeholder="Description/summary..." rows={3} className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm text-fg focus:ring-2 focus:ring-accent resize-none" />
              </div>
            ) : detail.description ? (
              <div><span className="text-xs font-medium text-fg-muted">Summary</span><p className="text-sm text-fg whitespace-pre-wrap">{detail.description}</p></div>
            ) : null}

            {detail.customDate && (<div><span className="text-xs font-medium text-fg-muted">Date</span><p className="text-sm text-fg">{detail.customDate}</p></div>)}
            <div><span className="text-xs font-medium text-fg-muted">Added</span><p className="text-sm text-fg">{formatDate(detail.addedAt)}</p></div>

            <div className="border-t border-line pt-3 space-y-2">
              <div><span className="text-xs font-medium text-fg-muted">Format</span><p className="text-sm text-fg">{detail.format?.toUpperCase() || 'PDF'}</p></div>
              <div><span className="text-xs font-medium text-fg-muted">File Size</span><p className="text-sm text-fg">{formatFileSize(detail.fileSize)}</p></div>
              <div><span className="text-xs font-medium text-fg-muted">File Path</span><p className="text-xs text-fg-muted break-all font-mono mt-0.5">{detail.filePath}</p></div>
              {detail.galleryId && (
                <div>
                  <span className="text-xs font-medium text-fg-muted">nhentai ID</span>
                  <div className="flex items-center gap-2">
                    {onOpenInSearch ? (
                      <button onClick={() => { onClose(); onOpenInSearch(detail.galleryId!) }} className="text-sm text-accent hover:underline cursor-pointer">
                        #{detail.galleryId}
                      </button>
                    ) : (
                      <p className="text-sm text-accent">#{detail.galleryId}</p>
                    )}
                    <button
                      onClick={async () => {
                        setDetailSyncing(true)
                        try {
                          await window.api.library.syncItem(detail.id)
                          setRefreshKey(k => k + 1)
                          onUpdated()
                        } catch { /* */ }
                        setDetailSyncing(false)
                      }}
                      disabled={detailSyncing}
                      className="px-2 py-0.5 rounded text-xs border border-success text-success hover:bg-success-wash disabled:opacity-40"
                    >
                      {detailSyncing ? '⟳ Syncing...' : '⟳ Sync'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-surface border-t border-line px-6 py-4 space-y-3">
          {editing ? (
            <div className="flex gap-2">
              <button onClick={handleSaveMetadata} disabled={saving} className="flex-1 px-4 py-2 rounded-lg bg-accent-fill text-white text-sm font-medium hover:bg-accent-hover disabled:opacity-50">{saving ? 'Saving...' : 'Save Changes'}</button>
              <button onClick={() => setEditing(false)} className="px-4 py-2 rounded-lg bg-raised text-sm font-medium text-fg hover:bg-raised">Cancel</button>
            </div>
          ) : (
            <>
              {/* Conversion in progress — say so plainly, since the actions
                  below are disabled and that would otherwise look broken. */}
              {isConverting && (
                <div className="flex items-center gap-2 p-2.5 rounded-lg bg-accent-wash border border-accent text-xs text-accent">
                  <div className="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin shrink-0" />
                  <span>Converting to CBZ. Editing and deleting are unavailable until this finishes.</span>
                </div>
              )}

              <div className="flex gap-2">
                <button onClick={handleOpenFile} className="inline-flex items-center justify-center gap-1.5 flex-1 px-4 py-2 rounded-lg bg-accent-fill text-white text-sm font-medium hover:bg-accent-hover"><BookOpen size={14} aria-hidden="true" /> Open File</button>
                <button onClick={handleOpenFolder} className="inline-flex items-center justify-center gap-1.5 flex-1 px-4 py-2 rounded-lg bg-raised text-sm font-medium text-fg hover:bg-raised"><FolderOpen size={14} aria-hidden="true" /> Open Folder</button>
              </div>

              {convertError && (
                <div className="flex items-start justify-between gap-2 p-2.5 rounded-lg bg-danger-wash border border-danger text-xs text-danger">
                  <span className="inline-flex items-center gap-1">
                    <AlertTriangle size={12} aria-hidden="true" /> {convertError}
                  </span>
                  <button onClick={() => setConvertError(null)} className="shrink-0 hover:text-danger"><X size={12} aria-hidden="true" /></button>
                </div>
              )}

              {/* Convert to CBZ — only for PDFs; a CBZ has nowhere to go. */}
              {(detail.format || 'pdf') === 'pdf' && (
                <button
                  onClick={() => setShowConvertDialog(true)}
                  disabled={isConverting || converting}
                  className="inline-flex items-center gap-1.5 w-full px-4 py-2 rounded-lg bg-accent-fill text-white text-sm font-medium hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isConverting || converting ? (
                    <>
                      <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Converting to CBZ…
                    </>
                  ) : (
                    <>
                      <FileArchive size={14} aria-hidden="true" /> Convert to CBZ
                    </>
                  )}
                </button>
              )}

              <button
                onClick={() => setEditing(true)}
                disabled={isConverting}
                title={isConverting ? 'Unavailable while this file is being converted' : undefined}
                className="inline-flex items-center gap-1.5 w-full px-4 py-2 rounded-lg bg-info-wash text-info text-sm font-medium hover:bg-info-wash disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Pencil size={14} aria-hidden="true" /> Edit Metadata
              </button>

              {/* Two delete actions */}
              <div>
                {deleteConfirm === 'remove' ? (
                  <div className="space-y-2">
                    <p className="text-xs text-warning">This will only remove the database entry. The file on disk will be kept.</p>
                    <div className="flex gap-2">
                      <button onClick={() => handleDelete('remove')} disabled={deleting} className="flex-1 px-4 py-2 rounded-lg bg-warning-fill text-white text-sm font-medium hover:bg-warning-fill disabled:opacity-50">{deleting ? 'Removing...' : 'Confirm Remove'}</button>
                      <button onClick={() => setDeleteConfirm('none')} className="px-4 py-2 rounded-lg bg-raised text-sm font-medium">Cancel</button>
                    </div>
                  </div>
                ) : deleteConfirm === 'deleteFile' ? (
                  <div className="space-y-2">
                    <p className="text-xs text-danger">This will delete the database entry AND the file from disk. This cannot be undone.</p>
                    <div className="flex gap-2">
                      <button onClick={() => handleDelete('deleteFile')} disabled={deleting} className="flex-1 px-4 py-2 rounded-lg bg-danger-fill text-white text-sm font-medium hover:bg-danger-fill disabled:opacity-50">{deleting ? 'Deleting...' : 'Confirm Delete'}</button>
                      <button onClick={() => setDeleteConfirm('none')} className="px-4 py-2 rounded-lg bg-raised text-sm font-medium">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button onClick={() => setDeleteConfirm('remove')} disabled={isConverting} title={isConverting ? 'Unavailable while this file is being converted' : undefined} className="inline-flex items-center justify-center gap-1.5 flex-1 px-4 py-2 rounded-lg bg-warning-wash text-warning text-sm font-medium hover:bg-warning-wash disabled:opacity-40 disabled:cursor-not-allowed"><ListX size={14} aria-hidden="true" /> Remove from Library</button>
                    <button onClick={() => setDeleteConfirm('deleteFile')} disabled={isConverting} title={isConverting ? 'Unavailable while this file is being converted' : undefined} className="inline-flex items-center justify-center gap-1.5 flex-1 px-4 py-2 rounded-lg bg-danger-wash text-danger text-sm font-medium hover:bg-danger-wash disabled:opacity-40 disabled:cursor-not-allowed"><Trash2 size={14} aria-hidden="true" /> Delete File</button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
