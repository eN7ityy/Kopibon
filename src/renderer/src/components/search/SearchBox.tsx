import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { Star, Loader2, X } from 'lucide-react'
import { useSearchHistoryStore } from '../../stores/search-history.store'
import {
  currentToken,
  replaceToken,
  parseTypedToken,
  buildTagFilter,
  formatCount,
  type QueryToken
} from './query-tokens'

// ─── Types ───────────────────────────────────────────────────────────────────

interface TagSuggestion {
  id: number
  type: string
  name: string
  count: number
}

export interface SearchBoxProps {
  value: string
  onChange: (value: string) => void
  /** Run a full search with this exact query right now — recent/favourite rows do this, live suggestions do not. */
  onRunSearch: (query: string) => void
  placeholder?: string
  className?: string
}

// ─── Static reference content ─────────────────────────────────────────────────

/**
 * The numeric and date filters take a comparator (`pages:>10`), not a bare
 * number — `pages:10` is a real, different filter meaning "exactly 10", which
 * is why the comparator form is shown here rather than the bare form.
 */
const OPERATOR_REFERENCE: ReadonlyArray<{ op: string; desc: string }> = [
  { op: 'tag:"…"', desc: 'Filter by tag' },
  { op: 'artist:…', desc: 'Filter by artist' },
  { op: 'parody:…', desc: 'Filter by parody' },
  { op: 'character:…', desc: 'Filter by character' },
  { op: 'group:…', desc: 'Filter by group' },
  { op: 'language:…', desc: 'Filter by language' },
  { op: 'category:…', desc: 'Filter by category' },
  { op: 'pages:>N', desc: 'More than N pages' },
  { op: 'favorites:>N', desc: 'More than N favourites' },
  { op: 'uploaded:<Nd', desc: 'Uploaded within N days' },
  { op: 'title:"…"', desc: 'Search title text' },
  { op: 'jtitle:"…"', desc: 'Search Japanese title text' }
]

const DEBOUNCE_MS = 250
const MIN_QUERY_LENGTH = 2
const INITIAL_RECENT = 3
const EXPANDED_RECENT = 15

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * The search box: a plain text input plus a dropdown that shows one of three
 * things, decided purely by focus state and the token the caret is in.
 *
 * - Empty box, focused -> favourites, recent searches, the operator reference.
 * - Something typed, but the caret's own token is empty (just finished a
 *   term) -> the operator reference only. Recent/favourite rows are whole
 *   past queries; offering them mid-composition would mean clicking one
 *   discards whatever the user just built.
 * - Caret's token has text in it -> live tag suggestions for that token,
 *   scoped to a type once one has been typed (`artist:` narrows to artists).
 *
 * A suggestion click replaces only the current token (see query-tokens.ts) and
 * keeps the dropdown open, so several terms can be composed by picking
 * suggestions one after another. A recent/favourite click replaces the whole
 * box and runs the search immediately, since those are complete queries.
 */
