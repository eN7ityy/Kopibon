import { useState } from 'react'
import type { GalleryListItem } from '../../types/api.types'
import { TileCover, TileFormatBadge, TileMeta } from '../shared/GalleryTile'
import { UNOWNED, type LibraryFacts } from '../shared/library-facts'

interface GalleryCardProps {
  gallery: GalleryListItem
  /**
   * What the library knows about this gallery. Comes from the lookup Search and
   * Favorites already perform for the download status, so artist, language and
   * format cost no extra request.
   *
   * A fresh search result we do not own has none of these: the list endpoint
   * returns `tag_ids` (numbers) rather than tag names, and there is no local
   * dictionary to resolve them against, so the meta row stays out of the DOM.
   */
  facts?: LibraryFacts
  onClick: (id: number) => void
}

export default function GalleryCard({
  gallery,
  facts = UNOWNED,
  onClick
}: GalleryCardProps): React.JSX.Element {
  const [imgError, setImgError] = useState(false)

  const title = gallery.english_title || gallery.japanese_title || `#${gallery.id}`

  // The API returns a path like "galleries/{media_id}/thumb.jpg".
  const thumbUrl =
    gallery.thumbnail && !imgError ? `https://t.nhentai.net/${gallery.thumbnail}` : null

  return (
    <button
      onClick={() => onClick(gallery.id)}
      onDragStart={(e) => e.preventDefault()}
      className="group relative rounded-lg overflow-hidden bg-surface border border-line hover:border-accent hover:shadow-lg transition-all duration-200 text-left w-full"
    >
      <TileCover
        src={thumbUrl}
        alt={title}
        stat={gallery.num_pages > 0 ? `${gallery.num_pages}p` : null}
        onError={() => setImgError(true)}
        badge={
          <TileFormatBadge
            format={facts.format}
            owned={facts.status === 'in_library'}
            busy={facts.status === 'downloading' || facts.status === 'converting'}
          />
        }
      />
      <TileMeta title={title} artist={facts.artist} language={facts.language} />
    </button>
  )
}
