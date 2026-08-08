import { useState, useEffect, useMemo, useRef, useCallback } from 'react'

interface LogRecord {
  ts: string
  level: 'error' | 'warn' | 'info' | 'debug'
  scope: string
  msg: string
  errorId?: string
  jobId?: string
  err?: { name: string; message: string; stack?: string }
}

// ─── Types ───────────────────────────────────────────────────────────────────

type LogLevel = 'error' | 'warn' | 'info' | 'debug'

interface LogApi {
  getRecords: () => Promise<{ success: boolean; data?: LogRecord[] }>
  setLevel: (level: string) => Promise<{ success: boolean }>
  getLevel: () => Promise<{ success: boolean; data?: string }>
  setRetention: (days: number) => Promise<{ success: boolean }>
  getRetention: () => Promise<{ success: boolean; data?: number }>
  openFolder: () => Promise<void>
  exportDiagnostics: () => Promise<{
    success: boolean
    data?: { path: string }
  }>
}

function getLogApi(): LogApi {
  return (window as unknown as { api: { log: LogApi } }).api.log
}

const LEVEL_NAMES: LogLevel[] = ['error', 'warn', 'info', 'debug']

/**
 * Severity order, lowest first — mirrors `LEVEL_PRIORITY` in the main-process
 * logger. Needed here too because the level control filters what is currently
 * on screen, not just what gets written from now on (see `handleSetLevel`).
 */
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
}

/**
 * How many lines the panel shows by default.
 *
 * A short tail rather than a scrolling window: this is a glance at what the app
 * is doing, and anything more than that is better read in the log file itself,
 * which "Open log folder" reaches. The full history is still in the ring buffer
 * and still exported by the diagnostics bundle.
 *
 * Adjustable from the panel itself but never persisted — like the level and
 * retention controls, it is process-lifetime only and starts back at the
 * default the next time Settings is opened.
 */
const DEFAULT_TAIL_LINES = 10
const TAIL_LINE_OPTIONS = [10, 25, 50, 100, 250, 500, 1000, 2000]

