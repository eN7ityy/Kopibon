import { useState, useEffect, useRef } from 'react'
import { useIsConverting } from '../../stores/cbz-conversion.store'

// ─── Types matching library_item DB schema ──────────────────────────────────

export interface LibraryItemData {
  id: number
  galleryId: number | null
  isCustom: number
  customTitle: string | null
  customTags: string | null
  customLanguage: string | null
  customDate: string | null
  customCoverPath: string | null
  filePath: string
  fileSize: number | null
  format: string
  primaryArtist: string
  seriesName: string | null
  seriesIndex: number | null
  language: string | null
  publisher: string | null
  description: string | null
  readProgress: number
  addedAt: number
  updatedAt: number
}

interface LibraryCardProps {
  item: LibraryItemData
  selected: boolean
  onToggleSelect: (id: number) => void
  onClick: (id: number) => void
  onContextMenu?: (id: number, event: React.MouseEvent) => void
  compact?: boolean
}

interface ContextMenuState {
  visible: boolean
  x: number
  y: number
}

export default function LibraryCard({
  item,
  selected,
  onToggleSelect,
  onClick,
  onContextMenu,
  compact = false
}: LibraryCardProps): React.JSX.Element {
  // Read from the store rather than taking a prop: the grid and the list view
  // render cards from different call sites, and threading this through both
  // would leave one of them silently missing the indicator.
  const converting = useIsConverting(item.id)
  const [imgError, setImgError] = useState(false)
  const [thumbDataUrl, setThumbDataUrl] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0 })
  const menuRef = useRef<HTMLDivElement>(null)

  const title = item.customTitle || item.primaryArtist || `Item #${item.id}`
  const artist = item.primaryArtist || 'Unknown'

  // Fetch thumbnail via IPC (always attempt, DB handler checks if exists)
  useEffect(() => {
    let cancelled = false
    window.api.library.getThumbnail(item.id).then((result) => {
      if (!cancelled && result.success && result.data) {
        setThumbDataUrl(result.data)
      }
    }).catch(() => setImgError(true))
    return () => { cancelled = true }
  }, [item.id])

  const coverSrc = thumbDataUrl && !imgError ? thumbDataUrl : null

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu.visible) return
    const handler = () => setContextMenu({ visible: false, x: 0, y: 0 })
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [contextMenu.visible])

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    // Position the menu at cursor
    const menuWidth = 180
    const menuHeight = 120
    let x = e.clientX
    let y = e.clientY

    // Adjust if menu would go off-screen
    if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 8
    if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 8

    setContextMenu({ visible: true, x, y })
    onContextMenu?.(item.id, e)
  }

  const handleContextAction = (action: 'open' | 'folder' | 'remove' | 'deleteFile'): void => {
    setContextMenu({ visible: false, x: 0, y: 0 })
    if (action === 'open') {
      window.api.shell.openPath(item.filePath)
    } else if (action === 'folder') {
      window.api.shell.showItemInFolder(item.filePath)
    }
    // remove/deleteFile are handled by selecting the item (via onContextMenu callback to parent)
  }

  return (
    <div
      className="group relative rounded-lg overflow-hidden bg-surface border border-line hover:border-accent hover:shadow-lg transition-all duration-200"
    >
      {/* Selection checkbox */}
      <div
        className={`absolute top-2 left-2 z-10 transition-opacity ${selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(item.id)}
          className="w-4 h-4 rounded border-line text-accent focus:ring-accent bg-surface cursor-pointer"
          onClick={(e) => e.stopPropagation()}
        />
      </div>

      {/* Clickable area */}
      <button
        onClick={() => onClick(item.id)}
        onDragStart={(e) => e.preventDefault()}
        onContextMenu={handleContextMenu}
        className="text-left w-full"
      >
        {/* Cover image */}
        <div className={`${compact ? 'aspect-[2/3]' : 'aspect-[3/4]'} bg-raised relative overflow-hidden`}>
          {coverSrc ? (
            <img
              src={coverSrc}
              alt={title}
              draggable={false}
              loading="lazy"
              onError={() => setImgError(true)}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-fg-faint">
              <span className={compact ? 'text-xl' : 'text-3xl'}>📖</span>
            </div>
          )}

          {/* Converting badge takes the format badge's place — the format is
              about to change, so showing the old one would be misleading. */}
          {converting ? (
            <span className="absolute top-2 right-2 flex items-center gap-1 bg-accent-fill/90 text-white text-xs px-1.5 py-0.5 rounded font-medium">
              <span className="w-2.5 h-2.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              {!compact && 'CBZ…'}
            </span>
          ) : (
            !compact && (
              <span className="absolute top-2 right-2 bg-accent-fill/80 text-white text-xs px-1.5 py-0.5 rounded font-medium">
                {item.format?.toUpperCase() || 'PDF'}
              </span>
            )
          )}
        </div>

        {/* Info section */}
        <div className={compact ? 'p-1.5 space-y-0.5' : 'p-3 space-y-1'}>
          {/* Title */}
          <h3 className={`${compact ? 'text-xs' : 'text-sm'} font-medium text-fg line-clamp-2 leading-snug`}>
            {title}
          </h3>

          {/* Artist */}
          <p className={`${compact ? 'text-[10px]' : 'text-xs'} text-fg-muted truncate`}>
            {artist}
          </p>

          {/* Series badge — hide in compact mode */}
          {!compact && item.seriesName && (
            <p className="text-xs text-info truncate">
              {item.seriesName}
            </p>
          )}
        </div>
      </button>

      {/* Right-click context menu */}
      {contextMenu.visible && (
        <div
          ref={menuRef}
          className="fixed z-50 w-44 rounded-lg border border-line bg-surface shadow-xl py-1 text-sm"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => handleContextAction('open')}
            className="w-full text-left px-3 py-2 hover:bg-raised text-fg flex items-center gap-2"
          >
            <span>📖</span> Open File
          </button>
          <button
            onClick={() => handleContextAction('folder')}
            className="w-full text-left px-3 py-2 hover:bg-raised text-fg flex items-center gap-2"
          >
            <span>📂</span> Open Folder
          </button>
          <div className="border-t border-line my-1" />
          <button
            onClick={() => handleContextAction('remove')}
            className="w-full text-left px-3 py-2 hover:bg-raised text-warning flex items-center gap-2"
          >
            <span>📋</span> Remove from Library
          </button>
          <button
            onClick={() => handleContextAction('deleteFile')}
            className="w-full text-left px-3 py-2 hover:bg-raised text-danger flex items-center gap-2"
          >
            <span>🗑️</span> Delete File
          </button>
        </div>
      )}
    </div>
  )
}
