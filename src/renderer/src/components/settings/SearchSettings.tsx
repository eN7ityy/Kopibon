import { useState, useEffect, useCallback, useRef } from 'react'
import { Plus, Trash2, EyeOff, Eye, Loader2, X } from 'lucide-react'
import Button from '../shared/Button'
import Notice from '../shared/Notice'
import { tagClass } from '../shared/tags'

// ─── Types ───────────────────────────────────────────────────────────────────

type BlockedType = 'tag' | 'artist' | 'group' | 'parody' | 'character' | 'language' | 'text'
type BlockedMode = 'exclude' | 'dim'

interface BlockedRow {
  id: number
  type: string
  value: string
  mode: string
}

interface SearchSettingsData {
  defaultQuery: string | null
  sort: string | null
  language: string | null
  minPages: number | null
  minFavorites: number | null
  uploadedWithinDays: number | null
  respectBlacklist: boolean
}

interface TagSuggestion {
  id: number
  type: string
  name: string
  count: number
}

const SORTS: Array<{ value: string; label: string }> = [
  { value: 'date', label: 'Newest' },
  { value: 'popular', label: 'Most popular' },
  { value: 'popular-today', label: 'Popular today' },
  { value: 'popular-week', label: 'Popular this week' },
  { value: 'popular-month', label: 'Popular this month' }
]

const LANGUAGES = [
  { value: '', label: 'Any' },
  { value: 'english', label: 'English' },
  { value: 'japanese', label: 'Japanese' },
  { value: 'chinese', label: 'Chinese' }
]

/**
 * `text` is not an nhentai tag type — it is a free-text phrase, matched against
 * the title. The others map straight onto the query syntax's field names.
 */
const BLOCK_TYPES: Array<{ value: BlockedType; label: string }> = [
  { value: 'tag', label: 'Tag' },
  { value: 'artist', label: 'Artist' },
  { value: 'group', label: 'Group' },
  { value: 'parody', label: 'Parody' },
  { value: 'character', label: 'Character' },
  { value: 'language', label: 'Language' },
  { value: 'text', label: 'Text in title' }
]

const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  BLOCK_TYPES.map((t) => [t.value, t.label])
)

// ─── Component ───────────────────────────────────────────────────────────────

