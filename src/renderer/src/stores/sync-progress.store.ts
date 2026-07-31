import { create } from 'zustand'

/**
 * Progress for "Sync with Nhentai".
 *
 * Moved out of `SyncProgressBar.tsx` so every job store lives in one place and
 * the presentation is a single shared component. Listener registration is at
 * module scope, not per mount, so a long batch keeps reporting across tab
 * switches.
 */
export interface SyncProgressState {
  running: boolean
  current: number
  total: number
  title: string
  etaSeconds: number | null
  /** Terminal summary, shown briefly after the run ends. */
  lastMessage: string | null

  updateProgress: (p: {
    current: number
    total: number
    title: string
    etaSeconds: number | null
  }) => void
  complete: (succeeded: number, failed: number, total: number) => void
  reset: () => void
}

/** How long a finished job's summary stays on screen, shared by all job stores. */
export const JOB_SUMMARY_MS = 6000

export const useSyncProgressStore = create<SyncProgressState>()((set) => ({
  running: false,
  current: 0,
  total: 0,
  title: '',
  etaSeconds: null,
  lastMessage: null,

  updateProgress: (p) => set({ running: true, lastMessage: null, ...p }),

  complete: (succeeded, failed, total) => {
    const parts = [`${succeeded} succeeded`]
    if (failed > 0) parts.push(`${failed} failed`)
    set({
      running: false,
      current: total,
      total,
      etaSeconds: null,
      lastMessage: `Sync complete: ${parts.join(', ')}`
    })
    setTimeout(() => {
      if (!useSyncProgressStore.getState().running) {
        useSyncProgressStore.setState({ lastMessage: null, current: 0, total: 0, title: '' })
      }
    }, JOB_SUMMARY_MS)
  },

  reset: () =>
    set({ running: false, current: 0, total: 0, title: '', etaSeconds: null, lastMessage: null })
}))

let listenersSetup = false

export function setupSyncProgressListeners(): () => void {
  if (listenersSetup) return () => {}
  listenersSetup = true

  // ETA from observed per-item throughput, smoothed over the last few items —
  // sync cost varies with gallery size and rate limiting.
  const recentTimes: number[] = []
  let lastUpdate = 0

  const offProgress = window.api.onSyncProgress((p) => {
    const now = Date.now()
    if (lastUpdate > 0) {
      recentTimes.push((now - lastUpdate) / 1000)
      if (recentTimes.length > 5) recentTimes.shift()
    }
    lastUpdate = now

    let eta: number | null = null
    if (recentTimes.length > 0) {
      const avg = recentTimes.reduce((a, b) => a + b, 0) / recentTimes.length
      eta = Math.round(avg * (p.total - p.current))
    }

    useSyncProgressStore.getState().updateProgress({ ...p, etaSeconds: eta })
  })

  const offComplete = window.api.onSyncComplete((d) => {
    recentTimes.length = 0
    lastUpdate = 0
    useSyncProgressStore.getState().complete(d.succeeded, d.failed, d.total)
  })

  return () => {
    offProgress()
    offComplete()
    listenersSetup = false
  }
}
