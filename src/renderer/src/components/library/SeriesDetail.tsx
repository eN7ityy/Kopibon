import { useState, useEffect } from 'react'
import { AlertTriangle, BookOpen, Check, Layers, X } from 'lucide-react'
import type { LibraryItemData } from './LibraryCard'
import type { SeriesCardModel } from './SeriesCard'
import { mergeDisplayLanguages } from '../shared/language'
import { formatBytes } from '../shared/format'
import { tagClass } from '../shared/tags'
import { describeGaps } from './series-gaps'

/**
 * Everything inside a series.
 *
 * Two columns: the galleries fill the left, the series' own information sits in
 * a fixed column on the right. A single stacked column left the tag rows and
 * the gap warning stretched across the full width with most of it empty, and
 * pushed the galleries — the reason for opening this at all — below the fold.
 *
 * Unlike the card, this shows the **whole** series and dims the members a
 * filter excluded, rather than listing only the matches. Opening a card that
 * reads "3 of 15" and finding three volumes would look like the rest had been
 * deleted; the header states the match instead.
 */

interface SeriesMemberRow extends LibraryItemData {
  matches: boolean
}

interface SeriesFacts {
  id: number
  name: string
  matchCount: number
  totalCount: number
  fileSize: number
  coverItemId: number | null
  artists: string[]
  languages: string[]
  tags: string[]
  gaps: number[]
  typedTags: Array<{ id: number; type: string; name: string }>
  members: SeriesMemberRow[]
}

/** The filters in force, so the panel can flag the same members the card did. */
export interface SeriesFilterParams {
  searchQuery?: string
  artistFilters?: string[]
  seriesFilters?: string[]
  tagFilters?: string[]
  showUnmatchedOnly?: boolean
}

interface SeriesDetailProps {
  series: SeriesCardModel
  filters?: SeriesFilterParams
  onClose: () => void
  onOpenItem: (item: LibraryItemData) => void
}

/**
 * A library item's cached cover.
 *
 * The series cover and every member tile need one, and they all read the same
 * per-item thumbnail cache — a series generates no image of its own.
 */
function useItemThumbnail(id: number | null | undefined): string | null {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    if (id == null) return
    let cancelled = false
    window.api.library
      .getThumbnail(id)
      .then((result) => {
        if (!cancelled && result?.success && result.data) setSrc(result.data as string)
      })
      .catch(() => {
        /* a missing cover falls back to the placeholder */
      })
    return () => {
      cancelled = true
    }
  }, [id])

  return src
}

