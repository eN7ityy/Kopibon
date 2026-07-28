import { useState, useEffect, useCallback, useRef } from 'react'
import type { PageInfo } from '../../types/api.types'

interface GalleryViewerProps {
  galleryId: number
  pages: PageInfo[]
  cdnServers: string[]
  thumbServers: string[]
  title: string
  onClose: () => void
}

/** Strip protocol prefix from CDN server hostname (handles both https:// and http://). */
function normalizeHost(raw: string): string {
  return raw.replace(/^https?:\/\//, '')
}

/** Build a full CDN URL: https://{host}/{path} */
function buildCdnUrl(host: string, path: string): string {
  return `https://${normalizeHost(host)}/${path}`
}

export default function GalleryViewer({
  galleryId: _galleryId,
  pages,
  cdnServers,
  thumbServers,
  title,
  onClose
}: GalleryViewerProps): React.JSX.Element {
  const [mode, setMode] = useState<'grid' | 'reading'>('grid')
  const [currentPage, setCurrentPage] = useState(0)
  const [imageLoading, setImageLoading] = useState(true)
  const [imageError, setImageError] = useState(false)
  const [serverIndex, setServerIndex] = useState(0)
  const [showBottomBar, setShowBottomBar] = useState(true)
  const [atBoundary, setAtBoundary] = useState<'start' | 'end' | null>(null)
  const gridScrollRef = useRef<HTMLDivElement>(null)
  const gridScrollPosition = useRef(0)

  const thumbServer = thumbServers[0] ?? ''
  const cdnServer = cdnServers[serverIndex] ?? cdnServers[0] ?? ''
  const totalPages = pages.length
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // ─── Navigation helpers ───────────────────────────────────────────────

  const goToPage = useCallback(
    (index: number) => {
      if (index < 0 || index >= totalPages) return
      setCurrentPage(index)
      setImageLoading(true)
      setImageError(false)
      setServerIndex(0)
    },
    [totalPages]
  )

  const goPrev = useCallback(() => {
    if (currentPage <= 0) {
      setAtBoundary('start')
      setTimeout(() => setAtBoundary(null), 600)
      return
    }
    setAtBoundary(null)
    goToPage(currentPage - 1)
  }, [currentPage, goToPage])

  const goNext = useCallback(() => {
    if (currentPage >= totalPages - 1) {
      setAtBoundary('end')
      setTimeout(() => setAtBoundary(null), 600)
      return
    }
    setAtBoundary(null)
    goToPage(currentPage + 1)
  }, [currentPage, totalPages, goToPage])

  const openReadingMode = useCallback((index: number) => {
    // Save grid scroll position before entering reading mode
    if (gridScrollRef.current) {
      gridScrollPosition.current = gridScrollRef.current.scrollTop
    }
    setMode('reading')
    goToPage(index)
  }, [goToPage])

  const exitReadingMode = useCallback(() => {
    setMode('grid')
    // Restore scroll position on next frame after re-render
    requestAnimationFrame(() => {
      if (gridScrollRef.current) {
        gridScrollRef.current.scrollTop = gridScrollPosition.current
      }
    })
  }, [])

  // ─── Retry with next CDN server ───────────────────────────────────────

  const retryWithNextServer = useCallback(() => {
    if (serverIndex < cdnServers.length - 1) {
      setServerIndex((prev) => prev + 1)
      setImageLoading(true)
      setImageError(false)
    }
  }, [serverIndex, cdnServers.length])

  // ─── Keyboard navigation ──────────────────────────────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      // Don't capture if an input is focused
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (mode === 'reading') {
        switch (e.key) {
          case 'ArrowLeft':
          case 'a':
          case 'A':
            e.preventDefault()
            goPrev()
            break
          case 'ArrowRight':
          case 'd':
          case 'D':
            e.preventDefault()
            goNext()
            break
          case 'Escape':
            e.preventDefault()
            exitReadingMode()
            break
          case 'Home':
            e.preventDefault()
            goToPage(0)
            break
          case 'End':
            e.preventDefault()
            goToPage(totalPages - 1)
            break
        }
      } else if (mode === 'grid') {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [mode, goPrev, goNext, goToPage, exitReadingMode, onClose, totalPages])

  // ─── Preload adjacent page ────────────────────────────────────────────

  useEffect(() => {
    if (mode !== 'reading') return

    // Preload next page
    if (currentPage + 1 < totalPages) {
      const preloadNext = new Image()
      preloadNext.src = buildCdnUrl(cdnServers[0] ?? '', pages[currentPage + 1].path)
    }

    // Preload previous page
    if (currentPage - 1 >= 0) {
      const preloadPrev = new Image()
      preloadPrev.src = buildCdnUrl(cdnServers[0] ?? '', pages[currentPage - 1].path)
    }
  }, [mode, currentPage, pages, cdnServers, totalPages])

  // ─── Boundary flash auto-clear ────────────────────────────────────────

  useEffect(() => {
    if (!atBoundary) return
    const timer = setTimeout(() => setAtBoundary(null), 600)
    return () => clearTimeout(timer)
  }, [atBoundary])

  // ─── Render: Thumbnail Grid ───────────────────────────────────────────

  if (mode === 'grid') {
    return (
      <>
        {/* Backdrop */}
        <div
          className="fixed inset-0 bg-black/50 z-40 transition-opacity"
          onClick={onClose}
        />

        {/* Panel */}
        <div
          className="fixed left-0 top-0 h-full w-full max-w-lg bg-gray-950 shadow-2xl z-50 flex flex-col"
          role="dialog"
          aria-label="Gallery viewer"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 shrink-0">
            <h2 className="text-sm font-semibold text-gray-200 truncate flex-1 mr-2">
              {title}
            </h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white transition-colors text-sm font-medium"
            >
              Exit
            </button>
          </div>

          {/* Grid */}
          {pages.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-gray-400 p-6">
              <div className="text-center">
                <span className="text-5xl block mb-4">📖</span>
                <p>No pages available</p>
                <button
                  onClick={onClose}
                  className="mt-4 px-4 py-2 rounded-lg border border-gray-600 text-gray-300 hover:bg-gray-800 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          ) : (
            <div
              ref={gridScrollRef}
              className="flex-1 grid grid-cols-3 gap-2 p-4 overflow-y-auto content-start"
            >
              {pages.map((page, index) => (
                <ThumbnailItem
                  key={page.number ?? index}
                  page={page}
                  index={index}
                  thumbServer={thumbServer}
                  onClick={() => openReadingMode(index)}
                />
              ))}
            </div>
          )}
        </div>
      </>
    )
  }

  // ─── Render: Reading Mode ─────────────────────────────────────────────

  const currentPageData = pages[currentPage]
  const imageUrl = currentPageData
    ? buildCdnUrl(cdnServer, currentPageData.path)
    : ''

  return (
    <div
      className="fixed inset-0 z-50 bg-black"
      role="dialog"
      aria-label="Gallery reader"
    >
      {/* Boundary flash overlay */}
      {atBoundary && (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center z-20">
          <div className="bg-white/10 rounded-lg px-6 py-3 text-white text-sm font-medium animate-pulse">
            {atBoundary === 'start' ? 'First page' : 'Last page'}
          </div>
        </div>
      )}

      {/* Main image area */}
      <div className="flex h-[calc(100vh-64px)]">
        {/* Left click zone - 30% */}
        <div
          className="w-[30%] h-full cursor-pointer group flex items-center justify-start pl-4 z-10"
          onClick={goPrev}
          title="Previous page (←)"
        >
          <div className="opacity-0 group-hover:opacity-100 transition-opacity text-white/60 text-4xl select-none">
            ‹
          </div>
        </div>

        {/* Center zone - 40% */}
        <div
          className="w-[40%] h-full flex items-center justify-center z-10"
          onClick={() => setShowBottomBar((prev) => !prev)}
        >
          {imageLoading && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-10 h-10 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            </div>
          )}

          {imageError ? (
            <div className="text-center text-gray-400">
              <p className="mb-2">Failed to load page</p>
              {serverIndex < cdnServers.length - 1 ? (
                <button
                  onClick={retryWithNextServer}
                  className="px-4 py-2 rounded-lg border border-gray-500 text-gray-300 hover:bg-gray-800 transition-colors text-sm"
                >
                  Try Next Server
                </button>
              ) : (
                <button
                  onClick={() => {
                    setImageLoading(true)
                    setImageError(false)
                  }}
                  className="px-4 py-2 rounded-lg border border-gray-500 text-gray-300 hover:bg-gray-800 transition-colors text-sm"
                >
                  Retry
                </button>
              )}
            </div>
          ) : (
            currentPageData && (
              <img
                src={imageUrl}
                alt={`Page ${currentPage + 1}`}
                draggable={false}
                onLoad={() => setImageLoading(false)}
                onError={() => {
                  setImageLoading(false)
                  setImageError(true)
                }}
                className={`max-w-[80vw] max-h-[calc(100vh-80px)] object-contain ${
                  prefersReducedMotion ? '' : 'transition-opacity duration-200'
                } ${imageLoading ? 'opacity-0' : 'opacity-100'}`}
              />
            )
          )}
        </div>

        {/* Right click zone - 30% */}
        <div
          className="w-[30%] h-full cursor-pointer group flex items-center justify-end pr-4 z-10"
          onClick={goNext}
          title="Next page (→)"
        >
          <div className="opacity-0 group-hover:opacity-100 transition-opacity text-white/60 text-4xl select-none">
            ›
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div
        className={`fixed bottom-0 left-0 right-0 h-16 bg-black/80 backdrop-blur flex items-center justify-between px-6 transition-transform duration-200 ${
          showBottomBar ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        {/* Left: title truncated */}
        <div className="flex-1 min-w-0 mr-4">
          <p className="text-sm text-white/80 truncate">{title}</p>
        </div>

        {/* Center: page counter */}
        <div className="text-sm text-white/60 font-mono tabular-nums whitespace-nowrap">
          {currentPage + 1} / {totalPages}
        </div>

        {/* Right: Exit button */}
        <div className="flex-1 flex justify-end">
          <button
            onClick={exitReadingMode}
            className="text-white/70 hover:text-red-400 transition-colors text-sm font-medium"
          >
            ✕ Exit
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Thumbnail Item ─────────────────────────────────────────────────────

function ThumbnailItem({
  page,
  index,
  thumbServer,
  onClick
}: {
  page: PageInfo
  index: number
  thumbServer: string
  onClick: () => void
}): React.JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)

  const thumbUrl = thumbServer
    ? buildCdnUrl(thumbServer, page.thumbnail)
    : ''

  return (
    <button
      onClick={onClick}
      className="group w-full text-left"
      title={`Page ${index + 1}`}
    >
      <div className="aspect-[3/4] bg-gray-800 rounded overflow-hidden relative group-hover:ring-2 group-hover:ring-purple-500 group-hover:scale-[1.02] transition-transform focus-within:ring-2 focus-within:ring-purple-400">
        {!error && thumbUrl ? (
          <>
            {/* Shimmer placeholder */}
            {!loaded && (
              <div className="absolute inset-0 bg-gray-800 animate-pulse" />
            )}
            <img
              src={thumbUrl}
              alt={`Page ${index + 1}`}
              loading="lazy"
              draggable={false}
              onLoad={() => setLoaded(true)}
              onError={() => setError(true)}
              className={`w-full h-full object-cover ${
                loaded ? 'opacity-100' : 'opacity-0'
              } transition-opacity duration-150`}
            />
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-500">
            <span className="text-3xl">📖</span>
          </div>
        )}

        {/* Page number badge */}
        <div className="absolute bottom-1 right-1 bg-black/60 text-white/90 text-xs px-1.5 py-0.5 rounded font-mono">
          {index + 1}
        </div>
      </div>
    </button>
  )
}
