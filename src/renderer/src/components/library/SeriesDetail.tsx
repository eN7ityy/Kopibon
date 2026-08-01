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

  const languages = facts ? mergeDisplayLanguages(facts.languages) : []
  const filtered = facts ? facts.matchCount < facts.totalCount : false

  // Only the types the panel shows as their own rows. The long tail of plain
  // tags comes from the merged custom_tags below, which every series has.
  const genre = facts?.typedTags.filter((t) => t.type === 'category') ?? []
  const parody = facts?.typedTags.filter((t) => t.type === 'parody') ?? []

  /** First unread volume, so a long series can be resumed without hunting. */
  const nextUnread = facts?.members.find((m) => (m.readProgress ?? 0) === 0) ?? null
  const readCount = facts?.members.filter((m) => (m.readProgress ?? 0) > 0).length ?? 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="mx-4 flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ─── Header ───────────────────────────────────────────────────── */}
        <div className="flex items-start gap-3 border-b border-line px-6 py-4">
          <Layers size={20} className="mt-1 shrink-0 text-accent" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="text-section font-semibold text-fg">{facts?.name ?? series.name}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
              <span className="tnum">{facts?.totalCount ?? series.totalCount} galleries</span>
              {facts && facts.fileSize > 0 && <span>· {formatBytes(facts.fileSize)}</span>}
              {readCount > 0 && (
                <span className="tnum">
                  · {readCount} of {facts?.totalCount} read
                </span>
              )}
            </p>

            {/* Artists in the accent, matching how every card renders them. */}
            {facts && facts.artists.length > 0 && (
              <p className="mt-1 truncate text-sm font-medium text-accent">
                {facts.artists.join(', ')}
              </p>
            )}
            {languages.length > 0 && (
              <p className="mt-0.5 text-xs text-fg-faint">{languages.join(', ')}</p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {nextUnread && (
              <button
                onClick={() => onOpenItem(nextUnread)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent-fill px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
              >
                <BookOpen size={14} aria-hidden="true" />
                Continue
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-lg p-1 text-fg-muted transition-colors hover:bg-raised hover:text-fg"
              aria-label="Close"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* ─── Body ─────────────────────────────────────────────────────── */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {loading && <p className="text-sm text-fg-muted">Loading…</p>}
          {error && (
            <div className="rounded-lg border border-danger bg-danger-wash p-3 text-sm text-danger">
              {error}
            </div>
          )}

          {facts && !loading && !error && (
            <div className="space-y-4">
              {/*
                Only shown while a filter is active. It explains why some rows
                below are dimmed, which is otherwise unexplained.
              */}
              {filtered && (
                <p className="rounded-lg bg-accent-wash px-3 py-2 text-sm text-accent">
                  <span className="tnum font-medium">
                    {facts.matchCount} of {facts.totalCount}
                  </span>{' '}
                  match the current filters. The rest are shown dimmed.
                </p>
              )}

              {/*
                Gaps are a fact about the collection, so this counts the whole
                series regardless of any filter. Ranges rather than a list of
                numbers: "9–13, 15, 16" reads where "9, 10, 11, 12, 13…" does
                not.
              */}
              {facts.gaps.length > 0 && (
                <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-wash px-3 py-2 text-sm text-warning">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>
                    Missing volume{facts.gaps.length === 1 ? '' : 's'}{' '}
                    <span className="tnum font-medium">{describeGaps(facts.gaps)}</span>
                  </span>
                </p>
              )}

              {/*
                Genre and parody come from cached gallery rows, which only
                downloaded or synced items have — 52 of 4,409 in practice — so
                these rows usually do not render at all. That is the same
                behaviour as the gallery detail panel rather than a gap here.
              */}
              {genre.length > 0 && (
                <TagRow label="Genre" names={genre.map((t) => t.name)} type="category" />
              )}
              {parody.length > 0 && (
                <TagRow label="Parody" names={parody.map((t) => t.name)} type="parody" />
              )}
              {facts.tags.length > 0 && <TagRow label="Tags" names={facts.tags} type="tag" />}

              {/* ─── Members ─────────────────────────────────────────── */}
              <div>
                <span className="text-xs font-medium text-fg-muted">Galleries</span>
                <ul className="mt-1 space-y-0.5">
                  {facts.members.map((item) => (
                    <li key={item.id}>
                      <button
                        onClick={() => onOpenItem(item)}
                        className={`flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-raised ${
                          filtered && !item.matches ? 'opacity-40 hover:opacity-100' : ''
                        }`}
                      >
                        {/*
                          Volume leads: it is what orders the series, and a
                          member with no number has to look unnumbered rather
                          than silently sorted last.
                        */}
                        <span className="tnum w-10 shrink-0 text-xs font-medium text-accent">
                          {item.seriesIndex != null ? `V${item.seriesIndex}` : '—'}
                        </span>
                        {(item.readProgress ?? 0) > 0 ? (
                          <Check size={13} className="shrink-0 text-success" aria-label="Read" />
                        ) : (
                          <span className="w-[13px] shrink-0" aria-hidden="true" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-sm text-fg">
                          {item.customTitle || `Item #${item.id}`}
                        </span>
                        <span className="shrink-0 text-xs uppercase text-fg-faint">
                          {item.format || 'pdf'}
                        </span>
                        <span className="tnum w-16 shrink-0 text-right text-xs text-fg-faint">
                          {item.fileSize ? formatBytes(item.fileSize) : '—'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
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
