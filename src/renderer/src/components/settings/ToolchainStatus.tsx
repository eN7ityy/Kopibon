import { useState, useEffect } from 'react'
import { Check, X } from 'lucide-react'

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
    return <p className="text-xs text-fg-faint">Checking required tools…</p>
  }

  if (!report) {
    return <p className="text-xs text-danger">Could not check required tools.</p>
  }

  const missing = report.tools.filter((t) => !t.ok)

  return (
    <div className="space-y-2">
      <div
        className={`p-3 rounded-lg border ${
          report.ok
            ? 'bg-success-wash border-success'
            : 'bg-warning-wash border-warning'
        }`}
      >
        <div className="flex items-center justify-between gap-2 mb-2">
          <span
            className={`text-sm font-medium ${
              report.ok
                ? 'text-success'
                : 'text-warning'
            }`}
          >
            {report.ok
              ? 'All required tools found'
              : `${missing.length} required tool${missing.length === 1 ? '' : 's'} missing`}
          </span>
          <button
            onClick={() => { setTick((t) => t + 1); setCopied(false) }}
            className="px-2 py-1 rounded text-xs font-medium bg-surface border border-line text-fg hover:bg-raised"
          >
            Re-check
          </button>
        </div>

        <ul className="space-y-1.5">
          {report.tools.map((t) => (
            <li key={t.id} className="text-xs">
              <div className="flex items-start gap-2">
                <span className={t.ok ? 'text-success' : 'text-danger'}>{t.ok ? <Check size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />}</span>
                <div className="min-w-0">
                  <span className="font-medium text-fg">{t.name}</span>
                  <span className="text-fg-muted"> — {t.detail}</span>
                  {!t.ok && (
                    <p className="text-warning mt-0.5">{t.affects}</p>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>

        {!report.ok && report.installHint && (
          <div className="mt-3">
            <p className="text-xs text-fg-muted mb-1">
              Install the missing tools, then press Re-check:
            </p>
            <div className="flex items-start gap-2">
              <code className="flex-1 p-2 rounded bg-app text-fg text-xs font-mono overflow-x-auto whitespace-pre">
                {report.installHint}
              </code>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(report.installHint).then(() => setCopied(true))
                }}
                className="px-2 py-1 shrink-0 rounded text-xs font-medium bg-surface border border-line text-fg hover:bg-raised"
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
