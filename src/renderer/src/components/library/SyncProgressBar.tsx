import { useState, useEffect } from 'react'

export default function SyncProgressBar(): React.JSX.Element | null {
  const [visible, setVisible] = useState(false)
  const [current, setCurrent] = useState(0)
  const [total, setTotal] = useState(0)
  const [statusText, setStatusText] = useState('')
  const [etaText, setEtaText] = useState('')

  useEffect(() => {
    const cleanup1 = window.api.onSyncProgress((p) => {
      setVisible(true)
      setCurrent(p.current)
      setTotal(p.total)
      setStatusText(`Syncing ${p.current} of ${p.total}: ${p.title}`)
      if (p.etaSeconds != null) {
        const mins = Math.floor(p.etaSeconds / 60)
        const secs = p.etaSeconds % 60
        setEtaText(mins > 0 ? `${mins}m ${secs}s remaining` : `${secs}s remaining`)
      } else {
        setEtaText('Calculating...')
      }
    })

    const cleanup2 = window.api.onSyncComplete((_data) => {
      setCurrent(total)
      setStatusText(`Sync complete: ${_data.succeeded} succeeded, ${_data.failed} failed`)
      setTimeout(() => {
        setVisible(false)
      }, 2000)
    })

    return () => {
      cleanup1()
      cleanup2()
    }
  }, [total])

  if (!visible) return null

  const pct = total > 0 ? Math.round((current / total) * 100) : 0

  return (
    <div className="sticky top-0 z-40 bg-white dark:bg-gray-800 border-b border-orange-200 dark:border-orange-800 shadow-sm">
      <div className="px-4 py-2 space-y-1">
        <div className="flex justify-between items-center">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{statusText}</span>
          <span className="text-xs text-gray-500">{etaText}</span>
        </div>
        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
          <div
            className="bg-green-500 h-2 rounded-full transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  )
}
