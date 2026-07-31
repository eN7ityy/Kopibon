import ProgressBar from '../shared/ProgressBar'
import { formatSpeed } from '../shared/format'

interface DownloadProgressProps {
  completed: number
  total: number
  percentage: number
  speedKBps?: number
  etaSeconds?: number
}

/**
 * Per-download progress, inside a queue row.
 *
 * Uses the shared bar in `inline` variant: a download is one row among many, so
 * it gets no card, tint or spinner — but the shape, colours, number formatting
 * and ETA wording are identical to the page-level jobs.
 */
export default function DownloadProgressBar({
  completed,
  total,
  speedKBps,
  etaSeconds
}: DownloadProgressProps): React.JSX.Element {
  const speed = formatSpeed(speedKBps)

  return (
    <ProgressBar
      variant="inline"
      id="download"
      label={`${completed}/${total} pages`}
      current={completed}
      total={total}
      detail={speed || undefined}
      etaSeconds={etaSeconds}
      tone="read"
    />
  )
}
