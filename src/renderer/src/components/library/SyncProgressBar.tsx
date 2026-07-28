import { useState, useEffect } from 'react'
import { create } from 'zustand'

interface SyncProgressState {
  visible: boolean
  current: number
  total: number
  title: string
  etaSeconds: number | null
  updateProgress: (p: { current: number; total: number; title: string; etaSeconds: number | null }) => void
  complete: (succeeded: number, failed: number, total: number) => void
}

export const useSyncProgressStore = create<SyncProgressState>()((set) => ({
  visible: false,
  current: 0,
  total: 0,
  title: '',
  etaSeconds: null,
  updateProgress: (p) => set({ visible: true, ...p }),
  complete: (succeeded, failed, total) => {
    set({ current: total, title: `Sync complete: ${succeeded} succeeded, ${failed} failed`, etaSeconds: null })
    setTimeout(() => set({ visible: false }), 3000)
  }
}))

// Set up IPC listeners globally (survives tab switches)
let listenersSetup = false
export function setupSyncProgressListeners(): () => void {
  if (listenersSetup) return () => {} // already set up
  listenersSetup = true

  const recentTimes: number[] = []
  let lastUpdate = 0

  const c1 = window.api.onSyncProgress((p) => {
    const now = Date.now()
    if (lastUpdate > 0) {
      const itemTime = (now - lastUpdate) / 1000
      recentTimes.push(itemTime)
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

  const c2 = window.api.onSyncComplete((d) => {
    useSyncProgressStore.getState().complete(d.succeeded, d.failed, d.total)
  })

  return () => {
    c1()
    c2()
    listenersSetup = false
  }
}

export default function SyncProgressBar(): React.JSX.Element | null {
  const store = useSyncProgressStore()
  const [etaDisplay, setEtaDisplay] = useState('')

  useEffect(() => {
    // Set up global listeners on first mount
    const cleanup = setupSyncProgressListeners()
    return () => { cleanup() }
  }, [])

  useEffect(() => {
    if (store.etaSeconds !== null && store.etaSeconds > 0) {
      const m = Math.floor(store.etaSeconds / 60)
      const s = store.etaSeconds % 60
      setEtaDisplay(m > 0 ? `~${m}m ${s}s` : `~${s}s`)
    } else if (store.visible && store.etaSeconds === null) {
      setEtaDisplay('...')
    }
  }, [store.etaSeconds, store.visible])

  if (!store.visible) return null

  const pct = store.total > 0 ? Math.round((store.current / store.total) * 100) : 0

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
        <span>{store.title}</span>
        <span>{store.current}/{store.total} {etaDisplay && `· ${etaDisplay}`}</span>
      </div>
      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
        <div
          className="bg-purple-600 h-2 rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
