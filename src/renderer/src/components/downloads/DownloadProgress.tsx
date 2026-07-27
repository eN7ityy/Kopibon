interface DownloadProgressProps {
  completed: number
  total: number
  percentage: number
  speedKBps?: number
  etaSeconds?: number
}

export default function DownloadProgressBar({
  completed,
  total,
  percentage,
  speedKBps,
  etaSeconds
}: DownloadProgressProps): React.JSX.Element {
  const formatEta = (seconds: number): string => {
    if (seconds <= 0) return '--'
    if (seconds < 60) return `${seconds}s`
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}m ${secs}s`
  }

  const formatSpeed = (kbps: number): string => {
    if (kbps <= 0) return '--'
    if (kbps < 1024) return `${kbps.toFixed(0)} KB/s`
    return `${(kbps / 1024).toFixed(1)} MB/s`
  }

  return (
    <div className="space-y-1.5">
      {/* Progress bar */}
      <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div
          className="h-full bg-purple-500 rounded-full transition-all duration-300"
          style={{ width: `${Math.min(percentage, 100)}%` }}
        />
      </div>

      {/* Stats row */}
      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
        <span>
          {completed}/{total} pages ({percentage}%)
        </span>
        <span className="flex items-center gap-3">
          {speedKBps !== undefined && speedKBps > 0 && (
            <span>{formatSpeed(speedKBps)}</span>
          )}
          {etaSeconds !== undefined && etaSeconds > 0 && (
            <span>ETA: {formatEta(etaSeconds)}</span>
          )}
        </span>
      </div>
    </div>
  )
}
