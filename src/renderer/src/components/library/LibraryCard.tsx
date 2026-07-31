import { useState, useEffect, useRef } from 'react'
import { useIsConverting } from '../../stores/cbz-conversion.store'
import { BookOpen, FolderOpen, ListX, Trash2 } from 'lucide-react'
import { TileCover, TileFormatBadge, TileMeta } from '../shared/GalleryTile'
import { displayLanguage } from '../shared/language'
import { formatBytes } from '../shared/format'

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
        {/*
          Same anatomy as the Search and Favorites cards, from the same parts —
          these three had drifted into three different designs.
        */}
        <TileCover
          src={coverSrc}
          alt={title}
          compact={compact}
          // formatBytes returns '0 B' for a missing value, which would print a
          // meaningless badge, so an unknown size leaves the corner empty.
          stat={item.fileSize && item.fileSize > 0 ? formatBytes(item.fileSize) : null}
          onError={() => setImgError(true)}
          badge={
            // Converting takes the format badge's place: the format is about to
            // change, so showing the old one would be misleading.
            compact && !converting ? null : (
              <TileFormatBadge
                format={converting ? null : item.format || 'pdf'}
                busy={converting}
              />
            )
          }
        />

        <TileMeta
          title={title}
          artist={artist}
          language={displayLanguage(item.language, item.customLanguage)}
          compact={compact}
        />

        {/* Series is Library-only, so it sits outside the shared meta block. */}
        {!compact && item.seriesName && (
          <p className="px-3 pb-3 -mt-1 truncate text-xs text-fg-muted">{item.seriesName}</p>
        )}
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
            <BookOpen size={14} aria-hidden="true" /> Open File
          </button>
          <button
            onClick={() => handleContextAction('folder')}
            className="w-full text-left px-3 py-2 hover:bg-raised text-fg flex items-center gap-2"
          >
            <FolderOpen size={14} aria-hidden="true" /> Open Folder
          </button>
          <div className="border-t border-line my-1" />
          <button
            onClick={() => handleContextAction('remove')}
            className="w-full text-left px-3 py-2 hover:bg-raised text-warning flex items-center gap-2"
          >
            <ListX size={14} aria-hidden="true" /> Remove from Library
          </button>
          <button
            onClick={() => handleContextAction('deleteFile')}
            className="w-full text-left px-3 py-2 hover:bg-raised text-danger flex items-center gap-2"
          >
            <Trash2 size={14} aria-hidden="true" /> Delete File
          </button>
        </div>
      )}
    </div>
  )
}