export default function SearchBox({
  value,
  onChange,
  onRunSearch,
  placeholder,
  className = ''
}: SearchBoxProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const [caret, setCaret] = useState(value.length)
  const [expanded, setExpanded] = useState(false)
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([])
  const [loading, setLoading] = useState(false)
  const [suggestError, setSuggestError] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(-1)

  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestIdRef = useRef(0)
  /** Caret to restore after a programmatic value change — see the effect below. */
  const pendingCaretRef = useRef<number | null>(null)

  const recent = useSearchHistoryStore((s) => s.recent)
  const favorites = useSearchHistoryStore((s) => s.favorites)
  const toggleFavorite = useSearchHistoryStore((s) => s.toggleFavorite)
  const clearRecent = useSearchHistoryStore((s) => s.clearRecent)
  const isFavorite = useSearchHistoryStore((s) => s.isFavorite)

  // ─── Caret restoration after a programmatic edit ────────────────────────
  //
  // A controlled input's value is set by React on every render. Typing is
  // fine — the browser already advanced its own caret before onChange fires,
  // and setting the same value back does not move it. A click on a
  // suggestion is different: nothing in the DOM already knows where the new
  // caret should go, so without this the browser puts it at the end (or
  // somewhere else unhelpful) after the value is replaced from outside.
  useLayoutEffect(() => {
    if (pendingCaretRef.current != null && inputRef.current) {
      const pos = pendingCaretRef.current
      inputRef.current.setSelectionRange(pos, pos)
      pendingCaretRef.current = null
    }
  }, [value])

  // ─── Close on outside click, never on the input's own blur ──────────────
  //
  // Closing on blur would fire before a click on a dropdown row is handled,
  // dismissing the list a frame before the click could ever land on it.
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ─── What the caret is sitting in ────────────────────────────────────────

  const token: QueryToken = currentToken(value, caret)
  const parsed = parseTypedToken(token.text)
  const typingToken = token.text.trim().length > 0
  const composing = value.trim().length > 0
  const showStaticTitleRows = parsed.type === null

  // ─── Live suggestions ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!isOpen || !typingToken || parsed.query.trim().length < MIN_QUERY_LENGTH) {
      // Deferred rather than called directly in the effect body, same as the
      // fetch path below — a setState call synchronous with the effect's own
      // commit can cascade an immediate second render.
      const clearId = setTimeout(() => {
        setSuggestions([])
        setSuggestError(false)
        setLoading(false)
        setHighlightIndex(-1)
      }, 0)
      return () => clearTimeout(clearId)
    }

    const myId = ++requestIdRef.current
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setLoading(true)
      window.api.tags
        .autocomplete(parsed.query.trim(), parsed.type)
        .then((r) => {
          // A later keystroke may have already fired its own request; a
          // slower, older response landing after it must not overwrite
          // fresher results with stale ones.
          if (requestIdRef.current !== myId) return
          if (r.success && Array.isArray(r.data)) {
            setSuggestions(r.data as TagSuggestion[])
            setSuggestError(false)
          } else {
            setSuggestions([])
            setSuggestError(true)
          }
          // Reset right alongside the list it indexes into, rather than in a
          // separate effect reacting to that change a tick later.
          setHighlightIndex(-1)
        })
        .catch(() => {
          if (requestIdRef.current !== myId) return
          setSuggestions([])
          setSuggestError(true)
          setHighlightIndex(-1)
        })
        .finally(() => {
          if (requestIdRef.current === myId) setLoading(false)
        })
    }, DEBOUNCE_MS)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [parsed.query, parsed.type, isOpen, typingToken])

  // ─── Actions ──────────────────────────────────────────────────────────────

  /** Replace just the current token and keep composing. */
  const applyTokenReplacement = (replacement: string): void => {
    const result = replaceToken(value, token, replacement)
    pendingCaretRef.current = result.caret
    setCaret(result.caret)
    onChange(result.text)
    inputRef.current?.focus()
  }

  const selectSuggestion = (s: TagSuggestion): void => {
    applyTokenReplacement(buildTagFilter(s.type, s.name, parsed.negated))
  }

  const selectStaticRow = (field: 'title' | 'jtitle'): void => {
    applyTokenReplacement(buildTagFilter(field, parsed.query, parsed.negated))
  }

  /** Recent/favourite rows are whole past queries: replace everything and run it. */
  const runWholeQuery = (query: string): void => {
    onChange(query)
    setIsOpen(false)
    setExpanded(false)
    onRunSearch(query)
    inputRef.current?.focus()
  }

  // ─── Keyboard nav over the live suggestion list ──────────────────────────
  //
  // Only the live-suggestion list is keyboard-navigable. Recent/favourite
  // rows are mouse/tap targets, matching how they were specified.

  const selectableCount = suggestions.length + (showStaticTitleRows ? 2 : 0)

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      setIsOpen(false)
      return
    }
    if (!isOpen || !typingToken || selectableCount === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIndex((prev) => (prev < selectableCount - 1 ? prev + 1 : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIndex((prev) => (prev > 0 ? prev - 1 : selectableCount - 1))
    } else if (e.key === 'Enter' && highlightIndex >= 0) {
      // Highlighted: consume Enter here so the form does not also submit.
      e.preventDefault()
      if (highlightIndex < suggestions.length) {
        selectSuggestion(suggestions[highlightIndex])
      } else {
        selectStaticRow(highlightIndex === suggestions.length ? 'title' : 'jtitle')
      }
    }
    // Nothing highlighted: let Enter bubble to the form's own submit handler.
  }

  const recentToShow = recent.filter((r) => !isFavorite(r.query))
  const visibleRecent = recentToShow.slice(0, expanded ? EXPANDED_RECENT : INITIAL_RECENT)
  const moreCount = Math.min(EXPANDED_RECENT, recentToShow.length) - INITIAL_RECENT

  const mode: 'closed' | 'browse' | 'reference' | 'suggest' = !isOpen
    ? 'closed'
    : typingToken
      ? 'suggest'
      : composing
        ? 'reference'
        : 'browse'

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setCaret(e.target.selectionStart ?? e.target.value.length)
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
        onFocus={() => setIsOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={mode !== 'closed'}
        aria-autocomplete="list"
        className="w-full px-4 py-2.5 rounded-lg border border-line bg-surface text-fg placeholder-fg-faint focus:outline-none focus:ring-2 focus:ring-accent"
      />

      {mode !== 'closed' && (
        <div className="absolute z-50 mt-1 w-full max-h-96 overflow-y-auto rounded-lg border border-line bg-surface shadow-lg">
          {mode === 'browse' && (
            <BrowsePanel
              favorites={favorites}
              visibleRecent={visibleRecent}
              moreCount={moreCount}
              expanded={expanded}
              onExpand={() => setExpanded(true)}
              onRun={runWholeQuery}
              onToggleFavorite={toggleFavorite}
              onClearRecent={clearRecent}
              hasRecent={recentToShow.length > 0}
            />
          )}

          {mode === 'reference' && <OperatorReference />}

          {mode === 'suggest' && (
            <SuggestPanel
              suggestions={suggestions}
              loading={loading}
              error={suggestError}
              highlightIndex={highlightIndex}
              showStaticTitleRows={showStaticTitleRows}
              queryText={parsed.query}
              onSelectSuggestion={selectSuggestion}
              onSelectStaticRow={selectStaticRow}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ─── Browse panel: favourites, recent, reference ──────────────────────────────

function BrowsePanel({
  favorites,
  visibleRecent,
  moreCount,
  expanded,
  onExpand,
  onRun,
  onToggleFavorite,
  onClearRecent,
  hasRecent
}: {
  favorites: string[]
  visibleRecent: Array<{ query: string; lastSearchedAt: number }>
  moreCount: number
  expanded: boolean
  onExpand: () => void
  onRun: (query: string) => void
  onToggleFavorite: (query: string) => void
  onClearRecent: () => void
  hasRecent: boolean
}): React.JSX.Element {
  return (
    <div>
      {favorites.length > 0 && (
        <div className="py-1">
          <p className="px-3 pt-1 pb-0.5 text-label uppercase tracking-wide text-fg-faint">
            Favourites
          </p>
          {favorites.map((query) => (
            <SearchRow
              key={query}
              query={query}
              starred
              onRun={() => onRun(query)}
              onToggleStar={() => onToggleFavorite(query)}
            />
          ))}
        </div>
      )}

      {hasRecent && (
        <div className="py-1 border-t border-line">
          <div className="flex items-center justify-between px-3 pt-1 pb-0.5">
            <p className="text-label uppercase tracking-wide text-fg-faint">Recent</p>
            <button
              onClick={onClearRecent}
              className="text-label text-fg-faint hover:text-danger transition-colors"
            >
              Clear
            </button>
          </div>
          {visibleRecent.map((entry) => (
            <SearchRow
              key={entry.query}
              query={entry.query}
              starred={false}
              onRun={() => onRun(entry.query)}
              onToggleStar={() => onToggleFavorite(entry.query)}
            />
          ))}
          {!expanded && moreCount > 0 && (
            <button
              onClick={onExpand}
              className="w-full px-3 py-1.5 text-left text-xs text-accent hover:bg-raised transition-colors"
            >
              {moreCount} more recent
            </button>
          )}
        </div>
      )}

      <OperatorReference bordered={favorites.length > 0 || hasRecent} />
    </div>
  )
}

function SearchRow({
  query,
  starred,
  onRun,
  onToggleStar
}: {
  query: string
  starred: boolean
  onRun: () => void
  onToggleStar: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-raised transition-colors group">
      <button onClick={onRun} className="flex-1 min-w-0 text-left text-sm text-fg truncate">
        {query}
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onToggleStar()
        }}
        title={starred ? 'Remove from favourites' : 'Add to favourites'}
        className={`shrink-0 transition-colors ${
          starred ? 'text-warning' : 'text-fg-faint opacity-0 group-hover:opacity-100 hover:text-warning'
        }`}
      >
        <Star size={14} aria-hidden="true" fill={starred ? 'currentColor' : 'none'} />
      </button>
    </div>
  )
}

// ─── Operator reference ────────────────────────────────────────────────────────

function OperatorReference({ bordered = false }: { bordered?: boolean }): React.JSX.Element {
  return (
    <div className={`py-1 ${bordered ? 'border-t border-line' : ''}`}>
      <p className="px-3 pt-1 pb-0.5 text-label uppercase tracking-wide text-fg-faint">Filters</p>
      <div className="px-3 py-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {OPERATOR_REFERENCE.map((r) => (
          <div key={r.op} className="contents">
            <code className="text-xs font-mono text-accent">{r.op}</code>
            <span className="text-xs text-fg-faint text-right">{r.desc}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Live suggestions ───────────────────────────────────────────────────────────

function SuggestPanel({
  suggestions,
  loading,
  error,
  highlightIndex,
  showStaticTitleRows,
  queryText,
  onSelectSuggestion,
  onSelectStaticRow
}: {
  suggestions: TagSuggestion[]
  loading: boolean
  error: boolean
  highlightIndex: number
  showStaticTitleRows: boolean
  queryText: string
  onSelectSuggestion: (s: TagSuggestion) => void
  onSelectStaticRow: (field: 'title' | 'jtitle') => void
}): React.JSX.Element {
  const trimmed = queryText.trim()

  return (
    <ul role="listbox">
      {suggestions.map((s, i) => (
        <li key={s.id} role="option" aria-selected={i === highlightIndex}>
          <button
            onClick={() => onSelectSuggestion(s)}
            className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors ${
              i === highlightIndex ? 'bg-accent-wash text-accent' : 'hover:bg-raised'
            }`}
          >
            <span className="shrink-0 w-20 text-label uppercase tracking-wide text-fg-faint">
              {s.type}
            </span>
            <span className="flex-1 min-w-0 text-sm text-fg truncate">{s.name}</span>
            <span className="shrink-0 text-xs tnum text-fg-faint">{formatCount(s.count)}</span>
          </button>
        </li>
      ))}

      {loading && suggestions.length === 0 && (
        <li className="flex items-center gap-2 px-3 py-2 text-sm text-fg-faint">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          Loading suggestions…
        </li>
      )}

      {error && suggestions.length === 0 && (
        <li className="flex items-center gap-2 px-3 py-2 text-xs text-fg-faint">
          <X size={12} aria-hidden="true" />
          Couldn&apos;t load suggestions — you can still search with the filters below.
        </li>
      )}

      {!loading && !error && suggestions.length === 0 && trimmed.length > 0 && (
        <li className="px-3 py-2 text-sm text-fg-faint">No matching tags.</li>
      )}

      {showStaticTitleRows && trimmed.length > 0 && (
        <>
          <li role="option" aria-selected={highlightIndex === suggestions.length}>
            <button
              onClick={() => onSelectStaticRow('title')}
              className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left border-t border-line transition-colors ${
                highlightIndex === suggestions.length ? 'bg-accent-wash text-accent' : 'hover:bg-raised'
              }`}
            >
              <code className="text-xs font-mono text-accent">title:&quot;{trimmed}&quot;</code>
              <span className="text-xs text-fg-faint">Search title text</span>
            </button>
          </li>
          <li role="option" aria-selected={highlightIndex === suggestions.length + 1}>
            <button
              onClick={() => onSelectStaticRow('jtitle')}
              className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors ${
                highlightIndex === suggestions.length + 1 ? 'bg-accent-wash text-accent' : 'hover:bg-raised'
              }`}
            >
              <code className="text-xs font-mono text-accent">jtitle:&quot;{trimmed}&quot;</code>
              <span className="text-xs text-fg-faint">Search Japanese title text</span>
            </button>
          </li>
        </>
      )}
    </ul>
  )
}
