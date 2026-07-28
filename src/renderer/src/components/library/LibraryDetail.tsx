import { useState, useEffect, useCallback } from 'react'
import AutocompleteInput from '../shared/AutocompleteInput'
import PdfViewer from './PdfViewer'
import type { LibraryItemData } from './LibraryCard'

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
  onFilterArtist, onFilterPublisher, onFilterTag, onOpenInSearch
}: LibraryDetailProps): React.JSX.Element | null {
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editSeries, setEditSeries] = useState('')
  const [editVolume, setEditVolume] = useState('')
  const [editTags, setEditTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [editLanguage, setEditLanguage] = useState('')
  const [editPublisher, setEditPublisher] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<'none' | 'remove' | 'deleteFile'>('none')
  const [deleting, setDeleting] = useState(false)
  const [detailSyncing, setDetailSyncing] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [thumbDataUrl, setThumbDataUrl] = useState<string | null>(null)
  const [showPdfViewer, setShowPdfViewer] = useState(false)

  // Autocomplete suggestions for tags
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([])
  const [showTagSuggestions, setShowTagSuggestions] = useState(false)

  // Re-fetch fresh data from DB whenever the selected item changes.
  // This ensures series, tags, thumbnail etc. are up-to-date after a scan
  // completes, rather than showing the stale snapshot from the grid.
  const [freshItem, setFreshItem] = useState<LibraryItemData | null>(null)

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

  if (!item) return null

  // Use freshly fetched data when available, fall back to prop
  const detail = freshItem || item

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />

      {/* PDF Viewer — sits to the left of the detail panel */}
      {showPdfViewer && (
        <PdfViewer
          filePath={detail.filePath}
          title={detail.customTitle || 'Untitled'}
          onClose={() => setShowPdfViewer(false)}
        />
      )}

      <div className="relative w-full max-w-md bg-white dark:bg-gray-900 shadow-2xl overflow-y-auto" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="sticky top-0 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-6 py-4 flex items-center justify-between z-10">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">{detail.customTitle || 'Item Detail'}</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-6 py-4 space-y-6">
          {thumbDataUrl ? (
            <button
              onClick={() => setShowPdfViewer(true)}
              className="aspect-[3/4] max-w-[200px] mx-auto rounded-lg overflow-hidden bg-gray-200 dark:bg-gray-700 group relative block w-full"
            >
              <img src={thumbDataUrl} alt={detail.customTitle || 'Cover'} draggable={false} className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                <span className="text-white font-medium opacity-0 group-hover:opacity-100 transition-opacity">📖 Read</span>
              </div>
            </button>
          ) : (
            <button
              onClick={() => setShowPdfViewer(true)}
              className="aspect-[3/4] max-w-[200px] mx-auto rounded-lg overflow-hidden bg-gray-200 dark:bg-gray-700 group relative block w-full"
            >
              <div className="w-full h-full flex items-center justify-center text-gray-400">
                <span className="text-4xl">📖</span>
              </div>
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                <span className="text-white font-medium opacity-0 group-hover:opacity-100 transition-opacity">📖 Read</span>
              </div>
            </button>
          )}

          <div className="space-y-3">
            {/* Title */}
            {editing ? (
              <div><label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Title</label>
                <input type="text" value={editTitle} onChange={e => setEditTitle(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-purple-500" />
              </div>
            ) : (
              <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Title</span><p className="text-sm text-gray-900 dark:text-gray-100">{detail.customTitle || 'Untitled'}</p></div>
            )}

            <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Artist</span>
              {onFilterArtist ? (
                <button onClick={() => { onClose(); onFilterArtist(detail.primaryArtist) }} className="block text-sm text-purple-600 dark:text-purple-400 hover:underline cursor-pointer">
                  {detail.primaryArtist || 'Unknown'}
                </button>
              ) : (
                <p className="text-sm text-gray-900 dark:text-gray-100">{detail.primaryArtist || 'Unknown'}</p>
              )}
            </div>

            {/* Series with autocomplete */}
            {editing ? (
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Series</label>
                  <AutocompleteInput kind="series" value={editSeries} onChange={setEditSeries} placeholder="Search series..." />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Volume</label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={editVolume}
                    onChange={(e) => setEditVolume(e.target.value)}
                    placeholder="1"
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-purple-500"
                  />
                </div>
              </div>
            ) : detail.seriesName ? (
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Series</span>
                <p className="text-sm text-blue-600 dark:text-blue-400">
                  {detail.seriesName}
                  {detail.seriesIndex != null && <span className="text-gray-400 ml-1">Vol. {detail.seriesIndex}</span>}
                </p>
              </div>
            ) : null}

            {/* Language with dropdown + free-text */}
            {editing ? (
              <div><label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Language</label>
                <div className="flex gap-2">
                  <select value={editLanguage} onChange={e => setEditLanguage(e.target.value)} className="flex-1 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm">
                    <option value="">Select...</option>
                    {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                  <input type="text" value={editLanguage} onChange={e => setEditLanguage(e.target.value)} placeholder="Custom..." className="flex-1 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm" />
                </div>
              </div>
            ) : detail.customLanguage ? (
              <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Language</span><p className="text-sm text-gray-900 dark:text-gray-100">{detail.customLanguage}</p></div>
            ) : null}

            {/* Publisher */}
            {editing ? (
              <div><label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Publisher</label>
                <input type="text" value={editPublisher} onChange={e => setEditPublisher(e.target.value)} placeholder="Publisher/Group name..." className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-purple-500" />
              </div>
            ) : detail.publisher ? (
              <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Publisher</span>
                {onFilterPublisher ? (
                  <button onClick={() => { onClose(); onFilterPublisher(detail.publisher!) }} className="block text-sm text-purple-600 dark:text-purple-400 hover:underline cursor-pointer">
                    {detail.publisher}
                  </button>
                ) : (
                  <p className="text-sm text-gray-900 dark:text-gray-100">{detail.publisher}</p>
                )}
              </div>
            ) : null}

            {/* Description */}
            {editing ? (
              <div><label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Summary</label>
                <textarea value={editDescription} onChange={e => setEditDescription(e.target.value)} placeholder="Description/summary..." rows={3} className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-purple-500 resize-none" />
              </div>
            ) : detail.description ? (
              <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Summary</span><p className="text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap">{detail.description}</p></div>
            ) : null}

            {/* Tags with chip editor */}
            {editing ? (
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Tags</label>
                <div className="flex flex-wrap gap-1 p-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 min-h-[42px]">
                  {editTags.map(tag => (
                    <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 text-xs font-medium">
                      {tag}<button onClick={() => removeTag(tag)} className="hover:text-red-500">×</button>
                    </span>
                  ))}
                  <div className="flex-1 min-w-[80px] relative">
                    <input
                      type="text" value={tagInput}
                      onChange={e => { setTagInput(e.target.value); fetchTagSuggestions(e.target.value) }}
                      onKeyDown={handleTagKeyDown}
                      onFocus={() => { if (tagInput) fetchTagSuggestions(tagInput) }}
                      placeholder={editTags.length === 0 ? 'Type tag and press Enter...' : ''}
                      className="w-full bg-transparent text-sm text-gray-900 dark:text-gray-100 outline-none border-none"
                    />
                    {showTagSuggestions && tagSuggestions.length > 0 && (
                      <ul className="absolute z-50 top-full left-0 mt-1 w-full max-h-32 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg">
                        {tagSuggestions.map(s => (
                          <li key={s} onClick={() => addTag(s)} className="px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">{s}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            ) : detail.customTags ? (
              <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Tags</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {detail.customTags.split(',').map(tag => {
                    const trimmed = tag.trim()
                    if (!trimmed) return null
                    return onFilterTag ? (
                      <button key={trimmed} onClick={() => { onClose(); onFilterTag(trimmed) }} className="px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 text-xs hover:bg-purple-200 dark:hover:bg-purple-900/50 cursor-pointer">
                        {trimmed}
                      </button>
                    ) : (
                      <span key={trimmed} className="px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-xs text-gray-600 dark:text-gray-400">{trimmed}</span>
                    )
                  })}
                </div>
              </div>
            ) : null}

            {detail.customDate && (<div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Date</span><p className="text-sm text-gray-900 dark:text-gray-100">{detail.customDate}</p></div>)}
            <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Added</span><p className="text-sm text-gray-900 dark:text-gray-100">{formatDate(detail.addedAt)}</p></div>

            <div className="border-t border-gray-200 dark:border-gray-700 pt-3 space-y-2">
              <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Format</span><p className="text-sm text-gray-900 dark:text-gray-100">{detail.format?.toUpperCase() || 'PDF'}</p></div>
              <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">File Size</span><p className="text-sm text-gray-900 dark:text-gray-100">{formatFileSize(detail.fileSize)}</p></div>
              <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">File Path</span><p className="text-xs text-gray-500 dark:text-gray-400 break-all font-mono mt-0.5">{detail.filePath}</p></div>
              {detail.galleryId && (
                <div>
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400">nhentai ID</span>
                  <div className="flex items-center gap-2">
                    {onOpenInSearch ? (
                      <button onClick={() => { onClose(); onOpenInSearch(detail.galleryId!) }} className="text-sm text-purple-600 dark:text-purple-400 hover:underline cursor-pointer">
                        #{detail.galleryId}
                      </button>
                    ) : (
                      <p className="text-sm text-purple-600 dark:text-purple-400">#{detail.galleryId}</p>
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
                      className="px-2 py-0.5 rounded text-xs border border-green-300 dark:border-green-700 text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 disabled:opacity-40"
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
        <div className="sticky bottom-0 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 px-6 py-4 space-y-3">
          {editing ? (
            <div className="flex gap-2">
              <button onClick={handleSaveMetadata} disabled={saving} className="flex-1 px-4 py-2 rounded-lg bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 disabled:opacity-50">{saving ? 'Saving...' : 'Save Changes'}</button>
              <button onClick={() => setEditing(false)} className="px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700">Cancel</button>
            </div>
          ) : (
            <>
              <div className="flex gap-2">
                <button onClick={handleOpenFile} className="flex-1 px-4 py-2 rounded-lg bg-purple-600 text-white text-sm font-medium hover:bg-purple-700">📖 Open File</button>
                <button onClick={handleOpenFolder} className="flex-1 px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700">📂 Open Folder</button>
              </div>
              <button onClick={() => setEditing(true)} className="w-full px-4 py-2 rounded-lg bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 text-sm font-medium hover:bg-blue-200 dark:hover:bg-blue-900/50">✏️ Edit Metadata</button>

              {/* Two delete actions */}
              <div>
                {deleteConfirm === 'remove' ? (
                  <div className="space-y-2">
                    <p className="text-xs text-orange-600 dark:text-orange-400">This will only remove the database entry. The file on disk will be kept.</p>
                    <div className="flex gap-2">
                      <button onClick={() => handleDelete('remove')} disabled={deleting} className="flex-1 px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:bg-orange-700 disabled:opacity-50">{deleting ? 'Removing...' : 'Confirm Remove'}</button>
                      <button onClick={() => setDeleteConfirm('none')} className="px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-sm font-medium">Cancel</button>
                    </div>
                  </div>
                ) : deleteConfirm === 'deleteFile' ? (
                  <div className="space-y-2">
                    <p className="text-xs text-red-600 dark:text-red-400">⚠️ This will delete the database entry AND the file from disk. This cannot be undone.</p>
                    <div className="flex gap-2">
                      <button onClick={() => handleDelete('deleteFile')} disabled={deleting} className="flex-1 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50">{deleting ? 'Deleting...' : 'Confirm Delete'}</button>
                      <button onClick={() => setDeleteConfirm('none')} className="px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-sm font-medium">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button onClick={() => setDeleteConfirm('remove')} className="flex-1 px-4 py-2 rounded-lg bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400 text-sm font-medium hover:bg-orange-200">📋 Remove from Library</button>
                    <button onClick={() => setDeleteConfirm('deleteFile')} className="flex-1 px-4 py-2 rounded-lg bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400 text-sm font-medium hover:bg-red-200">🗑️ Delete File</button>
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
