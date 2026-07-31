import { useState, useEffect } from 'react'

interface ToolStatus {
  id: string
  name: string
  ok: boolean
  detail: string
  affects: string
  required: boolean
}

interface ToolchainReport {
  ok: boolean
  tools: ToolStatus[]
  installHint: string
}

/**
 * External dependency status.
 *
 * Python/pikepdf and poppler are not bundled with the app, and without them PDF
 * metadata and PDF → CBZ conversion silently stop working. The only previous
 * signal was a `console.error` at startup, which nobody running a packaged build
 * ever sees — so a fresh install appeared to work while quietly writing PDFs
 * with no title, artist or tags.
 */
export default function ToolchainStatus(): React.JSX.Element {
  const [report, setReport] = useState<ToolchainReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.app
      .checkToolchain(tick > 0)
      .then((r) => {
        if (!cancelled) setReport(r?.success ? (r.data as ToolchainReport) : null)
      })
      .catch(() => {
        if (!cancelled) setReport(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [tick])

  if (loading && !report) {
    return <p className="text-xs text-gray-400 dark:text-gray-500">Checking required tools…</p>
  }

  if (!report) {
    return <p className="text-xs text-red-600 dark:text-red-400">Could not check required tools.</p>
  }

  const missing = report.tools.filter((t) => !t.ok)

  return (
    <div className="space-y-2">
      <div
        className={`p-3 rounded-lg border ${
          report.ok
            ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
            : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'
        }`}
      >
        <div className="flex items-center justify-between gap-2 mb-2">
          <span
            className={`text-sm font-medium ${
              report.ok
                ? 'text-green-800 dark:text-green-300'
                : 'text-amber-800 dark:text-amber-300'
            }`}
          >
            {report.ok
              ? '✓ All required tools found'
              : `⚠️ ${missing.length} required tool${missing.length === 1 ? '' : 's'} missing`}
          </span>
          <button
            onClick={() => { setTick((t) => t + 1); setCopied(false) }}
            className="px-2 py-1 rounded text-xs font-medium bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            Re-check
          </button>
        </div>

        <ul className="space-y-1.5">
          {report.tools.map((t) => (
            <li key={t.id} className="text-xs">
              <div className="flex items-start gap-2">
                <span className={t.ok ? 'text-green-600' : 'text-red-500'}>{t.ok ? '✓' : '✕'}</span>
                <div className="min-w-0">
                  <span className="font-medium text-gray-800 dark:text-gray-200">{t.name}</span>
                  <span className="text-gray-500 dark:text-gray-400"> — {t.detail}</span>
                  {!t.ok && (
                    <p className="text-amber-700 dark:text-amber-400 mt-0.5">{t.affects}</p>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>

        {!report.ok && report.installHint && (
          <div className="mt-3">
            <p className="text-xs text-gray-600 dark:text-gray-400 mb-1">
              Install the missing tools, then press Re-check:
            </p>
            <div className="flex items-start gap-2">
              <code className="flex-1 p-2 rounded bg-gray-900 text-green-400 text-xs font-mono overflow-x-auto whitespace-pre">
                {report.installHint}
              </code>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(report.installHint).then(() => setCopied(true))
                }}
                className="px-2 py-1 shrink-0 rounded text-xs font-medium bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
