import { useState, useEffect, useCallback, useRef } from 'react'
import type { DownloadQueueItem, DownloadProgressEvent } from '../../types/api.types'
import DownloadItem from './DownloadItem'
import EmptyState from '../shared/EmptyState'
import LoadingSkeleton from '../shared/LoadingSkeleton'

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

export default function DownloadsPage(): React.JSX.Element {
  const [activeDownloads, setActiveDownloads] = useState<DownloadQueueItem[]>([])
  const [queuedItems, setQueuedItems] = useState<DownloadQueueItem[]>([])
  const [loading, setLoading] = useState(true)
  const [galleryInfoMap, setGalleryInfoMap] = useState<Record<number, GalleryInfo>>({})
  const fetchedGalleryIds = useRef<Set<number>>(new Set())

  const fetchGalleryInfo = useCallback(async (galleryId: number): Promise<GalleryInfo | null> => {
    if (fetchedGalleryIds.current.has(galleryId)) return null
    fetchedGalleryIds.current.add(galleryId)

    try {
      const result = await window.api.getGallery(galleryId)
      if (result.success && result.data) {
        const g = result.data
        const libItem = await (async () => {
          try {
            const r = await window.api.library.getByGalleryId(galleryId)
            return r.success ? r.data : null
          } catch { return null }
        })()

        return {
          title: g.title.pretty,
          thumbnailUrl: g.cover?.path ? `https://t.nhentai.net/${g.cover.path}` : null,
          pageCount: g.num_pages,
          artists: g.tags.filter((t) => t.type === 'artist').map((t) => t.name),
          groups: g.tags.filter((t) => t.type === 'group').map((t) => t.name),
          language: g.tags.find((t) => t.type === 'language')?.name || null,
          tags: g.tags
            .filter((t) => !['artist', 'group', 'language'].includes(t.type))
            .map((t) => t.name),
          filePath: libItem?.filePath || null
        }
      }
    } catch {
      // Fall through to library check
    }

    try {
      const libResult = await window.api.library.getByGalleryId(galleryId)
      if (libResult.success && libResult.data) {
        return {
          title: libResult.data.customTitle || `Gallery #${galleryId}`,
          thumbnailUrl: null,
          pageCount: 0,
          artists: [],
          groups: [],
          language: null,
          tags: [],
          filePath: libResult.data.filePath || null
        }
      }
    } catch {
      // ignore
    }

    return { title: `Gallery #${galleryId}`, thumbnailUrl: null, pageCount: 0, artists: [], groups: [], language: null, tags: [], filePath: null }
  }, [])

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

      // Fetch gallery info for items that don't have it yet
      const allItems = [...allActive, ...allQueued]
      const newIds = allItems
        .map((i) => i.galleryId)
        .filter((id) => !galleryInfoMap[id])

      if (newIds.length > 0) {
        const infos = await Promise.all(newIds.map((id) => fetchGalleryInfo(id)))
        const updates: Record<number, GalleryInfo> = {}
        for (let i = 0; i < newIds.length; i++) {
          const info = infos[i]
          if (info) updates[newIds[i]] = info
        }
        if (Object.keys(updates).length > 0) {
          setGalleryInfoMap((prev) => ({ ...prev, ...updates }))
        }
      }
    } catch (err) {
      console.error('Failed to fetch downloads:', err)
    } finally {
      setLoading(false)
    }
  }, [fetchGalleryInfo, galleryInfoMap])

  // Progress state map for active downloads
  const [progressMap, setProgressMap] = useState<Record<number, DownloadProgressEvent>>({})

  // Listen for download progress events from main process
  useEffect(() => {
    const cleanup = window.api.onDownloadProgress((progress) => {
      setProgressMap((prev) => ({ ...prev, [progress.queueId]: progress }))
    })
    return () => { cleanup() }
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
      await window.api.downloads.addToQueue(item.galleryId, (item as any).outputFormat)
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

  const handleClearQueue = async (): Promise<void> => {
    // Remove all queued, paused, failed, and completed items
    const statuses = ['queued', 'paused', 'failed', 'completed']
    for (const status of statuses) {
      const result = await window.api.downloads.getByStatus(status)
      if (result.success && result.data) {
        for (const item of result.data) {
          await window.api.downloads.remove(item.id)
        }
      }
    }
    fetchedGalleryIds.current.clear()
    setGalleryInfoMap({})
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
              <button
                onClick={handleClearQueue}
                className="px-3 py-1.5 rounded-lg text-sm bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors"
              >
                Clear Queue
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
                    progress={progressMap[item.id]}
                    galleryInfo={galleryInfoMap[item.galleryId]}
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
                    galleryInfo={galleryInfoMap[item.galleryId]}
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
