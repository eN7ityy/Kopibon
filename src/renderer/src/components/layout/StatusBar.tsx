import { useState, useEffect } from 'react'
import { ExternalLink } from 'lucide-react'

export default function StatusBar(): React.JSX.Element {
  const [activeCount, setActiveCount] = useState(0)
  const [queuedCount, setQueuedCount] = useState(0)
  const [libraryCount, setLibraryCount] = useState(0)
  const [version, setVersion] = useState<string | null>(null)

  // Read the real app version instead of a hardcoded string that silently
  // goes stale on every release.
  useEffect(() => {
    let cancelled = false
    window.api.app
      .getVersion()
      .then((r) => {
        if (!cancelled && r.success && r.data) setVersion(r.data as string)
      })
      .catch(() => {
        /* the version label is cosmetic */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const poll = async () => {
      try {
        const [countsResult, libResult] = await Promise.all([
          window.api.downloads.getStatusCounts(),
          window.api.library.count()
        ])
        if (countsResult.success && countsResult.data) {
          setActiveCount(countsResult.data.active)
          setQueuedCount(countsResult.data.queued)
        }
        if (libResult.success && typeof libResult.data === 'number') {
          setLibraryCount(libResult.data)
        }
      } catch {
        // Silently ignore polling errors
      }
    }

    poll()
    const interval = setInterval(poll, 2000)
    return () => clearInterval(interval)
  }, [])

  const handleOpenNhentai = async (): Promise<void> => {
    try {
      await window.api.shell.openExternal('https://nhentai.net')
    } catch {
      // Silently ignore — shell.openExternal may fail in restricted environments
    }
  }

  return (
    <footer className="flex items-center h-8 px-4 border-t border-line bg-chrome text-xs text-fg-muted select-none">
      {/*
        Three counts, each with its own label rather than one run of middot-
        separated text. The figures are tabular: these poll every two seconds,
        and proportional digits made the whole bar shift width as they changed,
        which is visible motion in the corner of the eye.
      */}
      <div className="flex items-center gap-4">
        <Stat value={activeCount} label="active" accent={activeCount > 0} />
        <Stat value={queuedCount} label="queued" />
        <Stat value={libraryCount} label="in library" />
      </div>

      <span className="ml-auto flex items-center gap-3">
        <button
          onClick={handleOpenNhentai}
          className="inline-flex items-center gap-1 hover:text-accent transition-colors cursor-pointer"
          title="Open nhentai.net in browser"
        >
          nhentai.net
          <ExternalLink size={11} aria-hidden="true" />
        </button>
        {version && <span className="tnum text-fg-faint">v{version}</span>}
      </span>
    </footer>
  )
}

/**
 * One count in the status bar. The accent is used only when something is
 * actually running, so a glance at the bar tells you whether the app is busy
 * without reading the numbers.
 */
function Stat({
  value,
  label,
  accent = false
}: {
  value: number
  label: string
  accent?: boolean
}): React.JSX.Element {
  return (
    <span className="flex items-baseline gap-1">
      <span className={`tnum font-semibold ${accent ? 'text-accent' : 'text-fg'}`}>{value}</span>
      <span className="text-fg-faint">{label}</span>
    </span>
  )
}
