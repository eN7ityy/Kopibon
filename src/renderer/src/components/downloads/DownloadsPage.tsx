import { useState, useEffect, useCallback } from 'react'
import type { DownloadQueueItem } from '../../types/api.types'
import DownloadItem from './DownloadItem'
import EmptyState from '../shared/EmptyState'
import LoadingSkeleton from '../shared/LoadingSkeleton'

export default function DownloadsPage(): React.JSX.Element {
  const [activeDownloads, setActiveDownloads] = useState<DownloadQueueItem[]>([])
  const [queuedItems, setQueuedItems] = useState<DownloadQueueItem[]>([])
  const [loading, setLoading] = useState(true)

  const fetchDownloads = useCallback(async () => {
    try {
      const [activeResult, queuedResult, pausedResult, failedResult, convertingResult] =
        await Promise.all([
          window.api.downloads.getByStatus('downloading'),
          window.api.downloads.getByStatus('queued'),
          window.api.downloads.getByStatus('paused'),
          window.api.downloads.getByStatus('failed'),
          window.api.downloads.getByStatus('converting')
        ])

      const allActive: DownloadQueueItem[] = []
      if (activeResult.success && activeResult.data) allActive.push(...activeResult.data)
      if (convertingResult.success && convertingResult.data)
        allActive.push(...convertingResult.data)

      const allQueued: DownloadQueueItem[] = []
      if (queuedResult.success && queuedResult.data) allQueued.push(...queuedResult.data)
      if (pausedResult.success && pausedResult.data) allQueued.push(...pausedResult.data)
      if (failedResult.success && failedResult.data) allQueued.push(...failedResult.data)

      setActiveDownloads(allActive)
      setQueuedItems(allQueued)
    } catch (err) {
      console.error('Failed to fetch downloads:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial fetch and polling
  useEffect(() => {
    fetchDownloads()
    const interval = setInterval(fetchDownloads, 2000)
    return () => clearInterval(interval)
  }, [fetchDownloads])

  const handlePause = async (id: number): Promise<void> => {
    await window.api.downloads.pause(id)
    fetchDownloads()
  }

  const handleResume = async (id: number): Promise<void> => {
    await window.api.downloads.resume(id)
    fetchDownloads()
  }

  const handleCancel = async (id: number): Promise<void> => {
    await window.api.downloads.remove(id)
    fetchDownloads()
  }

  const handleRetry = async (id: number): Promise<void> => {
    const allItems = [...activeDownloads, ...queuedItems]
    const item = allItems.find((i) => i.id === id)
    if (item) {
      await window.api.downloads.remove(id)
      await window.api.downloads.addToQueue(item.galleryId)
    }
    fetchDownloads()
  }

  const handlePauseAll = async (): Promise<void> => {
    await window.api.downloads.pauseAll()
    fetchDownloads()
  }

  const handleResumeAll = async (): Promise<void> => {
    await window.api.downloads.resumeAll()
    fetchDownloads()
  }

  const hasContent = activeDownloads.length > 0 || queuedItems.length > 0

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Downloads</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Manage active and queued downloads
          </p>
        </div>
        <LoadingSkeleton count={3} variant="line" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header with global controls */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Downloads</h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Manage active and queued downloads
            </p>
          </div>
          {hasContent && (
            <div className="flex gap-2">
              <button
                onClick={handlePauseAll}
                className="px-3 py-1.5 rounded-lg text-sm bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 hover:bg-yellow-200 dark:hover:bg-yellow-900/50 transition-colors"
              >
                Pause All
              </button>
              <button
                onClick={handleResumeAll}
                className="px-3 py-1.5 rounded-lg text-sm bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors"
              >
                Resume All
              </button>
            </div>
          )}
        </div>
      </div>

      {!hasContent && (
        <EmptyState
          icon="⬇️"
          title="No active downloads"
          description="Search for doujinshi and add them to the download queue"
        />
      )}

      {hasContent && (
        <div className="flex-1 overflow-y-auto space-y-6">
          {/* Active Downloads */}
          {activeDownloads.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">
                Active Downloads ({activeDownloads.length})
              </h2>
              <div className="space-y-2">
                {activeDownloads.map((item) => (
                  <DownloadItem
                    key={item.id}
                    item={item}
                    onPause={handlePause}
                    onResume={handleResume}
                    onCancel={handleCancel}
                    onRetry={handleRetry}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Queued / Paused / Failed */}
          {queuedItems.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">
                Queued ({queuedItems.length})
              </h2>
              <div className="space-y-2">
                {queuedItems.map((item) => (
                  <DownloadItem
                    key={item.id}
                    item={item}
                    onPause={handlePause}
                    onResume={handleResume}
                    onCancel={handleCancel}
                    onRetry={handleRetry}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
