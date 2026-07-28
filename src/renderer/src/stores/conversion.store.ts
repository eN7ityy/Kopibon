import { create } from 'zustand'

export interface ConversionState {
  running: boolean
  current: number
  total: number
  converted: number
  failed: number
  etaSeconds: number
  logLines: string[]
  startTime: number | null

  setRunning: (running: boolean) => void
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

  setRunning: (running) =>
    set({
      running,
      startTime: running ? Date.now() : null
    }),

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
      startTime: null
    })
}))
