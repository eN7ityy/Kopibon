import { useState, useEffect } from 'react'
import { AlertTriangle, BookOpen, Check, Layers, Pencil, Star, Ungroup, X } from 'lucide-react'
import type { LibraryItemData } from './LibraryCard'
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

/**
 * The least this panel needs to open a series.
 *
 * A card supplies all of it, but so does the name lookup behind the series link
 * on a gallery's detail, which knows an id and a name and nothing else. Only
 * the id identifies the request; the rest is what to draw until the facts
 * arrive.
 */
export interface SeriesRef {
  id: number
  name: string
  totalCount?: number
  coverItemId?: number | null
}

interface SeriesDetailProps {
  series: SeriesRef
  filters?: SeriesFilterParams
  onClose: () => void
  onOpenItem: (item: LibraryItemData) => void
  /** Something about the series changed and the grid behind should reload. */
  onChanged?: () => void
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
  onOpenItem,
  onChanged
}: SeriesDetailProps): React.JSX.Element {
  /*
   * Initial values rather than resets inside the effect: the parent mounts this
   * keyed by series id, so switching series is a remount and setting state from
   * an effect body would only add a render with the previous series on screen.
   */
  const [facts, setFacts] = useState<SeriesFacts | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [confirmUngroup, setConfirmUngroup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

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
  }, [series.id, reloadTick])

  /** Re-read the panel and tell the grid behind it to reload. */
  const refresh = (message: string | null): void => {
    setNotice(message)
    setReloadTick((t) => t + 1)
    onChanged?.()
  }

  const doRename = async (): Promise<void> => {
    const next = nameDraft.trim()
    if (!next || !facts || next === facts.name) {
      setRenaming(false)
      return
    }
    setBusy(true)
    try {
      const r = await window.api.library.renameSeries(facts.id, next)
      if (r?.success) {
        const errs = (r.data as { errors?: string[] })?.errors
        setRenaming(false)
        refresh(
          errs?.length
            ? `Renamed, but ${errs.length} file${errs.length === 1 ? '' : 's'} could not be moved.`
            : null
        )
      } else {
        setNotice(r?.error || 'Could not rename this series')
      }
    } catch (err) {
      setNotice(String(err))
    } finally {
      setBusy(false)
    }
  }

  const doUngroup = async (): Promise<void> => {
    if (!facts) return
    setBusy(true)
    setConfirmUngroup(false)
    try {
      const r = await window.api.library.setSeriesDissolved(facts.id, true)
      if (r?.success) {
        onChanged?.()
        onClose()
      } else {
        setNotice(r?.error || 'Could not ungroup this series')
      }
    } catch (err) {
      setNotice(String(err))
    } finally {
      setBusy(false)
    }
  }

  const doSetCover = async (itemId: number): Promise<void> => {
    if (!facts) return
    setBusy(true)
    try {
      const r = await window.api.library.setSeriesCover(facts.id, itemId)
      if (r?.success) refresh('Cover updated.')
      else setNotice(r?.error || 'Could not set the cover')
    } catch (err) {
      setNotice(String(err))
    } finally {
      setBusy(false)
    }
  }

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
          {renaming ? (
            <input
              autoFocus
              value={nameDraft}
              disabled={busy}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doRename()
                if (e.key === 'Escape') setRenaming(false)
              }}
              className="min-w-0 flex-1 rounded-lg border border-accent bg-surface px-2 py-1 text-section font-semibold text-fg"
            />
          ) : (
            <h2 className="min-w-0 flex-1 truncate text-section font-semibold text-fg">
              {facts?.name ?? series.name}
            </h2>
          )}
          {renaming && (
            <button
              onClick={() => void doRename()}
              disabled={busy}
              className="shrink-0 rounded-lg bg-accent-fill px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? 'Renaming…' : 'Save'}
            </button>
          )}
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

              {/*
                Fewer, larger columns than a contact sheet. These are the point
                of the panel, so the cover should be big enough to recognise a
                volume by, not just to count them.
              */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                {facts.members.map((item) => (
                  <MemberTile
                    key={item.id}
                    item={item}
                    dimmed={filtered && !item.matches}
                    isCover={item.id === facts.coverItemId}
                    onClick={() => onOpenItem(item)}
                    onSetCover={() => void doSetCover(item.id)}
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

              {/* ── Actions ───────────────────────────────────────────── */}
              <div className="mt-4 space-y-2 border-t border-line pt-3">
                <button
                  onClick={() => {
                    setNameDraft(facts.name)
                    setRenaming(true)
                  }}
                  disabled={busy || renaming}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-fg transition-colors hover:bg-raised disabled:opacity-50"
                >
                  <Pencil size={14} className="shrink-0 text-fg-muted" aria-hidden="true" />
                  Rename series
                </button>

                <button
                  onClick={() => setConfirmUngroup(true)}
                  disabled={busy || confirmUngroup}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-warning transition-colors hover:bg-warning-wash disabled:opacity-50"
                >
                  <Ungroup size={14} className="shrink-0" aria-hidden="true" />
                  Ungroup this series
                </button>

                {/*
                  Says plainly that nothing is destroyed. "Ungroup" next to a
                  library of files reads as though it might delete or move
                  something, and it does neither.
                */}
                {confirmUngroup && (
                  <div className="rounded-lg border border-warning/40 bg-warning-wash p-2.5">
                    <p className="text-xs text-fg">
                      Show these {facts.totalCount} galleries separately again?
                    </p>
                    <p className="mt-1 text-xs text-fg-muted">
                      No files are moved or deleted and they keep their series name. You can group
                      them again later.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => void doUngroup()}
                        disabled={busy}
                        className="rounded-lg bg-warning-fill px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                      >
                        Ungroup
                      </button>
                      <button
                        onClick={() => setConfirmUngroup(false)}
                        disabled={busy}
                        className="rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium text-fg disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {notice && <p className="text-xs text-fg-muted">{notice}</p>}
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
  isCover,
  onClick,
  onSetCover
}: {
  item: SeriesMemberRow
  dimmed: boolean
  /** This member's cover is the one representing the series. */
  isCover: boolean
  onClick: () => void
  onSetCover: () => void
}): React.JSX.Element {
  const thumb = useItemThumbnail(item.id)
  const read = (item.readProgress ?? 0) > 0

  return (
    /*
      A real card, matching the library grid: its own surface, border and hover
      lift. Bare covers on the panel background read as a contact sheet rather
      than as the galleries they are, and gave nothing to aim at between them.
    */
    /*
      A div rather than a button, with the cover action as a real button inside
      it. Nesting a button in a button is invalid and the inner one would not
      reliably receive its own clicks.
    */
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      onDragStart={(e) => e.preventDefault()}
      title={item.customTitle ?? undefined}
      className={`group flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-surface text-left transition-all duration-200 hover:shadow-lg ${
        isCover ? 'border-accent' : 'border-line hover:border-accent'
      } ${dimmed ? 'opacity-40 hover:opacity-100' : ''}`}
    >
      <div className="relative aspect-[3/4] overflow-hidden bg-raised">
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
            <BookOpen size={28} strokeWidth={1.5} aria-hidden="true" />
          </div>
        )}

        {/*
          Volume leads the tile. It is what orders the series, and a member with
          no number has to look unnumbered rather than merely sorted last.
        */}
        <span className="tnum absolute left-2 top-2 rounded bg-black/75 px-1.5 py-0.5 text-xs font-medium text-white">
          {item.seriesIndex != null ? `V${item.seriesIndex}` : '—'}
        </span>

        {read && (
          <span
            className="absolute right-2 top-2 rounded bg-success-fill/90 p-0.5 text-white"
            title="Read"
          >
            <Check size={11} strokeWidth={3} aria-hidden="true" />
          </span>
        )}

        <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium uppercase text-white">
          {item.format || 'pdf'}
        </span>

        {/*
          The current cover says so permanently; the others offer the action on
          hover, so the grid is not littered with buttons.
        */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            if (!isCover) onSetCover()
          }}
          disabled={isCover}
          title={isCover ? 'Series cover' : 'Use as series cover'}
          className={`absolute bottom-2 left-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium transition-opacity ${
            isCover
              ? 'bg-accent-fill/90 text-white'
              : 'bg-black/70 text-white opacity-0 hover:bg-black/85 group-hover:opacity-100'
          }`}
        >
          <Star size={10} strokeWidth={isCover ? 3 : 2} aria-hidden="true" />
          {isCover ? 'Cover' : 'Set'}
        </button>
      </div>

      <div className="p-2.5">
        <p className="line-clamp-2 text-xs leading-snug text-fg">
          {item.customTitle || `Item #${item.id}`}
        </p>
        {item.fileSize ? (
          <p className="tnum mt-1 text-xs text-fg-faint">{formatBytes(item.fileSize)}</p>
        ) : null}
      </div>
    </div>
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
