import { useState, useEffect } from 'react'
import type { LibraryItemData } from './LibraryCard'

// ─── Types ───────────────────────────────────────────────────────────────────

interface LibraryDetailProps {
  item: LibraryItemData | null
  onClose: () => void
  onDeleted: () => void
  onUpdated: () => void
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatFileSize(bytes: number | null): string {
  if (!bytes) return 'Unknown'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function LibraryDetail({
  item,
  onClose,
  onDeleted,
  onUpdated
}: LibraryDetailProps): React.JSX.Element | null {
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editSeries, setEditSeries] = useState('')
  const [editTags, setEditTags] = useState('')
  const [editLanguage, setEditLanguage] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (item) {
      setEditTitle(item.customTitle || '')
      setEditSeries(item.seriesName || '')
      setEditTags(item.customTags || '')
      setEditLanguage(item.customLanguage || '')
      setEditing(false)
      setDeleteConfirm(false)
    }
  }, [item])

  if (!item) return null

  // ─── Actions ──────────────────────────────────────────────────────────────

  const handleOpenFile = async () => {
    try {
      await window.api.shell.openPath(item.filePath)
    } catch {
      // ignore
    }
  }

  const handleOpenFolder = async () => {
    try {
      await window.api.shell.showItemInFolder(item.filePath)
    } catch {
      // ignore
    }
  }

  const handleSaveMetadata = async () => {
    setSaving(true)
    try {
      await window.api.library.updateMetadata(item.id, {
        customTitle: editTitle,
        customTags: editTags,
        customLanguage: editLanguage,
        seriesName: editSeries
      })
      setEditing(false)
      onUpdated()
    } catch {
      // ignore
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await window.api.library.delete(item.id)
      onDeleted()
      onClose()
    } catch {
      // ignore
    } finally {
      setDeleting(false)
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/30" />

      {/* Panel */}
      <div
        className="relative w-full max-w-md bg-white dark:bg-gray-900 shadow-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-6 py-4 flex items-center justify-between z-10">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">
            {item.customTitle || 'Item Detail'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-4 space-y-6">
          {/* Cover */}
          {item.customCoverPath && (
            <div className="aspect-[3/4] max-w-[200px] mx-auto rounded-lg overflow-hidden bg-gray-200 dark:bg-gray-700">
              <img
                src={`file://${item.customCoverPath}`}
                alt={item.customTitle || 'Cover'}
                className="w-full h-full object-cover"
              />
            </div>
          )}

          {/* Metadata */}
          <div className="space-y-3">
            {/* Title */}
            {editing ? (
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Title</label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-purple-500"
                />
              </div>
            ) : (
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Title</span>
                <p className="text-sm text-gray-900 dark:text-gray-100">{item.customTitle || 'Untitled'}</p>
              </div>
            )}

            {/* Artist */}
            <div>
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Artist</span>
              <p className="text-sm text-gray-900 dark:text-gray-100">{item.primaryArtist || 'Unknown'}</p>
            </div>

            {/* Series */}
            {editing ? (
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Series</label>
                <input
                  type="text"
                  value={editSeries}
                  onChange={(e) => setEditSeries(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-purple-500"
                />
              </div>
            ) : item.seriesName ? (
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Series</span>
                <p className="text-sm text-blue-600 dark:text-blue-400">{item.seriesName}</p>
              </div>
            ) : null}

            {/* Language */}
            {editing ? (
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Language</label>
                <input
                  type="text"
                  value={editLanguage}
                  onChange={(e) => setEditLanguage(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-purple-500"
                />
              </div>
            ) : item.customLanguage ? (
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Language</span>
                <p className="text-sm text-gray-900 dark:text-gray-100">{item.customLanguage}</p>
              </div>
            ) : null}

            {/* Tags */}
            {editing ? (
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Tags</label>
                <input
                  type="text"
                  value={editTags}
                  onChange={(e) => setEditTags(e.target.value)}
                  placeholder="Comma-separated tags..."
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-purple-500"
                />
              </div>
            ) : item.customTags ? (
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Tags</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {item.customTags.split(',').map((tag) => (
                    <span
                      key={tag.trim()}
                      className="px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-xs text-gray-600 dark:text-gray-400"
                    >
                      {tag.trim()}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Date */}
            {item.customDate && (
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Date</span>
                <p className="text-sm text-gray-900 dark:text-gray-100">{item.customDate}</p>
              </div>
            )}

            {/* Added date */}
            <div>
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Added</span>
              <p className="text-sm text-gray-900 dark:text-gray-100">{formatDate(item.addedAt)}</p>
            </div>

            {/* File info */}
            <div className="border-t border-gray-200 dark:border-gray-700 pt-3 space-y-2">
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Format</span>
                <p className="text-sm text-gray-900 dark:text-gray-100">{item.format?.toUpperCase() || 'PDF'}</p>
              </div>
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">File Size</span>
                <p className="text-sm text-gray-900 dark:text-gray-100">{formatFileSize(item.fileSize)}</p>
              </div>
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">File Path</span>
                <p className="text-xs text-gray-500 dark:text-gray-400 break-all font-mono mt-0.5">
                  {item.filePath}
                </p>
              </div>
              {item.galleryId && (
                <div>
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400">nhentai ID</span>
                  <p className="text-sm text-purple-600 dark:text-purple-400">#{item.galleryId}</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="sticky bottom-0 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 px-6 py-4 space-y-3">
          {editing ? (
            <>
              <div className="flex gap-2">
                <button
                  onClick={handleSaveMetadata}
                  disabled={saving}
                  className="flex-1 px-4 py-2 rounded-lg bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 transition-colors disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex gap-2">
                <button
                  onClick={handleOpenFile}
                  className="flex-1 px-4 py-2 rounded-lg bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 transition-colors"
                >
                  📖 Open File
                </button>
                <button
                  onClick={handleOpenFolder}
                  className="flex-1 px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                >
                  📂 Open Folder
                </button>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => setEditing(true)}
                  className="flex-1 px-4 py-2 rounded-lg bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 text-sm font-medium hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors"
                >
                  ✏️ Edit Metadata
                </button>
              </div>

              {/* Delete */}
              <div>
                {deleteConfirm ? (
                  <div className="flex gap-2">
                    <button
                      onClick={handleDelete}
                      disabled={deleting}
                      className="flex-1 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50"
                    >
                      {deleting ? 'Deleting...' : 'Confirm Delete'}
                    </button>
                    <button
                      onClick={() => setDeleteConfirm(false)}
                      className="px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setDeleteConfirm(true)}
                    className="w-full px-4 py-2 rounded-lg bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400 text-sm font-medium hover:bg-red-200 dark:hover:bg-red-900/40 transition-colors"
                  >
                    🗑️ Delete
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
