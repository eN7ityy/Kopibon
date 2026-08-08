import { useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import { useSettingsStore } from '../../stores/settings.store'
import Button from '../shared/Button'
import Notice from '../shared/Notice'

interface ScanProgress {
  current: number
  total: number
  status: string
}

/**
 * Step 6 — Summary.
 *
 * Shows a checklist of what was configured (✓) and what was skipped (✗). If
 * the scan checkbox was checked in step 2, a library scan is triggered on
 * mount and its live progress is shown using the same events LibraryPage
 * subscribes to. The scan runs in the background — "Start using Kopibon" is
 * never disabled, and the scan keeps running after the wizard unmounts.
 */
export default function StepSummary({
  onFinish,
  nhentaiConfigured,
  kavitaConfigured,
  scanAfterSetup
}: {
  onFinish: () => void
  nhentaiConfigured: boolean
  kavitaConfigured: boolean
  scanAfterSetup: boolean
}): React.JSX.Element {
  const settings = useSettingsStore()
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanDone, setScanDone] = useState<{ newItems: number; total: number } | null>(null)

  const libraryPath = settings.libraryPath
  const thumbnailPath = settings.thumbnailPath

  useEffect(() => {
    if (!scanAfterSetup || !libraryPath.trim()) return undefined

    const unsubProgress = window.api.onLibraryScanProgress((p) => {
      setProgress(p)
      setScanError(null)
    })
    const unsubComplete = window.api.onLibraryScanComplete((r) => {
      setScanning(false)
      setProgress(null)
      setScanDone({ newItems: r.newItems, total: r.total })
    })
    const unsubError = window.api.onLibraryScanError((err) => {
      setScanning(false)
      setProgress(null)
      setScanError(err)
    })

    setScanning(true)
    setProgress({ current: 0, total: 0, status: 'Starting scan…' })
    window.api.library
      .scan(libraryPath)
      .then((r) => {
        if (!r?.success) {
          setScanning(false)
          setScanError(r?.error || 'Failed to start scan')
        }
      })
      .catch((err) => {
        setScanning(false)
        setScanError(String(err))
      })

    return () => {
      unsubProgress()
      unsubComplete()
      unsubError()
    }
  }, [scanAfterSetup, libraryPath])

  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : 0

  return (
    <div>
      <h2 className="text-2xl font-bold tracking-tight text-fg">You're all set!</h2>

      <div className="mt-6 space-y-2">
        <ChecklistRow
          ok={Boolean(libraryPath.trim())}
          label="Library"
          value={libraryPath.trim() || 'Not set'}
        />
        <ChecklistRow
          ok
          label="Thumbnails"
          value={thumbnailPath.trim() ? thumbnailPath : '(default)'}
        />
        <ChecklistRow
          ok={nhentaiConfigured}
          label="nhentai"
          value={nhentaiConfigured ? 'Connected' : 'Skipped'}
        />
        <ChecklistRow
          ok={kavitaConfigured}
          label="Kavita"
          value={kavitaConfigured ? 'Connected' : 'Skipped'}
        />
      </div>

      {scanning && (
        <div className="mt-6">
          <div className="flex items-center justify-between gap-3 mb-1.5">
            <span className="text-sm font-medium text-fg">
              {progress?.status || 'Scanning library…'}
            </span>
            {progress && progress.total > 0 && (
              <span className="text-xs tabular-nums text-fg-muted">
                {progress.current} / {progress.total} files
              </span>
            )}
          </div>
          <div className="w-full bg-accent-wash rounded-full h-2 overflow-hidden">
            <div
              className="h-2 rounded-full bg-accent-fill transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
      {scanDone && (
        <p className="mt-4 text-sm text-success">
          Scan complete — {scanDone.newItems} new items found ({scanDone.total} total).
        </p>
      )}
      {scanError && (
        <div className="mt-4">
          <Notice tone="error">{scanError}</Notice>
        </div>
      )}

      <p className="mt-6 text-sm text-fg-muted">
        New files will appear in the Library as they are found. You can start using the app right
        away.
      </p>

      <div className="mt-8 flex justify-end">
        <Button role="primary" onClick={onFinish}>
          Start using Kopibon
        </Button>
      </div>
    </div>
  )
}

function ChecklistRow({
  ok,
  label,
  value
}: {
  ok: boolean
  label: string
  value: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3">
      {ok ? (
        <Check size={16} className="text-success shrink-0" aria-hidden="true" />
      ) : (
        <X size={16} className="text-fg-faint shrink-0" aria-hidden="true" />
      )}
      <span className="w-24 shrink-0 text-sm font-medium text-fg">{label}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-fg-muted font-mono">{value}</span>
    </div>
  )
}
