import { useState } from 'react'

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
}

export default function LibraryCard({
  item,
  selected,
  onToggleSelect,
  onClick,
  onContextMenu
}: LibraryCardProps): React.JSX.Element {
  const [imgError, setImgError] = useState(false)

  const title = item.customTitle || item.primaryArtist || `Item #${item.id}`
  const artist = item.primaryArtist || 'Unknown'

  // Cover: use custom cover path if available, otherwise placeholder
  const coverSrc = item.customCoverPath && !imgError
    ? `file://${item.customCoverPath}`
    : null

  return (
    <div
      className="group relative rounded-lg overflow-hidden bg-white dark:bg-gray-850 border border-gray-200 dark:border-gray-700 hover:border-purple-400 dark:hover:border-purple-500 hover:shadow-lg transition-all duration-200"
      style={{ backgroundColor: 'var(--card-bg, rgb(30 41 59))' }}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu?.(item.id, e)
      }}
    >
      {/* Selection checkbox */}
      <div
        className={`absolute top-2 left-2 z-10 transition-opacity ${selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(item.id)}
          className="w-4 h-4 rounded border-gray-400 dark:border-gray-500 text-purple-600 focus:ring-purple-500 bg-white dark:bg-gray-700 cursor-pointer"
          onClick={(e) => e.stopPropagation()}
        />
      </div>

      {/* Clickable area */}
      <button
        onClick={() => onClick(item.id)}
        className="text-left w-full"
      >
        {/* Cover image */}
        <div className="aspect-[3/4] bg-gray-200 dark:bg-gray-700 relative overflow-hidden">
          {coverSrc ? (
            <img
              src={coverSrc}
              alt={title}
              loading="lazy"
              onError={() => setImgError(true)}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-400">
              <span className="text-3xl">📖</span>
            </div>
          )}

          {/* Format badge */}
          <span className="absolute top-2 right-2 bg-purple-600/80 text-white text-xs px-1.5 py-0.5 rounded font-medium">
            {item.format?.toUpperCase() || 'PDF'}
          </span>
        </div>

        {/* Info section */}
        <div className="p-3 space-y-1">
          {/* Title */}
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2 leading-snug">
            {title}
          </h3>

          {/* Artist */}
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {artist}
          </p>

          {/* Series badge if set */}
          {item.seriesName && (
            <span className="inline-block text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">
              {item.seriesName}
            </span>
          )}
        </div>
      </button>
    </div>
  )
}
