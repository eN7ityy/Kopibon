import { create } from 'zustand'
import { JOB_SUMMARY_MS } from './sync-progress.store'

export interface ConversionState {
  running: boolean
  current: number
  total: number
  converted: number
  failed: number
  etaSeconds: number
  logLines: string[]
  startTime: number | null
  /**
   * Terminal summary, matching the other job stores. This job previously ended
   * silently outside the Settings log pane, so a user watching from the library
   * never learned whether it had finished or failed.
   */
  lastMessage: string | null

  setRunning: (running: boolean) => void
  /** Record the outcome and clear the summary after the shared delay. */
  finish: (summary: string) => void
  updateProgress: (data: {
    current: number
    total: number
    converted: number
    failed: number
    logLines?: string[]
  }) => void
  addLogLine: (line: string) => void
  reset: () => void
}

export const useConversionStore = create<ConversionState>()((set, get) => ({
  running: false,
  current: 0,
  total: 0,
  converted: 0,
  failed: 0,
  etaSeconds: 0,
  logLines: [],
  startTime: null,
  lastMessage: null,

  setRunning: (running) =>
    set({
      running,
      startTime: running ? Date.now() : null,
      lastMessage: running ? null : get().lastMessage
    }),

  finish: (summary) => {
    set({ running: false, etaSeconds: 0, lastMessage: summary })
    setTimeout(() => {
      if (!useConversionStore.getState().running) {
        useConversionStore.setState({ lastMessage: null, current: 0, total: 0 })
      }
    }, JOB_SUMMARY_MS)
  },

  updateProgress: (data) => {
    const state = get()
    // Calculate ETA
    const elapsed = state.startTime ? (Date.now() - state.startTime) / 1000 : 0
    const eta =
      data.current > 0
        ? Math.round((elapsed / data.current) * (data.total - data.current))
        : 0

    set({
      current: data.current,
      total: data.total,
      converted: data.converted,
      failed: data.failed,
      etaSeconds: eta,
      logLines: data.logLines
        ? [...state.logLines, ...data.logLines]
        : state.logLines
    })
  },

  addLogLine: (line) =>
    set((s) => ({
      logLines: [...s.logLines, line].slice(-200) // Keep last 200 lines
    })),

  reset: () =>
    set({
      running: false,
      current: 0,
      total: 0,
      converted: 0,
      failed: 0,
      etaSeconds: 0,
      logLines: [],
      startTime: null,
      lastMessage: null
    })
}))
