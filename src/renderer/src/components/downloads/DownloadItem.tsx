import { useState } from 'react'
import type {
  DownloadQueueItem,
  DownloadProgressEvent
} from '../../types/api.types'
import DownloadProgressBar from './DownloadProgress'

interface GalleryInfo {
  title: string
  thumbnailUrl: string | null
  pageCount: number
  artists: string[]
  groups: string[]
  language: string | null
  tags: string[]
  filePath: string | null
}

interface DownloadItemProps {
  item: DownloadQueueItem
  progress?: DownloadProgressEvent
  galleryInfo?: GalleryInfo
  onPause: (id: number) => void
  onResume: (id: number) => void
  onCancel: (id: number) => void
  onRetry: (id: number) => void
}

const TAG_COLORS: Record<string, string> = {
  artist: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  group: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  language: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  tag: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
}

export default function DownloadItem({
  item,
  progress,
  galleryInfo,
  onPause,
  onResume,
  onCancel,
  onRetry
}: DownloadItemProps): React.JSX.Element {
  const [imgError, setImgError] = useState(false)

  const isActive =
    item.status === 'downloading' || item.status === 'converting'
  const isPaused = item.status === 'paused'
  const isQueued = item.status === 'queued'
  const isFailed = item.status === 'failed'
  const isCompleted = item.status === 'completed'

  const title = progress?.title || galleryInfo?.title || `Gallery #${item.galleryId}`
  const pageCount = progress?.totalPages || galleryInfo?.pageCount || 0

  return (
    <div className="p-4 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
      <div className="flex items-start gap-4">
        {/* Thumbnail */}
        <div className="w-16 h-20 rounded bg-gray-200 dark:bg-gray-700 flex-shrink-0 flex items-center justify-center overflow-hidden">
          {galleryInfo?.thumbnailUrl && !imgError ? (
            <img
              src={galleryInfo.thumbnailUrl}
              alt={title}
              draggable={false}
              onError={() => setImgError(true)}
              className="w-full h-full object-cover"
            />
          ) : (
            <span className="text-2xl">📖</span>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1">
            <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
              {title}
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

          {/* Artist, group, language chips */}
          {galleryInfo && (galleryInfo.artists.length > 0 || galleryInfo.groups.length > 0 || galleryInfo.language) && (
            <div className="flex flex-wrap gap-1 mb-1">
              {galleryInfo.artists.map((name) => (
                <span key={`artist-${name}`} className={`px-1.5 py-0.5 rounded-full text-xs font-medium ${TAG_COLORS.artist}`}>
                  {name}
                </span>
              ))}
              {galleryInfo.groups.map((name) => (
                <span key={`group-${name}`} className={`px-1.5 py-0.5 rounded-full text-xs font-medium ${TAG_COLORS.group}`}>
                  {name}
                </span>
              ))}
              {galleryInfo.language && (
                <span className={`px-1.5 py-0.5 rounded-full text-xs font-medium ${TAG_COLORS.language}`}>
                  {galleryInfo.language}
                </span>
              )}
            </div>
          )}

          {/* Tags */}
          {galleryInfo && galleryInfo.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-1">
              {galleryInfo.tags.slice(0, 6).map((name) => (
                <span key={`tag-${name}`} className={`px-1.5 py-0.5 rounded-full text-xs font-medium ${TAG_COLORS.tag}`}>
                  {name}
                </span>
              ))}
              {galleryInfo.tags.length > 6 && (
                <span className="px-1.5 py-0.5 rounded-full text-xs text-gray-400">
                  +{galleryInfo.tags.length - 6} more
                </span>
              )}
            </div>
          )}

          {/* Progress bar for active downloads (including converting) */}
          {isActive && progress && (
            <DownloadProgressBar
              completed={progress.completedPages}
              total={progress.totalPages}
              percentage={progress.percentage}
              speedKBps={progress.speedKBps}
              etaSeconds={progress.etaSeconds}
            />
          )}

          {/* Conversion status when no detailed progress available */}
          {item.status === 'converting' && !progress && (
            <div className="mt-1">
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
                <div className="bg-purple-500 h-full rounded-full animate-pulse" style={{ width: '100%' }} />
              </div>
              <p className="text-xs text-purple-600 dark:text-purple-400 mt-1">
                Converting images to PDF...
              </p>
            </div>
          )}

          {/* Failed message */}
          {isFailed && item.errorMessage && (
            <p className="text-xs text-red-600 dark:text-red-400 mt-1">{item.errorMessage}</p>
          )}

          {/* Page count for queued/paused */}
          {(isQueued || isPaused) && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {pageCount > 0 ? `${pageCount} pages · ` : ''}Waiting to start...
            </p>
          )}

          {/* Completed */}
          {isCompleted && (
            <div className="mt-1">
              <p className="text-xs text-green-600 dark:text-green-400">Download complete ✓</p>
              {galleryInfo?.filePath && (
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 truncate" title={galleryInfo.filePath}>
                  📁 {galleryInfo.filePath}
                </p>
              )}
            </div>
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
    </div>
  )
}
