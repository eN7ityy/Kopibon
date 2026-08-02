import type { GalleryListItem } from '../../types/api.types'
import { EyeOff } from 'lucide-react'
import { TileCover, TileFormatBadge, TileMeta } from '../shared/GalleryTile'
import { UNOWNED, type LibraryFacts } from '../shared/library-facts'
import type { GalleryMark } from './GalleryGrid'
import { useCdnConfigStore } from '../../stores/cdn.store'
import { useImageRotation } from '../shared/use-image-rotation'

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
  /**
   * Set when a blocked entry in `dim` mode matched, or when nhentai has
   * blacklisted this gallery and that setting is on. Absent means unmarked.
   */
  mark?: GalleryMark
  onClick: (id: number) => void
}

export default function GalleryCard({
  gallery,
  facts = UNOWNED,
  mark,
  onClick
}: GalleryCardProps): React.JSX.Element {
  const title = gallery.english_title || gallery.japanese_title || `#${gallery.id}`

  // The API returns a path like "galleries/{media_id}/thumb.jpg". Rotate
  // through the live CDN thumb servers instead of a hardcoded host, falling
  // back to the standard placeholder once every server has failed.
  const thumbServers = useCdnConfigStore((s) => s.thumbServers)
  const { url: thumbUrl, onError: thumbOnError } = useImageRotation(gallery.thumbnail, thumbServers)

  const marked = Boolean(mark && (mark.matches.length > 0 || mark.blacklisted))

  /**
   * Why this is marked, for the tooltip.
   *
   * Says which value matched rather than just "blocked": the matching tag is
   * often not one the card displays, so without this the marking looks arbitrary.
   */
  const reason = marked
    ? [
        ...(mark?.matches ?? []).map((m) => `${m.type}: ${m.value}`),
        ...(mark?.blacklisted ? ['blacklisted on nhentai'] : [])
      ].join(', ')
    : undefined

  return (
    <button
      onClick={() => onClick(gallery.id)}
      onDragStart={(e) => e.preventDefault()}
      title={reason ? `Matches ${reason}` : undefined}
      className={`group relative rounded-lg overflow-hidden bg-surface border transition-all duration-200 text-left w-full hover:border-accent hover:shadow-lg ${
        marked ? 'border-dashed border-fg-faint/60' : 'border-line'
      }`}
    >
      {/*
        Marked results stay fully clickable and only lose visual weight, since the
        point of `dim` rather than `exclude` is that you can still see and open
        them. Opacity lifts on hover so the cover is legible when you look at it
        deliberately.
      */}
      <div
        className={
          marked
            ? 'opacity-40 transition-opacity duration-200 group-hover:opacity-100'
            : undefined
        }
      >
      <TileCover
        src={thumbUrl}
        alt={title}
        stat={gallery.num_pages > 0 ? `${gallery.num_pages}p` : null}
        onError={thumbOnError}
        badge={
          <TileFormatBadge
            format={facts.format}
            owned={facts.status === 'in_library'}
            busy={facts.status === 'downloading' || facts.status === 'converting'}
          />
        }
      />
        <TileMeta title={title} artist={facts.artist} language={facts.language} />
      </div>

      {marked && (
        <span
          className="absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-black/75 px-1.5 py-0.5 text-xs font-medium text-white"
          aria-label={reason ? `Matches ${reason}` : 'Blocked value'}
        >
          <EyeOff size={11} aria-hidden="true" />
          {mark?.matches.length ? mark.matches.length : ''}
        </span>
      )}
    </button>
  )
}