const LEVEL_COLORS: Record<LogLevel, string> = {
  error: 'text-danger bg-danger-wash',
  warn: 'text-warning bg-warning-wash',
  info: 'text-info bg-info-wash',
  debug: 'text-fg-muted bg-raised'
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function LogsPage(): React.JSX.Element {
  const [records, setRecords] = useState<LogRecord[]>([])
  const [currentLevel, setCurrentLevel] = useState<LogLevel>('info')
  const [retentionDays, setRetentionDays] = useState(14)
  const [tailLines, setTailLines] = useState(DEFAULT_TAIL_LINES)

  // Filters
  const [filterScope, setFilterScope] = useState('')
  const [filterText, setFilterText] = useState('')

  const [autoRefresh, setAutoRefresh] = useState(true)
  const [exporting, setExporting] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const api = getLogApi()

  // ─── Data loading ──────────────────────────────────────────────────────

  const loadRecords = useCallback(async () => {
    try {
      const r = await api.getRecords()
      if (r.success && r.data) setRecords(r.data)
    } catch {
      /* log viewer unavailable */
    }
  }, [])

  useEffect(() => {
    // State is only ever set from a promise callback here. Calling loadRecords()
    // directly would set state synchronously inside the effect and cascade a
    // render; the cancelled flag also keeps a late response from writing to an
    // unmounted panel.
    let cancelled = false
    api
      .getRecords()
      .then((r) => {
        if (!cancelled && r.success && r.data) setRecords(r.data)
      })
      .catch(() => {
        /* log viewer unavailable */
      })
    api.getLevel().then((r) => {
      if (!cancelled && r.success && r.data) setCurrentLevel(r.data as LogLevel)
    })
    api.getRetention().then((r) => {
      if (!cancelled && r.success && typeof r.data === 'number') setRetentionDays(r.data)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Auto-refresh
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(loadRecords, 2000)
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [autoRefresh, loadRecords])

  // Scroll to bottom on new records
  useEffect(() => {
    if (scrollRef.current && autoRefresh) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [records, autoRefresh])

  // ─── Filtering ─────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    return records.filter((r) => {
      // Same threshold the level control sets on the backend — a record
      // already in the buffer below the current floor is hidden too, so
      // raising the level has a visible effect immediately rather than only
      // once new records arrive.
      if (LEVEL_PRIORITY[r.level] < LEVEL_PRIORITY[currentLevel]) return false
      if (filterScope && !r.scope.includes(filterScope)) return false
      if (filterText) {
        const msg = r.msg.toLowerCase()
        const txt = filterText.toLowerCase()
        if (!msg.includes(txt)) {
          // Also search errorId
          if (r.errorId && !r.errorId.toLowerCase().includes(txt)) return false
          if (!r.errorId) return false
        }
      }
      return true
    })
  }, [records, currentLevel, filterScope, filterText])

  // ─── Scopes for autocomplete ───────────────────────────────────────────

  const scopes = useMemo(() => {
    const set = new Set<string>()
    for (const r of records) set.add(r.scope)
    return [...set].sort()
  }, [records])

  // ─── Handlers ──────────────────────────────────────────────────────────

  /**
   * Set the level floor.
   *
   * Does two things, both from one selection: tells the backend not to
   * bother recording anything below this severity from now on, and — since
   * `filtered` above reads `currentLevel` too — immediately hides whatever is
   * already on screen that falls below it. Previously only the first half
   * happened, so picking "Error" changed nothing the user could see until an
   * actual error occurred, which read as the control doing nothing at all.
   */
  const handleSetLevel = async (level: LogLevel): Promise<void> => {
    setCurrentLevel(level)
    await api.setLevel(level)
  }

  const handleSetRetention = async (
    days: number
  ): Promise<void> => {
    setRetentionDays(days)
    await api.setRetention(days)
  }

  const handleOpenFolder = (): void => {
    api.openFolder().catch(() => {
      /* shell not available */
    })
  }

  const handleExport = async (): Promise<void> => {
    setExporting(true)
    try {
      await api.exportDiagnostics()
    } catch {
      /* export failed */
    } finally {
      setExporting(false)
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────

  return (
    <section>
      <h2 className="text-section font-semibold text-fg mb-3">
        Application Log
      </h2>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        {/* Level selector */}
        <div className="flex items-center gap-1">
          <label className="text-xs text-fg-muted mr-1">
            Level:
          </label>
          <select
            value={currentLevel}
            onChange={(e) =>
              handleSetLevel(e.target.value as LogLevel)
            }
            className="px-2 py-1 text-xs rounded border border-line bg-surface text-fg"
          >
            {LEVEL_NAMES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>

        {/* Retention */}
        <div className="flex items-center gap-1">
          <label className="text-xs text-fg-muted mr-1">
            Keep:
          </label>
          <select
            value={retentionDays}
            onChange={(e) =>
              handleSetRetention(Number(e.target.value))
            }
            className="px-2 py-1 text-xs rounded border border-line bg-surface text-fg"
          >
            {[1, 3, 7, 14, 30, 60, 90, 180, 365].map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </div>

        {/* Tail length — adjustable, never persisted (see DEFAULT_TAIL_LINES) */}
        <div className="flex items-center gap-1">
          <label className="text-xs text-fg-muted mr-1">
            Show:
          </label>
          <select
            value={tailLines}
            onChange={(e) => setTailLines(Number(e.target.value))}
            className="px-2 py-1 text-xs rounded border border-line bg-surface text-fg"
          >
            {TAIL_LINE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} lines
              </option>
            ))}
          </select>
        </div>

        {/* Separator */}
        <span className="text-fg-faint">|</span>

        <button
          onClick={handleOpenFolder}
          className="px-3 py-1 text-xs rounded-lg border border-line bg-surface text-fg hover:bg-raised transition-colors"
        >
          Open log folder
        </button>

        <button
          onClick={handleExport}
          disabled={exporting}
          className="px-3 py-1 text-xs rounded-lg bg-accent-fill text-white font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors"
        >
          {exporting ? 'Exporting...' : 'Export diagnostics'}
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input
          type="text"
          value={filterScope}
          onChange={(e) => setFilterScope(e.target.value)}
          placeholder="Filter scope..."
          list="scope-list"
          className="w-40 px-2 py-1 text-xs rounded border border-line bg-surface text-fg placeholder-fg-faint"
        />
        <datalist id="scope-list">
          {scopes.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>

        <input
          type="text"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="Search messages..."
          className="flex-1 min-w-[160px] px-2 py-1 text-xs rounded border border-line bg-surface text-fg placeholder-fg-faint"
        />

        <label className="flex items-center gap-1 text-xs text-fg-muted">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="w-3 h-3 rounded border-line text-accent"
          />
          Auto
        </label>

        <span className="tnum text-xs text-fg-faint">
          {filtered.length > tailLines
            ? `last ${tailLines} of ${filtered.length}`
            : `${filtered.length} of ${records.length}`}
        </span>
      </div>

      {/* Log tail */}
      <div
        ref={scrollRef}
        className="overflow-hidden rounded-lg bg-app font-mono text-xs leading-relaxed"
      >
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-fg-muted">
            {records.length === 0
              ? 'No log records yet.'
              : 'No records match the current filters.'}
          </div>
        ) : (
          filtered.slice(-tailLines).map((r, i) => (
            <div
              key={`${r.ts}-${i}`}
              className="flex items-start gap-2 px-3 py-0.5 hover:bg-raised border-b border-line last:border-b-0"
            >
              {/* Timestamp */}
              <span className="text-fg-muted shrink-0 w-[140px]">
                {r.ts.slice(0, 19).replace('T', ' ')}
              </span>

              {/* Level dot + label */}
              <span
                className={`shrink-0 w-12 text-center rounded px-1 text-label font-semibold ${LEVEL_COLORS[r.level]}`}
              >
                {r.level}
              </span>

              {/* Scope */}
              <span className="text-fg-faint shrink-0 max-w-[120px] truncate">
                {r.scope}
              </span>

              {/* Message + errorId */}
              <span className="flex-1 min-w-0">
                <span
                  className={
                    r.level === 'error'
                      ? 'text-danger'
                      : r.level === 'warn'
                        ? 'text-warning'
                        : 'text-success'
                  }
                >
                  {r.msg}
                </span>
                {r.errorId && (
                  <span className="ml-2 text-accent font-mono">
                    [{r.errorId}]
                  </span>
                )}
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
