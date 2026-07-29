import { useState, useEffect, useRef, useCallback } from 'react'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.min.mjs'

// Set worker using legacy build (avoids private-fields compatibility issue);
// fall back to CDN if the bundled path doesn't resolve in the renderer.
try {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
    import.meta.url
  ).toString()
} catch {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.x/pdf.worker.min.mjs'
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface PdfViewerProps {
  filePath: string
  title: string
  onClose: () => void
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function PdfViewer({
  filePath,
  title,
  onClose
}: PdfViewerProps): React.JSX.Element {
  const [loading, setLoading] = useState(true)
  const [totalPages, setTotalPages] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [scale, setScale] = useState(1.0)
  const [pageCanvases, setPageCanvases] = useState<HTMLCanvasElement[]>([])
  const [visiblePage, setVisiblePage] = useState(1)
  const [renderProgress, setRenderProgress] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const bottomBarRef = useRef<HTMLDivElement>(null)

  // ─── Load & render PDF ───────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false

    const loadPdf = async () => {
      setLoading(true)
      setError(null)
      setPageCanvases([])

      try {
        // Read file via IPC → base64 string
        const result = await window.api.readFile(filePath)
        if (!result.success) {
          setError(result.error || 'Failed to read file')
          return
        }

        // Decode base64 → ArrayBuffer
        const binaryStr = atob(result.data)
        const bytes = new Uint8Array(binaryStr.length)
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i)
        }
        const arrayBuffer = bytes.buffer

        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
        if (cancelled) return

        setTotalPages(pdf.numPages)

        if (pdf.numPages === 0) {
          setError('This PDF has no pages')
          return
        }

        // Render all pages to canvases
        const canvases: HTMLCanvasElement[] = []
        for (let i = 1; i <= pdf.numPages; i++) {
          if (cancelled) return

          setRenderProgress(`Rendering page ${i}/${pdf.numPages}...`)

          const page = await pdf.getPage(i)
          const viewport = page.getViewport({ scale })
          const canvas = document.createElement('canvas')
          canvas.width = viewport.width
          canvas.height = viewport.height
          canvas.style.display = 'block'
          canvas.style.width = '100%'
          canvas.style.height = 'auto'
          await page.render({ canvas, viewport }).promise
          canvases.push(canvas)

          // Yield to event loop every 5 pages to prevent UI freeze
          if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0))
        }

        if (cancelled) return
        setPageCanvases(canvases)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load PDF')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
          setRenderProgress(null)
        }
      }
    }

    loadPdf()
    return () => {
      cancelled = true
    }
  }, [filePath, scale])

  // ─── Intersection Observer for visible page ──────────────────────────────

  useEffect(() => {
    if (!containerRef.current || pageCanvases.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const pageNum = Number(entry.target.getAttribute('data-page'))
            if (!isNaN(pageNum)) setVisiblePage(pageNum)
          }
        }
      },
      { threshold: 0.5, root: containerRef.current }
    )

    const elements = containerRef.current.querySelectorAll('[data-page]')
    elements.forEach((el) => observer.observe(el))

    return () => observer.disconnect()
  }, [pageCanvases])

  // ─── Zoom ────────────────────────────────────────────────────────────────

  const zoomIn = useCallback(() => setScale((s) => Math.min(s + 0.25, 4)), [])
  const zoomOut = useCallback(() => setScale((s) => Math.max(s - 0.25, 0.5)), [])

  // ─── Keyboard navigation ─────────────────────────────────────────────────

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
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
        case '+':
        case '=':
          zoomIn()
          break
        case '-':
          zoomOut()
          break
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose, zoomIn, zoomOut])

  // ─── Render ──────────────────────────────────────────────────────────────

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

      {/* Page canvases (scrollable) */}
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
            <span className="text-sm">
              {renderProgress || 'Opening PDF...'}
            </span>
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
            <p className="text-sm font-medium">Failed to load PDF</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 text-center">{error}</p>
            <button
              onClick={() => {
                setError(null)
                setLoading(true)
                setPageCanvases([])
              }}
              className="mt-2 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700"
            >
              Retry
            </button>
          </div>
        )}

        {/* Page canvases */}
        {pageCanvases.map((canvas, i) => (
          <div
            key={i}
            data-page={i + 1}
            className="w-full shadow-lg bg-white rounded overflow-hidden"
            ref={(el) => {
              if (el && canvas.parentElement !== el) el.appendChild(canvas)
            }}
          />
        ))}
      </div>

      {/* Bottom bar */}
      <div
        ref={bottomBarRef}
        className="flex items-center justify-between px-4 py-2 border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"
      >
        <div className="flex items-center gap-3">
          <button
            onClick={zoomOut}
            className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 text-lg font-bold w-7 h-7 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-800"
            title="Zoom out"
          >
            −
          </button>
          <span className="text-xs text-gray-400 tabular-nums w-10 text-center">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={zoomIn}
            className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 text-lg font-bold w-7 h-7 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-800"
            title="Zoom in"
          >
            +
          </button>
        </div>
        <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
          {visiblePage} / {totalPages}
        </span>
        <span className="text-xs text-gray-400">PDF</span>
      </div>
    </div>
  )
}
