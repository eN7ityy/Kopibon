import type {
  DownloadQueueItem,
  DownloadProgressEvent
} from '../../types/api.types'
import DownloadProgressBar from './DownloadProgress'

interface DownloadItemProps {
  item: DownloadQueueItem
  progress?: DownloadProgressEvent
  onPause: (id: number) => void
  onResume: (id: number) => void
  onCancel: (id: number) => void
  onRetry: (id: number) => void
}

export default function DownloadItem({
  item,
  progress,
  onPause,
  onResume,
  onCancel,
  onRetry
}: DownloadItemProps): React.JSX.Element {
  const isActive =
    item.status === 'downloading' || item.status === 'converting'
  const isPaused = item.status === 'paused'
  const isQueued = item.status === 'queued'
  const isFailed = item.status === 'failed'
  const isCompleted = item.status === 'completed'

  return (
    <div className="flex items-start gap-4 p-4 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
      {/* Thumbnail */}
      <div className="w-16 h-20 rounded bg-gray-200 dark:bg-gray-700 flex-shrink-0 flex items-center justify-center text-gray-400">
        <span className="text-2xl">📖</span>
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {progress?.title || `Gallery #${item.galleryId}`}
          </h4>
          <span
            className={`text-xs font-medium ml-2 flex-shrink-0 px-2 py-0.5 rounded-full ${
              isActive
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                : isPaused
                  ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                  : isQueued
                    ? 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                    : isFailed
                      ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                      : isCompleted
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
            }`}
          >
            {isActive
              ? item.status === 'converting'
                ? 'Converting'
                : 'Downloading'
              : isPaused
                ? 'Paused'
                : isQueued
                  ? 'Queued'
                  : isFailed
                    ? 'Failed'
                    : isCompleted
                      ? 'Completed'
                      : item.status}
          </span>
        </div>

        {/* Progress bar for active downloads */}
        {isActive && progress && (
          <DownloadProgressBar
            completed={progress.completedPages}
            total={progress.totalPages}
            percentage={progress.percentage}
            speedKBps={progress.speedKBps}
            etaSeconds={progress.etaSeconds}
          />
        )}

        {/* Failed message */}
        {isFailed && item.errorMessage && (
          <p className="text-xs text-red-600 dark:text-red-400 mt-1">{item.errorMessage}</p>
        )}

        {/* Page count for queued/paused */}
        {(isQueued || isPaused) && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Waiting to start...
          </p>
        )}

        {/* Completed */}
        {isCompleted && (
          <p className="text-xs text-green-600 dark:text-green-400 mt-1">Download complete ✓</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {isActive && (
          <button
            onClick={() => onPause(item.id)}
            className="p-1.5 rounded text-gray-400 hover:text-yellow-500 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            title="Pause"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6" />
            </svg>
          </button>
        )}
        {isPaused && (
          <button
            onClick={() => onResume(item.id)}
            className="p-1.5 rounded text-gray-400 hover:text-green-500 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            title="Resume"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
        )}
        {isFailed && (
          <button
            onClick={() => onRetry(item.id)}
            className="p-1.5 rounded text-gray-400 hover:text-blue-500 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            title="Retry"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        )}
        {!isCompleted && (
          <button
            onClick={() => onCancel(item.id)}
            className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            title={isFailed ? 'Remove' : 'Cancel'}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