export default function SearchSettings(): React.JSX.Element {
  const [settings, setSettings] = useState<SearchSettingsData | null>(null)
  const [blocked, setBlocked] = useState<BlockedRow[]>([])
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ─── Load ──────────────────────────────────────────────────────────────

  const reloadBlocked = useCallback(async () => {
    const r = await window.api.blocked.list()
    if (r.success && Array.isArray(r.data)) setBlocked(r.data as BlockedRow[])
  }, [])

  useEffect(() => {
    // Every setState here happens in a promise callback. Calling reloadBlocked()
    // directly would look synchronous to the linter and cascade a render.
    let cancelled = false
    window.api.searchSettings
      .get()
      .then((r) => {
        if (!cancelled && r.success && r.data) setSettings(r.data as SearchSettingsData)
      })
      .catch(() => {
        if (!cancelled) setError('Could not load search settings.')
      })
    window.api.blocked
      .list()
      .then((r) => {
        if (!cancelled && r.success && Array.isArray(r.data)) setBlocked(r.data as BlockedRow[])
      })
      .catch(() => {
        /* an empty list is a valid state */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // ─── Save ──────────────────────────────────────────────────────────────

  /**
   * Persist immediately on change rather than behind a Save button.
   *
   * The Settings page's Save applies to the panes that hold a form; these are
   * individually meaningful toggles, and a default search you set but forgot to
   * save would look like the feature was broken.
   */
  const patch = useCallback(async (change: Partial<SearchSettingsData>) => {
    setSettings((prev) => (prev ? { ...prev, ...change } : prev))
    try {
      const r = await window.api.searchSettings.set(change)
      if (r.success && r.data) setSettings(r.data as SearchSettingsData)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1500)
    } catch {
      setError('Could not save that change.')
    }
  }, [])

  if (!settings) {
    return <p className="text-sm text-fg-muted">Loading search settings…</p>
  }

  const excludeCount = blocked.filter((b) => b.mode === 'exclude').length
  const dimCount = blocked.filter((b) => b.mode === 'dim').length

  return (
    <div className="space-y-6">
      {error && (
        <Notice tone="error" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}

      {/* ─── Defaults ───────────────────────────────────────────────────── */}

      <section>
        <h2 className="text-section font-semibold text-fg mb-1">Search defaults</h2>
        <p className="text-sm text-fg-muted mb-3">
          Applied every time the Search tab opens. A query you type yourself always wins over these.
        </p>

        <div className="space-y-3">
          <div>
            <label htmlFor="default-query" className="block text-label mb-1 text-fg-muted">
              Default search
            </label>
            <input
              id="default-query"
              type="text"
              value={settings.defaultQuery ?? ''}
              onChange={(e) => patch({ defaultQuery: e.target.value })}
              placeholder='e.g. artist:aiue-oka  or  tag:"full color"'
              className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm text-fg placeholder-fg-faint focus:ring-2 focus:ring-accent"
            />
            <p className="mt-1 text-xs text-fg-faint">
              Supports the site&apos;s own syntax: <code className="font-mono">artist:name</code>,{' '}
              <code className="font-mono">tag:&quot;big breasts&quot;</code>,{' '}
              <code className="font-mono">-word</code> to exclude.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="default-sort" className="block text-label mb-1 text-fg-muted">
                Sort
              </label>
              <select
                id="default-sort"
                value={settings.sort ?? 'date'}
                onChange={(e) => patch({ sort: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm text-fg focus:ring-2 focus:ring-accent"
              >
                {SORTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="default-language" className="block text-label mb-1 text-fg-muted">
                Language
              </label>
              <select
                id="default-language"
                value={settings.language ?? ''}
                onChange={(e) => patch({ language: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm text-fg focus:ring-2 focus:ring-accent"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField
              id="min-pages"
              label="Min pages"
              value={settings.minPages}
              onCommit={(v) => patch({ minPages: v })}
            />
            <NumberField
              id="min-favorites"
              label="Min favourites"
              value={settings.minFavorites}
              onCommit={(v) => patch({ minFavorites: v })}
            />
            <NumberField
              id="uploaded-days"
              label="Uploaded within (days)"
              value={settings.uploadedWithinDays}
              onCommit={(v) => patch({ uploadedWithinDays: v })}
            />
          </div>

          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={settings.respectBlacklist}
              onChange={(e) => patch({ respectBlacklist: e.target.checked })}
              className="mt-0.5 h-4 w-4 rounded border-line text-accent focus:ring-accent"
            />
            <span className="text-sm text-fg">
              Dim galleries nhentai has blacklisted
              <span className="block text-xs text-fg-faint">
                Uses the flag the site already returns with each result, from your account&apos;s
                own blacklist.
              </span>
            </span>
          </label>

          {saved && <p className="text-xs text-success">Saved.</p>}
        </div>
      </section>

      {/* ─── Blocked values ─────────────────────────────────────────────── */}

      <section>
        <h2 className="text-section font-semibold text-fg mb-1">Blocked values</h2>
        <p className="text-sm text-fg-muted mb-3">
          Each entry either keeps galleries out of search results, or lets them through and marks
          them. Blocked values never hide anything in your Library or Favorites — there they only
          change how the tag itself looks.
        </p>

        <AddBlockedValue
          onAdded={async () => {
            await reloadBlocked()
          }}
          onError={setError}
        />

        {blocked.length === 0 ? (
          <p className="mt-4 text-sm text-fg-faint">Nothing blocked yet.</p>
        ) : (
          <>
            <div className="mt-4 mb-2 flex items-center gap-3 text-xs text-fg-faint">
              <span className="tnum">{excludeCount} hidden from search</span>
              <span>·</span>
              <span className="tnum">{dimCount} marked only</span>
            </div>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {blocked.map((row) => (
                <BlockedRowItem key={row.id} row={row} onChanged={setBlocked} onError={setError} />
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  )
}

// ─── Number field ────────────────────────────────────────────────────────────

/**
 * A number input that commits on blur rather than per keystroke.
 *
 * Saving on every keystroke would write "1" on the way to "10" and briefly apply
 * a filter the user never asked for.
 */
function NumberField({
  id,
  label,
  value,
  onCommit
}: {
  id: string
  label: string
  value: number | null
  onCommit: (value: number | null) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value == null ? '' : String(value))
  const [seenValue, setSeenValue] = useState(value)

  // React's documented way to reset state when a prop changes: adjust during
  // render rather than in an effect, which would set state after a paint and
  // cascade a second render.
  if (value !== seenValue) {
    setSeenValue(value)
    setDraft(value == null ? '' : String(value))
  }

  const commit = (): void => {
    const trimmed = draft.trim()
    if (!trimmed) {
      onCommit(null)
      return
    }
    const parsed = Number.parseInt(trimmed, 10)
    onCommit(Number.isFinite(parsed) && parsed > 0 ? parsed : null)
  }

  return (
    <div>
      <label htmlFor={id} className="block text-label mb-1 text-fg-muted">
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={0}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        placeholder="Any"
        className="tnum w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm text-fg placeholder-fg-faint focus:ring-2 focus:ring-accent"
      />
    </div>
  )
}

// ─── One blocked row ─────────────────────────────────────────────────────────

function BlockedRowItem({
  row,
  onChanged,
  onError
}: {
  row: BlockedRow
  onChanged: (rows: BlockedRow[]) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const isExclude = row.mode === 'exclude'

  const setMode = async (mode: BlockedMode): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.blocked.setMode(row.id, mode)
      if (r.success && Array.isArray(r.data)) onChanged(r.data as BlockedRow[])
    } catch {
      onError('Could not change that entry.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.blocked.remove(row.id)
      if (r.success && Array.isArray(r.data)) onChanged(r.data as BlockedRow[])
    } catch {
      onError('Could not remove that entry.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${tagClass(row.type)}`}
      >
        {TYPE_LABEL[row.type] ?? row.type}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-fg" title={row.value}>
        {row.value}
      </span>

      {/*
        Mode as a two-state segmented control rather than a dropdown: there are
        only two, and the difference matters enough to be readable at a glance.
      */}
      <div className="flex shrink-0 overflow-hidden rounded-lg border border-line">
        <button
          onClick={() => setMode('exclude')}
          disabled={busy}
          title="Keep these galleries out of search results entirely"
          className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium transition-colors ${
            isExclude ? 'bg-accent-fill text-white' : 'bg-surface text-fg-muted hover:bg-raised'
          }`}
        >
          <EyeOff size={12} aria-hidden="true" />
          Hide
        </button>
        <button
          onClick={() => setMode('dim')}
          disabled={busy}
          title="Still show them in search, but marked"
          className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium transition-colors ${
            !isExclude ? 'bg-accent-fill text-white' : 'bg-surface text-fg-muted hover:bg-raised'
          }`}
        >
          <Eye size={12} aria-hidden="true" />
          Mark
        </button>
      </div>

      <button
        onClick={remove}
        disabled={busy}
        aria-label={`Remove ${row.value}`}
        className="shrink-0 text-fg-faint transition-colors hover:text-danger disabled:opacity-50"
      >
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </li>
  )
}

// ─── Add dialog ──────────────────────────────────────────────────────────────

function AddBlockedValue({
  onAdded,
  onError
}: {
  onAdded: () => Promise<void>
  onError: (message: string) => void
}): React.JSX.Element {
  const [type, setType] = useState<BlockedType>('tag')
  const [mode, setMode] = useState<BlockedMode>('exclude')
  /** Committed values, shown as chips. */
  const [values, setValues] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([])
  const [busy, setBusy] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Commit the typed value as a chip.
   *
   * Enter-to-commit rather than comma separation, matching the tag editor in the
   * Library. Duplicates are dropped case-insensitively here as well as by the
   * database, so the chip list cannot show two entries that will become one.
   */
  const commitDraft = (raw?: string): void => {
    const candidate = (raw ?? draft).trim()
    if (!candidate) return
    setValues((prev) =>
      prev.some((v) => v.toLowerCase() === candidate.toLowerCase()) ? prev : [...prev, candidate]
    )
    setDraft('')
    setSuggestions([])
  }

  const removeValue = (value: string): void => {
    setValues((prev) => prev.filter((v) => v !== value))
  }

  // Autocomplete against real tags, so a typo cannot become a filter that
  // silently matches nothing. Free text has nothing to autocomplete against.
  useEffect(() => {
    // Deliberately does not clear suggestions on the early exits: that would be
    // a synchronous setState inside the effect. Stale entries cannot show
    // anyway, because rendering is gated on `showSuggestions` below.
    if (type === 'text') return
    if (draft.trim().length < 2) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      window.api.tags
        .autocomplete(draft.trim(), type)
        .then((r) => {
          if (r.success && Array.isArray(r.data)) setSuggestions(r.data as TagSuggestion[])
        })
        .catch(() => setSuggestions([]))
    }, 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [draft, type])

  const showSuggestions = type !== 'text' && draft.trim().length >= 2 && suggestions.length > 0

  const submit = async (): Promise<void> => {
    // Include an uncommitted draft, so pressing Add without pressing Enter first
    // does not silently discard what is in the box.
    const pending = draft.trim()
    const all = pending
      ? values.some((v) => v.toLowerCase() === pending.toLowerCase())
        ? values
        : [...values, pending]
      : values
    if (all.length === 0) return

    setBusy(true)
    try {
      const r = await window.api.blocked.add(all.map((value) => ({ type, value, mode })))
      if (r.success) {
        setValues([])
        setDraft('')
        setSuggestions([])
        await onAdded()
      } else {
        onError('Could not add those values.')
      }
    } catch {
      onError('Could not add those values.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-line bg-raised/40 p-3">
      <h3 className="text-sm font-semibold text-fg mb-2">Add blocked value</h3>

      <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
        <div>
          <label htmlFor="block-type" className="block text-label mb-1 text-fg-muted">
            Type
          </label>
          <select
            id="block-type"
            value={type}
            onChange={(e) => setType(e.target.value as BlockedType)}
            className="w-full px-2 py-2 rounded-lg border border-line bg-surface text-sm text-fg focus:ring-2 focus:ring-accent"
          >
            {BLOCK_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="block-values" className="block text-label mb-1 text-fg-muted">
            Value{values.length > 0 ? `s (${values.length})` : ''}
          </label>

          {/*
            A chip editor: type a value, press Enter to commit it. Matches the tag
            editor in the Library, and it makes a value containing a comma
            expressible, which comma separation could not.
          */}
          <div className="flex min-h-[42px] flex-wrap items-center gap-1 rounded-lg border border-line bg-surface p-2 focus-within:ring-2 focus-within:ring-accent">
            {values.map((value) => (
              <span
                key={value}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tagClass(type)}`}
              >
                {value}
                <button
                  onClick={() => removeValue(value)}
                  aria-label={`Remove ${value}`}
                  className="opacity-70 transition-opacity hover:opacity-100"
                >
                  <X size={10} aria-hidden="true" />
                </button>
              </span>
            ))}

            <input
              id="block-values"
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitDraft()
                } else if (e.key === 'Backspace' && !draft && values.length > 0) {
                  // Backspace on an empty box removes the last chip, as the
                  // Library's tag editor does.
                  removeValue(values[values.length - 1])
                }
              }}
              placeholder={
                values.length === 0
                  ? type === 'text'
                    ? 'A phrase from the title, then Enter…'
                    : 'Type a value, then Enter…'
                  : ''
              }
              // The wrapper's focus-within ring is the one focus indicator here.
              className="focus-ring-container min-w-[8rem] flex-1 bg-transparent text-sm text-fg placeholder-fg-faint"
            />
          </div>

          {showSuggestions && (
            <ul className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-line bg-surface">
              {suggestions.map((s) => (
                <li key={`${s.type}-${s.id}`}>
                  <button
                    onClick={() => commitDraft(s.name)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm text-fg hover:bg-raised"
                  >
                    <span className="truncate">{s.name}</span>
                    <span className="tnum shrink-0 text-xs text-fg-faint">
                      {s.count.toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <fieldset>
          <legend className="text-label mb-1 text-fg-muted">In search results</legend>
          <div className="flex gap-3">
            <label className="flex cursor-pointer items-center gap-1.5 text-sm text-fg">
              <input
                type="radio"
                name="block-mode"
                checked={mode === 'exclude'}
                onChange={() => setMode('exclude')}
                className="text-accent focus:ring-accent"
              />
              Hide the gallery
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-sm text-fg">
              <input
                type="radio"
                name="block-mode"
                checked={mode === 'dim'}
                onChange={() => setMode('dim')}
                className="text-accent focus:ring-accent"
              />
              Show it, but marked
            </label>
          </div>
        </fieldset>

        <Button
          role="primary"
          size="sm"
          icon={busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          onClick={submit}
          disabled={busy || values.length === 0}
        >
          {values.length > 1 ? `Add ${values.length}` : 'Add'}
        </Button>
      </div>
    </div>
  )
}
