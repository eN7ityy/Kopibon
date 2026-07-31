import { useState, useEffect } from 'react'

type State = 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'ready' | 'error'

/**
 * Update state and the restart prompt.
 *
 * `electron-updater` stages an update and applies it on the next quit, so
 * without a visible "ready" state the app simply changed version one day with no
 * explanation. Errors were also swallowed at both call sites, meaning a
 * permanently broken update feed was invisible — including during development,
 * where no published release exists yet and every check fails.
 */
export default function UpdateStatus(): React.JSX.Element {
  const [state, setState] = useState<State>('idle')
  const [version, setVersion] = useState<string | null>(null)
  const [percent, setPercent] = useState(0)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    const off = window.api.onUpdateStatus((s) => {
      setState(s.state)
      if (s.version) setVersion(s.version)
      if (typeof s.percent === 'number') setPercent(s.percent)
      setMessage(s.message ?? null)
    })
    return () => { off() }
  }, [])

  const check = async (): Promise<void> => {
    setState('checking')
    setMessage(null)
    const r = await window.api.app.checkForUpdates()
    // A failed check resolves rather than throwing; the 'error' event usually
    // arrives too, but this covers a rejection that never emits one.
    if (!r?.success) {
      setState('error')
      setMessage(r?.error || 'Update check failed')
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <button
          onClick={check}
          disabled={state === 'checking' || state === 'downloading'}
          className="px-3 py-1.5 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50"
        >
          {state === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>

        {state === 'current' && (
          <span className="text-xs text-green-600 dark:text-green-400">
            You are on the latest version
          </span>
        )}
        {state === 'available' && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            Version {version} found — downloading…
          </span>
        )}
        {state === 'downloading' && (
          <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
            Downloading {percent}%
          </span>
        )}
      </div>

      {state === 'ready' && (
        <div className="p-3 rounded-lg bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 flex items-center justify-between gap-3">
          <span className="text-xs text-indigo-800 dark:text-indigo-300">
            Version {version} is ready. It will be applied when you restart.
          </span>
          <button
            onClick={() => void window.api.app.installUpdate()}
            className="px-3 py-1.5 shrink-0 rounded-lg bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700"
          >
            Restart now
          </button>
        </div>
      )}

      {state === 'error' && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Update check failed: {message}
          {/* Expected until the first GitHub Release is published — the feed
              does not exist yet, so there is nothing to compare against. */}
        </p>
      )}
    </div>
  )
}
