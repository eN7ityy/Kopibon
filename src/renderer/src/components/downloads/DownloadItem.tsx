import { useState } from 'react'
import type {
  DownloadQueueItem,
  DownloadProgressEvent
} from '../../types/api.types'
import DownloadProgressBar from './DownloadProgress'
import { BookOpen, Check, FolderOpen } from 'lucide-react'

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
  artist: 'bg-accent-wash text-accent',
  group: 'bg-tag-group/15 text-tag-group',
  language: 'bg-tag-language/15 text-tag-language',
  tag: 'bg-raised text-fg-muted'
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
    <div className="p-4 rounded-lg bg-surface border border-line">
      <div className="flex items-start gap-4">
        {/* Thumbnail */}
        <div className="w-16 h-20 rounded bg-raised flex-shrink-0 flex items-center justify-center overflow-hidden">
          {galleryInfo?.thumbnailUrl && !imgError ? (
            <img
              src={galleryInfo.thumbnailUrl}
              alt={title}
              draggable={false}
              onError={() => setImgError(true)}
              className="w-full h-full object-cover"
            />
          ) : (
            <BookOpen size={22} strokeWidth={1.5} aria-hidden="true" />
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1">
            <h4 className="text-sm font-medium text-fg truncate">
              {title}
            </h4>
            <span
              className={`text-xs font-medium ml-2 flex-shrink-0 px-2 py-0.5 rounded-full ${
                /*
                  Active, queued and completed had all collapsed to the same
                  neutral chip: the hue migration matched these class strings by
                  exact text to neutralise the seven *tag* colours, and the
                  status pill happened to use the identical strings. Restored to
                  the state tokens, which is what they always meant.
                */
                isActive
                  ? 'bg-info-wash text-info'
                  : isPaused
                    ? 'bg-warning-wash text-warning'
                    : isQueued
                      ? 'bg-raised text-fg-muted'
                      : isFailed
                        ? 'bg-danger-wash text-danger'
                        : isCompleted
                          ? 'bg-success-wash text-success'
                          : 'bg-raised text-fg-muted'
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
                <span className="px-1.5 py-0.5 rounded-full text-xs text-fg-faint">
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
              <div className="w-full bg-raised rounded-full h-2 overflow-hidden">
                <div className="bg-accent-fill h-full rounded-full animate-pulse" style={{ width: '100%' }} />
              </div>
              <p className="text-xs text-accent mt-1">
                Converting images to PDF...
              </p>
            </div>
          )}

          {/* Failed message */}
          {isFailed && item.errorMessage && (
            <p className="text-xs text-danger mt-1">{item.errorMessage}</p>
          )}

          {/* Page count for queued/paused */}
          {(isQueued || isPaused) && (
            <p className="text-xs text-fg-muted mt-1">
              {pageCount > 0 ? `${pageCount} pages · ` : ''}Waiting to start...
            </p>
          )}

          {/* Completed */}
          {isCompleted && (
            <div className="mt-1">
              <p className="text-xs text-success inline-flex items-center gap-1">
                <Check size={12} aria-hidden="true" /> Download complete
              </p>
              {galleryInfo?.filePath && (
                <p className="text-xs text-fg-faint mt-0.5 truncate" title={galleryInfo.filePath}>
                  <FolderOpen size={12} aria-hidden="true" /> {galleryInfo.filePath}
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
              className="p-1.5 rounded text-fg-faint hover:text-warning hover:bg-raised transition-colors"
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
              className="p-1.5 rounded text-fg-faint hover:text-success hover:bg-raised transition-colors"
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
              className="p-1.5 rounded text-fg-faint hover:text-info hover:bg-raised transition-colors"
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
              className="p-1.5 rounded text-fg-faint hover:text-danger hover:bg-raised transition-colors"
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
