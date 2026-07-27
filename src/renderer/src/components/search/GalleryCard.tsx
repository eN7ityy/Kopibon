import { useState } from 'react'
import type { SearchResult, DownloadStatus } from '../../types/api.types'
import StatusBadge from '../shared/StatusBadge'

interface GalleryCardProps {
  gallery: SearchResult
  downloadStatus: DownloadStatus
  onClick: (id: number) => void
}

export default function GalleryCard({
  gallery,
  downloadStatus,
  onClick
}: GalleryCardProps): React.JSX.Element {
  const [imgError, setImgError] = useState(false)

  const mediaId = gallery.media_id ?? String(gallery.id)
  const title = gallery.title?.pretty ?? `#${gallery.id}`

  // Build cover thumbnail URL from the gallery data
  const coverUrl = gallery.images?.cover
    ? `https://t.nhentai.net/galleries/${mediaId}/cover.${gallery.images.cover.t}`
    : null

  // Build thumbnail fallback
  const thumbUrl = gallery.images?.thumbnail
    ? `https://t.nhentai.net/galleries/${mediaId}/thumb.${gallery.images.thumbnail.t}`
    : null

  const tags = gallery.tags ?? []
  const artistNames = tags
    .filter((t) => t.type === 'artist')
    .map((t) => t.name)
    .join(', ')

  const languageTag = tags.find((t) => t.type === 'language')

  return (
    <button
      onClick={() => onClick(gallery.id)}
      className="group relative rounded-lg overflow-hidden bg-white dark:bg-gray-850 border border-gray-200 dark:border-gray-700 hover:border-purple-400 dark:hover:border-purple-500 hover:shadow-lg transition-all duration-200 text-left w-full"
      style={{ backgroundColor: 'var(--card-bg, rgb(30 41 59))' }}
    >
      {/* Cover image */}
      <div className="aspect-[3/4] bg-gray-200 dark:bg-gray-700 relative overflow-hidden">
        {coverUrl && !imgError ? (
          <img
            src={coverUrl}
            alt={title}
            loading="lazy"
            onError={() => setImgError(true)}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : thumbUrl && !imgError ? (
          <img
            src={thumbUrl}
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

        {/* Page count badge */}
        <span className="absolute bottom-2 right-2 bg-black/70 text-white text-xs px-1.5 py-0.5 rounded font-medium">
          {gallery.num_pages}p
        </span>

        {/* Language badge */}
        {languageTag && (
          <span className="absolute top-2 left-2 bg-purple-600/90 text-white text-xs px-1.5 py-0.5 rounded font-medium">
            {languageTag.name}
          </span>
        )}
      </div>

      {/* Info section */}
      <div className="p-3 space-y-1.5">
        {/* Title */}
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2 leading-snug">
          {title}
        </h3>

        {/* Artist */}
        {artistNames && (
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{artistNames}</p>
        )}

        {/* Status badge */}
        <div className="flex items-center justify-between pt-1">
          <StatusBadge status={downloadStatus} size="sm" />
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {gallery.num_pages} pages
          </span>
        </div>
      </div>
    </button>
  )
}
