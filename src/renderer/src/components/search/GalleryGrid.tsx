import type { GalleryListItem } from '../../types/api.types'
import GalleryCard from './GalleryCard'
import type { LibraryFacts } from '../shared/library-facts'

interface GalleryGridProps {
  galleries: Array<{ gallery: GalleryListItem; facts?: LibraryFacts }>
  onGalleryClick: (id: number) => void
}

export default function GalleryGrid({
  galleries,
  onGalleryClick
}: GalleryGridProps): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
      {galleries.map(({ gallery, facts }) => (
        <GalleryCard
          key={gallery.id}
          gallery={gallery}
          facts={facts}
          onClick={onGalleryClick}
        />
      ))}
    </div>
  )
}
