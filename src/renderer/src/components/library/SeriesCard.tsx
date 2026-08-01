import { useState, useEffect } from 'react'
import { Layers } from 'lucide-react'
import { TileCover, TileFormatBadge, TileMeta } from '../shared/GalleryTile'
import { mergeDisplayLanguages } from '../shared/language'
import { formatBytes } from '../shared/format'

/**
 * A series as one row in the library grid.
 *
 * Built from the same parts as LibraryCard so the two read as one design, with
 * three additions that exist to make a series unmistakable at a glance. Without
 * them the grid becomes a mix of two kinds of thing that look identical, and
 * clicking one does something quite different from clicking the other:
 *
 *   ⧉ 15         volume count, bottom left of the cover
 *   3 of 15      only while a filter is hiding some of them
 *   stacked edge a second card peeking out behind the first
 */

/** Mirrors SeriesCardData in library.repo. */
export interface SeriesCardModel {
  id: number
  name: string
  matchCount: number
  totalCount: number
  addedAt: number
  fileSize: number
  coverItemId: number | null
  coverPath: string | null
  format: string | null
  artists: string[]
  languages: string[]
  tags: string[]
  gaps: number[]
  members: Array<{ id: number; format: string }>
}

interface SeriesCardProps {
  series: SeriesCardModel
  /** True when every gallery this card stands for is selected. */
  selected: boolean
  /** True when some but not all are — a series can be part-selected. */
  partiallySelected?: boolean
  onToggleSelect: (series: SeriesCardModel) => void
  onClick: (series: SeriesCardModel) => void
  compact?: boolean
}

export default function SeriesCard({
  series,
  selected,
  partiallySelected = false,
  onToggleSelect,
  onClick,
  compact = false
}: SeriesCardProps): React.JSX.Element {
  const [thumb, setThumb] = useState<string | null>(null)
  const [imgError, setImgError] = useState(false)

  // The cover is a member's, so it reuses the per-item thumbnail cache rather
  // than generating anything of its own.
  useEffect(() => {
    if (series.coverItemId == null) return
    let cancelled = false
    window.api.library
      .getThumbnail(series.coverItemId)
      .then((result) => {
        if (!cancelled && result.success && result.data) setThumb(result.data)
      })
      .catch(() => setImgError(true))
    return () => {
      cancelled = true
    }
  }, [series.coverItemId])

  const filtered = series.matchCount < series.totalCount
  const languages = mergeDisplayLanguages(series.languages)

  // Twelve of 239 groups span more than one artist. Listing them all would
  // overflow the line, and naming only the first would be wrong, so past one
  // the card says how many there are.
  const artistLabel =
    series.artists.length === 0
      ? null
      : series.artists.length === 1
        ? series.artists[0]
        : `${series.artists[0]} +${series.artists.length - 1}`

  return (
    /*
      The ratio lives on the outer wrapper, which spans the full grid cell.

      It was on the inner card, which carries `mr-1.5` to make room for the
      stacked edge — so the ratio resolved against a width 6px narrower than a
      gallery card's and every series came out about 11px shorter. The wrapper
      sets the height, the card fills it.
    */
    <div className={`group relative flex ${compact ? 'aspect-[1/2.05]' : 'aspect-[1/1.85]'}`}>
      {/*
        A second card peeking out behind the first. Inset vertically and offset
        by a few pixels so it reads as depth rather than as a misaligned card,
        and inside the cell's own width so a grid gap cannot clip it.
      */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-2 right-0 w-2 rounded-r-lg border border-l-0 border-line bg-raised"
      />

      <div className="relative mr-1.5 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface transition-all duration-200 hover:border-accent hover:shadow-lg">
        <div
          className={`absolute top-2 left-2 z-10 transition-opacity ${
            selected || partiallySelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          <input
            type="checkbox"
            checked={selected}
            // Part-selected is a real state here in a way it never was for a
            // gallery: picking single volumes out of a series leaves the card
            // neither on nor off, and a plain unchecked box would claim the
            // selection is empty.
            ref={(el) => {
              if (el) el.indeterminate = !selected && partiallySelected
            }}
            onChange={() => onToggleSelect(series)}
            onClick={(e) => e.stopPropagation()}
            className="h-4 w-4 cursor-pointer rounded border-line bg-surface text-accent focus:ring-accent"
          />
        </div>

        <button
          onClick={() => onClick(series)}
          onDragStart={(e) => e.preventDefault()}
          className="flex min-h-0 w-full flex-1 flex-col text-left"
        >
          <div className="min-h-0 flex-1">
            <TileCover
              src={imgError ? null : thumb}
              alt={series.name}
              compact={compact}
              fill
              stat={series.fileSize > 0 ? formatBytes(series.fileSize) : null}
              onError={() => setImgError(true)}
              badge={<TileFormatBadge format={series.format} />}
              cornerLeft={
                <span
                  className="tnum inline-flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white"
                  title={`${series.totalCount} galleries in this series`}
                >
                  <Layers size={10} aria-hidden="true" />
                  {series.totalCount}
                </span>
              }
            />
          </div>

          <div className="shrink-0">
            <TileMeta
              title={series.name}
              artist={artistLabel}
              language={languages[0] ?? null}
              compact={compact}
            />

            {/*
              The honesty line. A series matches when any member does, so without
              this a card would silently imply that all fifteen volumes matched a
              search that three of them did.
            */}
            {filtered && !compact && (
              <p className="px-3 pb-3 -mt-1">
                <span className="tnum rounded bg-accent-wash px-1.5 py-0.5 text-xs font-medium text-accent">
                  {series.matchCount} of {series.totalCount} match
                </span>
              </p>
            )}
          </div>
        </button>
      </div>
    </div>
  )
}
