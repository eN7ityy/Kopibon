/**
 * CbzViewer — Lazy-rendering CBZ reader.
 *
 * Reads individual page images from a CBZ file via IPC (main process uses
 * yauzl to stream single entries). Decodes only the visible page ±2 for
 * memory efficiency (§2.3), avoiding the PDF viewer's eager full-resolution
 * rendering of every page.
 */

import { useState, useEffect, useRef, useCallback } from 'react'

// ─── Types ───────────────────────────────────────────────────────────────────

interface CbzViewerProps {
  filePath: string
  title: string
  onClose: () => void
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function CbzViewer({
  filePath,
  title,
  onClose
}: CbzViewerProps): React.JSX.Element {
  const [pageDataUrls, setPageDataUrls] = useState<Map<number, string>>(new Map())
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [visiblePage, setVisiblePage] = useState(1)
  const containerRef = useRef<HTMLDivElement>(null)
  const loadedPagesRef = useRef<Set<number>>(new Set())
  const loadingRef = useRef<Set<number>>(new Set())

  // ─── Load page count on mount ────────────────────────────────────────

  useEffect(() => {
    let cancelled = false

    const load = async (): Promise<void> => {
      setLoading(true)
      setError(null)

      try {
        const countResult = await window.api.cbz.getPageCount(filePath)
        if (cancelled) return

        if (countResult.success && typeof countResult.data === 'number') {
          if (countResult.data === 0) {
            setError('No images found in this CBZ file')
            setLoading(false)
            return
          }
          setTotalPages(countResult.data)
        } else {
          setError(countResult.error || 'Failed to read CBZ')
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to read CBZ')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [filePath])

  // ─── Lazy decode visible page ±2 ─────────────────────────────────────

  const decodePages = useCallback(async (centerPage: number) => {
    if (totalPages === 0) return

    const start = Math.max(0, centerPage - 3)
    const end = Math.min(totalPages - 1, centerPage + 3)

    for (let i = start; i <= end; i++) {
      if (loadedPagesRef.current.has(i) || loadingRef.current.has(i)) continue
      loadingRef.current.add(i)

      try {
        const result = await window.api.cbz.readPage(filePath, i)
        if (result.success && result.data) {
          loadedPagesRef.current.add(i)
          setPageDataUrls((prev) => {
            const next = new Map(prev)
            next.set(i, `data:image/jpeg;base64,${result.data}`)
            return next
          })
        }
      } catch {
        // Failed to decode this page — skip
      } finally {
        loadingRef.current.delete(i)
      }
    }
  }, [totalPages, filePath])

  // ─── Decode initial pages ────────────────────────────────────────────

  useEffect(() => {
    if (totalPages === 0) return
    // Schedule rather than setting state synchronously inside the effect —
    // decodePages() updates state, which the react-hooks rule flags (and which
    // can cause an extra render pass on mount).
    let cancelled = false
    const id = setTimeout(() => {
      if (!cancelled) decodePages(1)
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [totalPages, decodePages])

  // ─── Intersection Observer ────────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current || totalPages === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const pageNum = Number(entry.target.getAttribute('data-page'))
            if (!isNaN(pageNum)) {
              setVisiblePage(pageNum)
              decodePages(pageNum)
            }
          }
        }
      },
      { threshold: 0.3, root: containerRef.current }
    )

    const elements = containerRef.current.querySelectorAll('[data-page]')
    elements.forEach((el) => observer.observe(el))

    return () => observer.disconnect()
  }, [totalPages, pageDataUrls, decodePages])

  // ─── Keyboard navigation ─────────────────────────────────────────────

  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      switch (e.key) {
        case 'Escape':
          onClose()
          break
        case 'PageDown':
        case 'ArrowDown':
        case 'j':
          e.preventDefault()
          containerRef.current?.scrollBy({
            top: window.innerHeight * 0.8,
            behavior: 'smooth'
          })
          break
        case 'PageUp':
        case 'ArrowUp':
        case 'k':
          e.preventDefault()
          containerRef.current?.scrollBy({
            top: -window.innerHeight * 0.8,
            behavior: 'smooth'
          })
          break
        case 'Home':
          e.preventDefault()
          containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
          break
        case 'End':
          e.preventDefault()
          containerRef.current?.scrollTo({
            top: containerRef.current.scrollHeight,
            behavior: 'smooth'
          })
          break
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  // ─── Render ──────────────────────────────────────────────────────────

  return (
    <div
      className="w-full max-w-lg h-full bg-white dark:bg-gray-950 shadow-2xl flex flex-col"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate flex-1 mr-2">
          {title}
        </h3>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-500"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-5 h-5">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      {/* Pages container */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto px-2 py-4 flex flex-col items-stretch gap-2 bg-gray-100 dark:bg-gray-950"
      >
        {/* Loading state */}
        {loading && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-500">
            <svg className="animate-spin h-8 w-8" viewBox="0 0 24 24" fill="none">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <span className="text-sm">Loading CBZ...</span>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-red-500 px-4">
            <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
            <p className="text-sm font-medium">Failed to load CBZ</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 text-center">{error}</p>
          </div>
        )}

        {/* Page images — lazy decoded */}
        {Array.from({ length: totalPages }, (_, i) => {
          const dataUrl = pageDataUrls.get(i)
          return (
            <div
              key={i}
              data-page={i + 1}
              className="w-full shrink-0 shadow-lg bg-white rounded overflow-hidden"
            >
              {dataUrl ? (
                <img
                  src={dataUrl}
                  alt={`Page ${i + 1}`}
                  className="w-full h-auto"
                  draggable={false}
                />
              ) : (
                <div className="w-full aspect-[3/4] flex items-center justify-center bg-gray-200 dark:bg-gray-800 text-gray-400">
                  <svg className="animate-spin h-6 w-6" viewBox="0 0 24 24" fill="none">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Bottom bar */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <span className="text-xs text-gray-400">CBZ</span>
        <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
          {visiblePage} / {totalPages}
        </span>
        <button
          onClick={onClose}
          className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        >
          Close
        </button>
      </div>
    </div>
  )
}