export default function SeriesDetail({
  series,
  filters,
  onClose,
  onOpenItem
}: SeriesDetailProps): React.JSX.Element {
  /*
   * Initial values rather than resets inside the effect: the parent mounts this
   * keyed by series id, so switching series is a remount and setting state from
   * an effect body would only add a render with the previous series on screen.
   */
  const [facts, setFacts] = useState<SeriesFacts | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    window.api.library
      .getSeriesFacts(series.id, filters)
      .then((result) => {
        if (cancelled) return
        if (result?.success && result.data) setFacts(result.data as unknown as SeriesFacts)
        else setError(result?.error || 'Could not load this series')
      })
      .catch((err) => {
        if (!cancelled) setError(String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // `filters` is a fresh object each render; the series id is what identifies
    // the request, and the parent remounts when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.id])

  const cover = useItemThumbnail(facts?.coverItemId ?? series.coverItemId)

  const languages = facts ? mergeDisplayLanguages(facts.languages) : []
  const filtered = facts ? facts.matchCount < facts.totalCount : false
  const genre = facts?.typedTags.filter((t) => t.type === 'category') ?? []
  const parody = facts?.typedTags.filter((t) => t.type === 'parody') ?? []

  /** First unread volume, so a long series can be resumed without hunting. */
  const nextUnread = facts?.members.find((m) => (m.readProgress ?? 0) === 0) ?? null
  const readCount = facts?.members.filter((m) => (m.readProgress ?? 0) > 0).length ?? 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ─── Title bar ────────────────────────────────────────────────── */}
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-3">
          <Layers size={18} className="shrink-0 text-accent" aria-hidden="true" />
          <h2 className="min-w-0 flex-1 truncate text-section font-semibold text-fg">
            {facts?.name ?? series.name}
          </h2>
          {nextUnread && (
            <button
              onClick={() => onOpenItem(nextUnread)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-accent-fill px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
            >
              <BookOpen size={14} aria-hidden="true" />
              Continue
            </button>
          )}
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-1 text-fg-muted transition-colors hover:bg-raised hover:text-fg"
            aria-label="Close"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {loading && <p className="px-5 py-4 text-sm text-fg-muted">Loading…</p>}
        {error && (
          <div className="m-5 rounded-lg border border-danger bg-danger-wash p-3 text-sm text-danger">
            {error}
          </div>
        )}

        {facts && !loading && !error && (
          <div className="flex min-h-0 flex-1">
            {/* ─── Galleries ────────────────────────────────────────────── */}
            <div className="min-w-0 flex-1 overflow-y-auto p-4">
              {filtered && (
                <p className="mb-3 rounded-lg bg-accent-wash px-3 py-2 text-sm text-accent">
                  <span className="tnum font-medium">
                    {facts.matchCount} of {facts.totalCount}
                  </span>{' '}
                  match the current filters. The rest are dimmed.
                </p>
              )}

              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5">
                {facts.members.map((item) => (
                  <MemberTile
                    key={item.id}
                    item={item}
                    dimmed={filtered && !item.matches}
                    onClick={() => onOpenItem(item)}
                  />
                ))}
              </div>
            </div>

            {/* ─── Series information ───────────────────────────────────── */}
            <aside className="w-72 shrink-0 overflow-y-auto border-l border-line bg-chrome/40 p-4">
              {/*
                The series' own cover, which the panel had no room for before.
                It is a member's image — a series generates none of its own.
              */}
              <div className="mb-3 aspect-[3/4] overflow-hidden rounded-lg border border-line bg-raised">
                {cover ? (
                  <img
                    src={cover}
                    alt={facts.name}
                    draggable={false}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-fg-faint">
                    <BookOpen size={28} strokeWidth={1.5} aria-hidden="true" />
                  </div>
                )}
              </div>

              <dl className="space-y-2 text-sm">
                <Fact label="Galleries" value={<span className="tnum">{facts.totalCount}</span>} />
                {facts.fileSize > 0 && (
                  <Fact
                    label="Size"
                    value={<span className="tnum">{formatBytes(facts.fileSize)}</span>}
                  />
                )}
                {readCount > 0 && (
                  <Fact
                    label="Read"
                    value={
                      <span className="tnum">
                        {readCount} of {facts.totalCount}
                      </span>
                    }
                  />
                )}
                {facts.artists.length > 0 && (
                  <Fact
                    label={facts.artists.length > 1 ? 'Artists' : 'Artist'}
                    value={
                      <span className="font-medium text-accent">{facts.artists.join(', ')}</span>
                    }
                  />
                )}
                {languages.length > 0 && <Fact label="Language" value={languages.join(', ')} />}
              </dl>

              {/*
                Gaps count the whole series regardless of any filter: a missing
                volume is a fact about the collection, not about a search.
              */}
              {facts.gaps.length > 0 && (
                <p className="mt-3 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-wash px-2.5 py-2 text-xs text-warning">
                  <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden="true" />
                  <span>
                    Missing volume{facts.gaps.length === 1 ? '' : 's'}{' '}
                    <span className="tnum font-medium">{describeGaps(facts.gaps)}</span>
                  </span>
                </p>
              )}

              {/*
                Genre and parody come from cached gallery rows, which only
                downloaded or synced items have, so these rows usually do not
                render at all — the same behaviour as the gallery detail panel.
              */}
              <div className="mt-4 space-y-3">
                {genre.length > 0 && (
                  <TagRow label="Genre" names={genre.map((t) => t.name)} type="category" />
                )}
                {parody.length > 0 && (
                  <TagRow label="Parody" names={parody.map((t) => t.name)} type="parody" />
                )}
                {facts.tags.length > 0 && <TagRow label="Tags" names={facts.tags} type="tag" />}
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Parts ───────────────────────────────────────────────────────────────────

/** One gallery in the series, as a cover with its volume number. */
function MemberTile({
  item,
  dimmed,
  onClick
}: {
  item: SeriesMemberRow
  dimmed: boolean
  onClick: () => void
}): React.JSX.Element {
  const thumb = useItemThumbnail(item.id)
  const read = (item.readProgress ?? 0) > 0

  return (
    <button
      onClick={onClick}
      onDragStart={(e) => e.preventDefault()}
      title={item.customTitle ?? undefined}
      className={`group text-left transition-opacity ${dimmed ? 'opacity-40 hover:opacity-100' : ''}`}
    >
      <div className="relative aspect-[3/4] overflow-hidden rounded-lg border border-line bg-raised transition-colors group-hover:border-accent">
        {thumb ? (
          <img
            src={thumb}
            alt={item.customTitle ?? ''}
            draggable={false}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-fg-faint">
            <BookOpen size={20} strokeWidth={1.5} aria-hidden="true" />
          </div>
        )}

        {/*
          Volume leads the tile. It is what orders the series, and a member with
          no number has to look unnumbered rather than merely sorted last.
        */}
        <span className="tnum absolute left-1.5 top-1.5 rounded bg-black/75 px-1.5 py-0.5 text-xs font-medium text-white">
          {item.seriesIndex != null ? `V${item.seriesIndex}` : '—'}
        </span>

        {read && (
          <span
            className="absolute right-1.5 top-1.5 rounded bg-success-fill/90 p-0.5 text-white"
            title="Read"
          >
            <Check size={11} strokeWidth={3} aria-hidden="true" />
          </span>
        )}

        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium uppercase text-white">
          {item.format || 'pdf'}
        </span>
      </div>

      <p className="mt-1 line-clamp-2 text-xs leading-snug text-fg">
        {item.customTitle || `Item #${item.id}`}
      </p>
    </button>
  )
}

/** A label/value pair in the information column. */
function Fact({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="shrink-0 text-xs text-fg-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-sm text-fg">{value}</dd>
    </div>
  )
}

/** One labelled row of tag chips, in the shared colour for its type. */
function TagRow({
  label,
  names,
  type
}: {
  label: string
  names: readonly string[]
  type: string
}): React.JSX.Element {
  return (
    <div>
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      <div className="mt-1 flex flex-wrap gap-1">
        {names.map((name) => (
          <span
            key={name}
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${tagClass(type)}`}
          >
            {name}
          </span>
        ))}
      </div>
    </div>
  )
}
