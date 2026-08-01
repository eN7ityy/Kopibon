import type { ReactNode } from 'react'
import { BookOpen, Check, Loader2 } from 'lucide-react'

/**
 * The shared anatomy of a gallery card.
 *
 * Search, Favorites and Library each grew their own card, and they had drifted
 * into three different designs: Search showed page count twice plus a favourite
 * count, Favorites showed page count twice plus an in-library tick, and Library
 * showed a format badge and the artist but no page count at all.
 *
 * These parts fix the anatomy in one place so the three cards cannot drift
 * again, while leaving each page its own behaviour — Library needs selection and
 * a context menu, Search does not.
 *
 *   ┌──────────────────┐
 *   │            badge │  ← format, plus an in-library tick where relevant
 *   │      cover       │
 *   │           pages  │  ← page count, bottom right
 *   ├──────────────────┤
 *   │ Title            │
 *   │ artist  language │  ← artist in the accent, language muted
 *   └──────────────────┘
 */

// ─── Cover ───────────────────────────────────────────────────────────────────

interface TileCoverProps {
  src: string | null
  alt: string
  compact?: boolean
  /**
   * Bottom-right stat. Page count on Search and Favorites, file size in the
   * Library — the library has no page count to show.
   *
   * `library_item` has no page-count column, and only 38 of 4,632 rows can join
   * one from the cached gallery table, because scanner-created gallery rows
   * store `page_count` 0. Rather than leave the corner empty on almost every
   * library card, it carries the stat that view does know. Same position, same
   * treatment, so the three grids still read as one design.
   */
  stat?: string | null
  /** Badge slot, top right. */
  badge?: ReactNode
  /**
   * Bottom-left slot, opposite `stat`.
   *
   * Exists for the series card's volume count. The other three corners were
   * already taken — selection checkbox top left, format badge top right, size
   * bottom right — and a series has to be tellable from a gallery at a glance
   * or the grid stops making sense.
   */
  cornerLeft?: ReactNode
  /**
   * Take the height the parent gives instead of setting one from the aspect
   * ratio.
   *
   * Lets a card fix its own total height and hand the cover whatever the text
   * block did not use, so a card with an extra line of metadata stays the same
   * size as its neighbours rather than growing taller than them. The crop moves
   * to the top edge in this mode: the cover loses height from the bottom, which
   * is where a cover carries the least.
   */
  fill?: boolean
  onError?: () => void
}

export function TileCover({
  src,
  alt,
  compact = false,
  stat,
  badge,
  cornerLeft,
  fill = false,
  onError
}: TileCoverProps): React.JSX.Element {
  return (
    <div
      className={`${
        fill ? 'h-full w-full' : compact ? 'aspect-[2/3]' : 'aspect-[3/4]'
      } bg-raised relative overflow-hidden`}
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          draggable={false}
          loading="lazy"
          onError={onError}
          className={`w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 ${
            fill ? 'object-top' : ''
          }`}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-fg-faint">
          <BookOpen size={compact ? 20 : 32} strokeWidth={1.5} aria-hidden="true" />
        </div>
      )}

      {badge && <div className="absolute top-2 right-2 flex items-center gap-1">{badge}</div>}

      {/*
        This sits over artwork of any brightness, so it keeps a dark scrim
        rather than a theme surface.
      */}
      {stat && !compact && (
        <span className="tnum absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white">
          {stat}
        </span>
      )}

      {cornerLeft && !compact && <div className="absolute bottom-2 left-2">{cornerLeft}</div>}
    </div>
  )
}

// ─── Badges ──────────────────────────────────────────────────────────────────

/**
 * Format, and whether the gallery is already on disk, as one badge.
 *
 * On Search and Favorites these are the same fact — if we know the format, it is
 * because the gallery is in the library — so showing them separately would say
 * the same thing twice.
 */
export function TileFormatBadge({
  format,
  owned = false,
  busy = false
}: {
  format?: string | null
  owned?: boolean
  busy?: boolean
}): React.JSX.Element | null {
  if (busy) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-accent-fill/90 px-1.5 py-0.5 text-xs font-medium text-white">
        <Loader2 size={10} className="animate-spin" aria-hidden="true" />
      </span>
    )
  }

  if (!format) return null

  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-accent-fill/85 px-1.5 py-0.5 text-xs font-medium text-white"
      title={owned ? `In library as ${format.toUpperCase()}` : format.toUpperCase()}
    >
      {owned && <Check size={10} strokeWidth={3} aria-hidden="true" />}
      {format.toUpperCase()}
    </span>
  )
}

// ─── Meta ────────────────────────────────────────────────────────────────────

interface TileMetaProps {
  title: string
  /** Rendered in the accent, since it is the field most often scanned for. */
  artist?: string | null
  language?: string | null
  compact?: boolean
}

export function TileMeta({
  title,
  artist,
  language,
  compact = false
}: TileMetaProps): React.JSX.Element {
  // 'Unknown' is a placeholder the scanner writes, not a fact worth showing.
  const showArtist = artist && artist !== 'Unknown'

  return (
    <div className={compact ? 'p-1.5 space-y-0.5' : 'p-3 space-y-1'}>
      <h3
        className={`${compact ? 'text-xs' : 'text-sm'} font-medium text-fg line-clamp-2 leading-snug`}
      >
        {title}
      </h3>

      {/*
        One row for artist and language. It stays out of the DOM entirely when
        neither is known, so cards for galleries we have no metadata for do not
        reserve an empty line.
      */}
      {(showArtist || language) && !compact && (
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="truncate font-medium text-accent" title={showArtist ? artist : undefined}>
            {showArtist ? artist : ''}
          </span>
          {language && <span className="shrink-0 text-fg-faint">{language}</span>}
        </div>
      )}

      {showArtist && compact && (
        <p className="truncate text-label font-medium text-accent">{artist}</p>
      )}
    </div>
  )
}
