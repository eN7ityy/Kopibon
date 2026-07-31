import { formatEta } from './format'
import type { ProgressJob, JobTone } from '../../stores/job-progress'

/**
 * The single progress bar used everywhere in the app.
 *
 * Replaces five hand-rolled variants that differed in colour, label placement
 * and which facts they bothered to show. One shape, one set of rules:
 * label left, counts right, bar underneath.
 */

const TONE: Record<JobTone, { fill: string; track: string; text: string; box: string }> = {
  read: {
    fill: 'bg-accent-fill',
    track: 'bg-accent-wash',
    text: 'text-accent',
    box: 'bg-accent-wash border-accent'
  },
  write: {
    fill: 'bg-accent-fill',
    track: 'bg-accent-wash',
    text: 'text-accent',
    box: 'bg-accent-wash border-accent'
  },
  danger: {
    fill: 'bg-danger-fill',
    track: 'bg-danger-wash',
    text: 'text-danger',
    box: 'bg-danger-wash border-danger'
  }
}

interface ProgressBarProps extends ProgressJob {
  /**
   * `card` for page-level jobs (bordered, tinted, cancellable);
   * `inline` for progress inside a list row, where a box would be noise.
   */
  variant?: 'card' | 'inline'
}

export default function ProgressBar({
  label,
  current,
  total,
  detail,
  etaSeconds,
  tone = 'read',
  note,
  onCancel,
  done = false,
  variant = 'card'
}: ProgressBarProps): React.JSX.Element {
  const t = TONE[tone]
  // total === 0 means "working, count unknown". The old scan bar faked this with
  // a hardcoded 10% fill, which looked like stalled progress rather than motion.
  const indeterminate = !done && total <= 0
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0
  const eta = formatEta(etaSeconds)

  const counts = done
    ? ''
    : [total > 0 ? `${current}/${total}` : null, detail, eta]
        .filter(Boolean)
        .join(' · ')

  const body = (
    <>
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <div className={`flex items-center gap-2 min-w-0 ${variant === 'card' ? t.text : 'text-fg-muted'}`}>
          {!done && variant === 'card' && (
            <span className={`w-3.5 h-3.5 shrink-0 border-2 ${t.fill.replace('bg-', 'border-')} border-t-transparent rounded-full animate-spin`} />
          )}
          <span className={`truncate ${variant === 'card' ? 'text-sm font-medium' : 'text-xs'}`}>
            {label}
          </span>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {counts && (
            <span className={`text-xs tabular-nums ${variant === 'card' ? t.text : 'text-fg-muted'}`}>
              {counts}
            </span>
          )}
          {onCancel && !done && (
            <button
              onClick={onCancel}
              // Every cancellable job in this app stops after the work in flight
              // finishes — killing a worker mid-write is how files get truncated.
              title="Stop after the work currently in progress finishes"
              className="px-2 py-1 rounded text-xs font-medium bg-surface border border-line text-fg hover:bg-raised"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {!done && (
        <div className={`w-full ${t.track} rounded-full h-2 overflow-hidden`}>
          {indeterminate ? (
            <div className={`h-2 w-1/3 rounded-full ${t.fill} animate-progress-indeterminate`} />
          ) : (
            <div
              className={`h-2 rounded-full ${t.fill} transition-all duration-300`}
              style={{ width: `${pct}%` }}
            />
          )}
        </div>
      )}

      {note && !done && (
        <p className={`mt-1.5 text-xs opacity-80 ${t.text}`}>{note}</p>
      )}
    </>
  )

  if (variant === 'inline') return <div className="space-y-1.5">{body}</div>

  return <div className={`p-3 rounded-lg border ${t.box}`}>{body}</div>
}

/**
 * Every active job, stacked in one place directly under the page header.
 *
 * Jobs used to render wherever their component happened to be mounted, so two
 * concurrent jobs could collide and one (metadata conversion) had no home on the
 * library page at all.
 */
export function ProgressStack({ jobs }: { jobs: ProgressJob[] }): React.JSX.Element | null {
  if (jobs.length === 0) return null
  return (
    <div className="mb-4 space-y-2">
      {jobs.map((job) => (
        <ProgressBar key={job.id} {...job} />
      ))}
    </div>
  )
}
