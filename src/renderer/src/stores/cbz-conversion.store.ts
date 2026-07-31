import { create } from 'zustand'

/**
 * PDF → CBZ conversion state.
 *
 * Separate from `conversion.store.ts`, which tracks the unrelated
 * "Convert Library Metadata" job in Settings. Both can be running, and
 * conflating them would disable the wrong buttons.
 *
 * The per-item sets are the important part: the main process refuses metadata
 * edits, deletes, series assignment and sync on an item while it is converting,
 * so the UI has to know exactly which rows are locked. A component that only
 * knew "a conversion is running" would either offer edits the main process
 * rejects, or lock the entire library for one file.
 */
export interface CbzConversionState {
  running: boolean
  current: number
  total: number
  converted: number
  failed: number
  skipped: number
  etaSeconds: number | null
  /** Items in a worker right now. */
  activeIds: Set<number>
  /** Items claimed for this batch but not yet started. */
  queuedIds: Set<number>
  startedAt: number | null
  lastMessage: string | null

  update: (p: {
    current: number
    total: number
    converted: number
    failed: number
    skipped?: number
    running?: boolean
    activeIds?: number[]
    queuedIds?: number[]
  }) => void
  /** Adopt state from the main process — used when a view mounts mid-run. */
  hydrate: (s: { running: boolean; activeIds: number[]; queuedIds: number[] }) => void
  begin: (total: number) => void
  finish: () => void
  reset: () => void
}

const EMPTY = {
  running: false,
  current: 0,
  total: 0,
  converted: 0,
  failed: 0,
  skipped: 0,
  etaSeconds: null,
  activeIds: new Set<number>(),
  queuedIds: new Set<number>(),
  startedAt: null,
  lastMessage: null
}

export const useCbzConversionStore = create<CbzConversionState>()((set, get) => ({
  ...EMPTY,

  begin: (total) =>
    set({ ...EMPTY, running: true, total, startedAt: Date.now(), activeIds: new Set(), queuedIds: new Set() }),

  update: (p) => {
    const s = get()
    // ETA from observed throughput rather than a fixed guess — item cost varies
    // hugely with page count and whether the lossy fallback ran.
    const elapsed = s.startedAt ? (Date.now() - s.startedAt) / 1000 : 0
    const eta =
      p.current > 0 && elapsed > 0
        ? Math.max(0, Math.round((elapsed / p.current) * (p.total - p.current)))
        : null

    set({
      running: p.running !== false,
      current: p.current,
      total: p.total,
      converted: p.converted,
      failed: p.failed,
      skipped: p.skipped ?? s.skipped,
      etaSeconds: eta,
      activeIds: p.activeIds ? new Set(p.activeIds) : s.activeIds,
      queuedIds: p.queuedIds ? new Set(p.queuedIds) : s.queuedIds
    })
  },

  hydrate: (s) =>
    set((prev) => ({
      running: s.running,
      activeIds: new Set(s.activeIds),
      queuedIds: new Set(s.queuedIds),
      // Keep any counts we already have; the main process does not retain them.
      total: prev.total || s.activeIds.length + s.queuedIds.length
    })),

  finish: () => {
    const s = get()
    const parts = [`${s.converted} converted`]
    if (s.failed > 0) parts.push(`${s.failed} failed`)
    if (s.skipped > 0) parts.push(`${s.skipped} skipped (not PDF)`)
    set({
      running: false,
      activeIds: new Set(),
      queuedIds: new Set(),
      etaSeconds: null,
      lastMessage: `Conversion complete: ${parts.join(', ')}`
    })
    // Leave the summary up briefly, then clear it.
    setTimeout(() => {
      if (!useCbzConversionStore.getState().running) {
        useCbzConversionStore.setState({ lastMessage: null, current: 0, total: 0 })
      }
    }, 6000)
  },

  reset: () => set({ ...EMPTY, activeIds: new Set(), queuedIds: new Set() })
}))

/** True when this item is mid-conversion or waiting for a runner. */
export function useIsConverting(id: number | null | undefined): boolean {
  return useCbzConversionStore((s) =>
    id == null ? false : s.activeIds.has(id) || s.queuedIds.has(id)
  )
}

/**
 * Register the progress listener once, at module scope rather than per mount.
 *
 * A batch over thousands of files runs for hours; the user will navigate away.
 * Binding this to a component's lifecycle would drop progress — and, worse, drop
 * the per-item lock state, leaving cards editable while their files are being
 * rewritten. Lives in the store rather than beside the component so the
 * component file exports only components (react-refresh).
 */
let listenersSetup = false

export function setupCbzConversionListeners(): () => void {
  if (listenersSetup) return () => {}
  listenersSetup = true

  const off = window.api.onConvertToCbzProgress((p) => {
    const store = useCbzConversionStore.getState()
    store.update(p)
    if (p.running === false) store.finish()
  })

  return () => {
    off()
    listenersSetup = false
  }
}
