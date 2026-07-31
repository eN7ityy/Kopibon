import { useState } from 'react'
import { BookOpen, Star } from 'lucide-react'
import type { GalleryListItem, DownloadStatus } from '../../types/api.types'
import StatusBadge from '../shared/StatusBadge'

interface GalleryCardProps {
  gallery: GalleryListItem
  downloadStatus: DownloadStatus
  onClick: (id: number) => void
}

export default function GalleryCard({
  gallery,
  downloadStatus,
  onClick
}: GalleryCardProps): React.JSX.Element {
  const [imgError, setImgError] = useState(false)

  const title = gallery.english_title || gallery.japanese_title || `#${gallery.id}`

  // Thumbnail: the API returns a path like "galleries/{media_id}/thumb.jpg"
  // We prefix with the standard thumbnail CDN base
  const thumbUrl = gallery.thumbnail
    ? `https://t.nhentai.net/${gallery.thumbnail}`
    : null

  return (
    <button
      onClick={() => onClick(gallery.id)}
      onDragStart={(e) => e.preventDefault()}
      className="group relative rounded-lg overflow-hidden bg-surface border border-line hover:border-accent hover:shadow-lg transition-all duration-200 text-left w-full"
    >
      {/* Cover image */}
      <div className="aspect-[3/4] bg-raised relative overflow-hidden">
        {thumbUrl && !imgError ? (
          <img
            src={thumbUrl}
            alt={title}
            draggable={false}
            loading="lazy"
            onError={() => setImgError(true)}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-fg-faint">
            <BookOpen size={32} strokeWidth={1.5} aria-hidden="true" />
          </div>
        )}

        {/* Page count badge */}
        <span className="absolute bottom-2 right-2 bg-black/70 text-white text-xs px-1.5 py-0.5 rounded font-medium">
          {gallery.num_pages || 0}p
        </span>
      </div>

      {/* Info section */}
      <div className="p-3 space-y-1.5">
        {/* Title */}
        <h3 className="text-sm font-medium text-fg line-clamp-2 leading-snug">
          {title}
        </h3>

        {/* Badges row */}
        <div className="flex items-center justify-between pt-1 gap-2">
          <StatusBadge status={downloadStatus} size="sm" showLabel={false} />
          <div className="flex items-center gap-2 text-xs text-fg-faint flex-shrink-0">
            <span className="whitespace-nowrap">{gallery.num_pages || 0} pages</span>
            {gallery.num_favorites > 0 && (
              <span className="whitespace-nowrap inline-flex items-center gap-0.5">
                <Star size={11} aria-hidden="true" />
                <span className="tnum">{gallery.num_favorites.toLocaleString()}</span>
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
  )
}
