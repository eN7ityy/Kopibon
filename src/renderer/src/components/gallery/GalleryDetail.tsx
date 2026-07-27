import { useState, useEffect, useCallback } from 'react'
import type { GalleryDetail as GalleryDetailType, DownloadStatus } from '../../types/api.types'
import StatusBadge from '../shared/StatusBadge'
import LoadingSkeleton from '../shared/LoadingSkeleton'

interface GalleryDetailProps {
  galleryId: number
  onClose: () => void
  onDownload: (galleryId: number) => void
  onAddToQueue: (galleryId: number) => void
}

const TAG_COLORS: Record<string, string> = {
  language: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  artist: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  group: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  category: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  parody: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400',
  character: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  tag: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}

export default function GalleryDetailPanel({
  galleryId,
  onClose,
  onDownload,
  onAddToQueue
}: GalleryDetailProps): React.JSX.Element {
  const [detail, setDetail] = useState<GalleryDetailType | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [downloadStatus, setDownloadStatus] = useState<DownloadStatus>('not_downloaded')
  const [imgError, setImgError] = useState(false)

  const fetchDetail = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const result = await window.api.getGallery(galleryId)
      if (result.success && result.data) {
        setDetail(result.data)

        // Check download status
        const libResult = await window.api.library.getByGalleryId(galleryId)
        if (libResult.success && libResult.data) {
          setDownloadStatus('in_library')
        } else {
          const dlResult = await window.api.downloads.getByGalleryId(galleryId)
          if (dlResult.success && dlResult.data) {
            const s = dlResult.data.status
            if (s === 'downloading') setDownloadStatus('downloading')
            else if (s === 'queued') setDownloadStatus('queued')
            else if (s === 'completed') setDownloadStatus('completed')
            else if (s === 'failed') setDownloadStatus('failed')
            else setDownloadStatus('not_downloaded')
          }
        }
      } else {
        setError(result.error || 'Gallery not found')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load gallery')
    } finally {
      setLoading(false)
    }
  }, [galleryId])

  useEffect(() => {
    fetchDetail()
  }, [fetchDetail])

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [onClose])

  const coverUrl = detail?.images?.cover
    ? `https://t.nhentai.net/galleries/${detail.media_id}/cover.${detail.images.cover.t}`
    : null

  const isInLibrary = downloadStatus === 'in_library'

  const handleTagClick = (tagName: string): void => {
    // Navigate to search with this tag — for now open in browser
    window.api.shell.openExternal(`https://nhentai.net/tag/${encodeURIComponent(tagName.replace(/\s+/g, '-').toLowerCase())}/`)
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40 transition-opacity"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 h-full w-full max-w-lg bg-white dark:bg-gray-900 shadow-2xl z-50 overflow-y-auto transform transition-transform duration-300 animate-slide-in">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 p-2 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {loading && (
          <LoadingSkeleton variant="detail" />
        )}

        {error && !loading && (
          <div className="p-6 text-center">
            <span className="text-5xl block mb-4">😕</span>
            <p className="text-lg font-medium text-red-500 dark:text-red-400">
              {error}
            </p>
            <button
              onClick={fetchDetail}
              className="mt-4 px-4 py-2 rounded-lg bg-purple-600 text-white font-medium hover:bg-purple-700 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {detail && !loading && !error && (
          <div className="p-6">
            {/* Cover image */}
            <div className="aspect-[3/4] max-w-sm mx-auto mb-6 bg-gray-200 dark:bg-gray-800 rounded-lg overflow-hidden">
              {coverUrl && !imgError ? (
                <img
                  src={coverUrl}
                  alt={detail.title.pretty}
                  onError={() => setImgError(true)}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-400">
                  <span className="text-5xl">📖</span>
                </div>
              )}
            </div>

            {/* Download status */}
            <div className="flex items-center justify-between mb-4">
              <StatusBadge status={downloadStatus} size="md" />
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {detail.num_pages} pages
              </span>
            </div>

            {/* Title */}
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">
              {detail.title.pretty}
            </h2>
            {detail.title.english && detail.title.english !== detail.title.pretty && (
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">{detail.title.english}</p>
            )}
            {detail.title.japanese && (
              <p className="text-sm text-gray-400 dark:text-gray-500 mb-3">{detail.title.japanese}</p>
            )}

            {/* Artists & Groups */}
            <div className="flex flex-wrap gap-2 mb-3">
              {detail.tags
                .filter((t) => t.type === 'artist')
                .map((tag) => (
                  <button
                    key={tag.id}
                    onClick={() => handleTagClick(tag.name)}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium cursor-pointer hover:opacity-80 transition-opacity ${TAG_COLORS.artist}`}
                  >
                    {tag.name}
                  </button>
                ))}
              {detail.tags
                .filter((t) => t.type === 'group')
                .map((tag) => (
                  <button
                    key={tag.id}
                    onClick={() => handleTagClick(tag.name)}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium cursor-pointer hover:opacity-80 transition-opacity ${TAG_COLORS.group}`}
                  >
                    {tag.name}
                  </button>
                ))}
            </div>

            {/* All tags */}
            <div className="flex flex-wrap gap-1.5 mb-4">
              {detail.tags
                .filter((t) => !['artist', 'group'].includes(t.type))
                .map((tag) => (
                  <button
                    key={tag.id}
                    onClick={() => handleTagClick(tag.name)}
                    className={`px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer hover:opacity-80 transition-opacity ${TAG_COLORS[tag.type] || TAG_COLORS.tag}`}
                  >
                    {tag.name}
                  </button>
                ))}
            </div>

            {/* Meta info */}
            <div className="space-y-1.5 text-sm text-gray-600 dark:text-gray-400 mb-6">
              <div className="flex justify-between">
                <span>Pages</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">{detail.num_pages}</span>
              </div>
              <div className="flex justify-between">
                <span>Uploaded</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {formatDate(detail.upload_date)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Favorites</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {detail.num_favorites.toLocaleString()}
                </span>
              </div>
              {detail.scanlator && (
                <div className="flex justify-between">
                  <span>Scanlator</span>
                  <span className="font-medium text-gray-900 dark:text-gray-100">{detail.scanlator}</span>
                </div>
              )}
            </div>

            {/* Action buttons */}
            <div className="space-y-3">
              {isInLibrary ? (
                <div className="px-4 py-3 rounded-lg bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-center font-medium">
                  ✓ Already in Library
                </div>
              ) : (
                <button
                  onClick={() => onDownload(galleryId)}
                  className="w-full px-4 py-3 rounded-lg bg-purple-600 text-white font-medium hover:bg-purple-700 transition-colors"
                >
                  Download
                </button>
              )}

              <button
                onClick={() => {
                  if (!isInLibrary) {
                    onAddToQueue(galleryId)
                  }
                }}
                disabled={isInLibrary}
                className="w-full px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
              >
                {isInLibrary ? 'Already Downloaded' : 'Add to Queue'}
              </button>

              <button
                onClick={() => window.api.shell.openExternal(`https://nhentai.net/g/${galleryId}`)}
                className="w-full px-4 py-2 rounded-lg text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
              >
                Open in Browser ↗
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
