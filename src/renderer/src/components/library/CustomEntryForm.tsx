import { useState, useEffect } from 'react'
import AutocompleteInput from '../shared/AutocompleteInput'
import FormatSelector from '../shared/FormatSelector'
import ProgressBar from '../shared/ProgressBar'
import { useSettingsStore, type OutputFormat } from '../../stores/settings.store'
import { BookOpen, FileText, Images } from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────────────────

interface CustomEntryFormProps {
  isOpen: boolean
  libraryRoot: string
  onClose: () => void
  onCreated: () => void
}

const LANGUAGES = ['English', 'Japanese', 'Chinese', 'Other'] as const

// ─── Component ───────────────────────────────────────────────────────────────

export default function CustomEntryForm({
  isOpen,
  libraryRoot,
  onClose,
  onCreated
}: CustomEntryFormProps): React.JSX.Element | null {
  // Form fields
  const [title, setTitle] = useState('')
  const [artists, setArtists] = useState<string[]>([])
  const [artistInput, setArtistInput] = useState('')
  const [series, setSeries] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [language, setLanguage] = useState('')
  // Prefilled with today rather than left blank: an entry added now is almost
  // always dated now, and a visible default is clearer than a silent fallback.
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [description, setDescription] = useState('')
  const [coverPath, setCoverPath] = useState<string | null>(null)
  /** data: URL for the cover thumbnail, from the picked file or the source. */
  const [coverPreview, setCoverPreview] = useState<string | null>(null)
  const [previewFromSource, setPreviewFromSource] = useState(false)
  const [sourcePath, setSourcePath] = useState<string | null>(null)
  const [sourceType, setSourceType] = useState<'pdf' | 'images'>('pdf')
  // Output format for the entry being created. Defaults to the same setting
  // downloads use so the library stays consistent, but is overridable here.
  const [outputFormat, setOutputFormat] = useState<OutputFormat>(
    useSettingsStore.getState().outputFormat
  )

  // Compression. On by default for CBZ, off for PDF: a folder of images stored
  // verbatim produced an archive exactly as large as the folder, whereas PDF
  // pages are usually compressed already and re-encoding them just loses
  // quality for little gain.
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [compressEnabled, setCompressEnabled] = useState(
    () => useSettingsStore.getState().outputFormat === 'cbz'
  )
  const [quality, setQuality] = useState(80)
  const [maxDimension, setMaxDimension] = useState<number | null>(null)
  const [pdfPageSize, setPdfPageSize] = useState<'dynamic' | 'fit' | 'letter' | 'a4'>('fit')
  const [blackBackground, setBlackBackground] = useState(false)

  // UI state
  const [submitting, setSubmitting] = useState(false)
  /** Live phase from the main process while the entry is being built. */
  const [progress, setProgress] = useState<{ phase: string; current: number; total: number } | null>(
    null
  )
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    const off = window.api.onAddCustomProgress((p) => setProgress(p))
    return () => { off() }
  }, [])

  if (!isOpen) return null

  // ─── Artist Chip Handlers ──────────────────────────────────────────────────

  const addArtist = (raw?: string) => {
    const name = (raw ?? artistInput).trim()
    if (!name) return
    if (artists.includes(name)) {
      setArtistInput('')
      return
    }
    setArtists([...artists, name])
    setArtistInput('')
  }

  const removeArtist = (name: string) => {
    setArtists(artists.filter((a) => a !== name))
  }

  // ─── Tag Chip Handlers ────────────────────────────────────────────────────

  const addTag = (raw?: string) => {
    const name = (raw ?? tagInput).trim()
    if (!name) return
    if (tags.includes(name)) {
      setTagInput('')
      return
    }
    setTags([...tags, name])
    setTagInput('')
  }

  const removeTag = (name: string) => {
    setTags(tags.filter((t) => t !== name))
  }

  // ─── File Pickers ─────────────────────────────────────────────────────────

  const handlePickPdf = async () => {
    try {
      const result = await window.api.dialog.openFile({
        filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
      })
      if (result.success && result.data) {
        setSourcePath(result.data)
        setSourceType('pdf')
        void loadSourcePreview(result.data, 'pdf')
      }
    } catch {
      // ignore
    }
  }

  const handlePickImageFolder = async () => {
    try {
      const result = await window.api.dialog.openDirectory()
      if (result.success && result.data) {
        setSourcePath(result.data)
        setSourceType('images')
        void loadSourcePreview(result.data, 'images')
      }
    } catch {
      // ignore
    }
  }

  const handlePickCover = async () => {
    try {
      const result = await window.api.dialog.openFile({
        filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
      })
      if (result.success && result.data) {
        setCoverPath(result.data)
        setPreviewFromSource(false)
        // Read it back for the thumbnail. A failure here is cosmetic, so the
        // cover is still accepted with no preview shown.
        const file = await window.api.readFile(result.data)
        setCoverPreview(file?.success && file.data ? `data:image/*;base64,${file.data}` : null)
      }
    } catch {
      // ignore
    }
  }

  /**
   * Show the first page of the source when no cover has been chosen.
   *
   * Saves picking a cover by hand in the common case, where the first page is
   * the cover anyway. Marked as coming from the source so choosing a real cover
   * later replaces it rather than being ignored.
   */
  const loadSourcePreview = async (path: string, type: 'pdf' | 'images') => {
    if (coverPath) return
    try {
      const r = await window.api.library.previewSource(path, type)
      if (r?.success && r.data) {
        setCoverPreview(`data:image/jpeg;base64,${r.data}`)
        setPreviewFromSource(true)
      }
    } catch {
      // A missing preview must never block adding an entry.
    }
  }

  // ─── Validation & Submit ──────────────────────────────────────────────────

  const validate = (): boolean => {
    const errors: Record<string, string> = {}

    if (!title.trim()) errors.title = 'Title is required'
    if (artists.length === 0) errors.artists = 'At least one artist is required'
    if (!sourcePath) errors.source = 'Source file or folder is required'

    setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleSubmit = async () => {
    if (!validate()) return

    setSubmitting(true)
    setError(null)
    setProgress({ phase: 'Preparing', current: 0, total: 0 })

    try {
      const result = await window.api.library.addCustom(
        {
          title: title.trim(),
          artists,
          series: series.trim() || undefined,
          tags: tags.length > 0 ? tags.join(', ') : undefined,
          language: language || undefined,
          // Cleared by hand still means today rather than nothing.
          date: date || new Date().toISOString().slice(0, 10),
          description: description.trim() || undefined,
          coverPath,
          sourcePath,
          sourceType,
          format: outputFormat,
          compression: {
            enabled: compressEnabled,
            quality,
            maxDimension,
            pageSize: pdfPageSize,
            blackBackground
          }
        },
        libraryRoot
      )

      if (result.success) {
        onCreated()
        onClose()
      } else {
        setError(result.error || 'Failed to add custom entry')
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setSubmitting(false)
      setProgress(null)
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-surface rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-line sticky top-0 bg-surface z-10">
          <h2 className="text-section font-semibold text-fg">
            Add Custom Entry
          </h2>
          <p className="text-sm text-fg-muted mt-1">
            Add a doujinshi that isn't on nhentai
          </p>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4">
          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-fg mb-1">
              Title <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter doujinshi title..."
              className={`w-full px-3 py-2 rounded-lg border bg-surface text-sm text-fg focus:ring-2 focus:ring-accent focus:border-transparent ${
                fieldErrors.title ? 'border-danger' : 'border-line'
              }`}
            />
            {fieldErrors.title && (
              <p className="mt-1 text-xs text-danger">{fieldErrors.title}</p>
            )}
          </div>

          {/* Artists (multi-chip) */}
          <div>
            <label className="block text-sm font-medium text-fg mb-1">
              Artists <span className="text-danger">*</span>
            </label>
            <div className={`flex flex-wrap gap-1 p-2 rounded-lg border bg-surface min-h-[42px] ${
              fieldErrors.artists ? 'border-danger' : 'border-line'
            }`}>
              {artists.map((artist) => (
                <span
                  key={artist}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent-wash text-accent text-xs font-medium"
                >
                  {artist}
                  <button
                    onClick={() => removeArtist(artist)}
                    className="hover:text-danger transition-colors"
                  >
                    ×
                  </button>
                </span>
              ))}
              <div className="flex-1 min-w-[120px]">
                <AutocompleteInput
                  kind="artist"
                  value={artistInput}
                  onChange={setArtistInput}
                  onSubmit={addArtist}
                  onEmptyBackspace={() => artists.length > 0 && removeArtist(artists[artists.length - 1])}
                  placeholder="Search or type artist name..."
                />
              </div>
            </div>
            {fieldErrors.artists && (
              <p className="mt-1 text-xs text-danger">{fieldErrors.artists}</p>
            )}
            <p className="mt-1 text-xs text-fg-faint">
              Press Enter to add, Backspace to remove the last one
            </p>
          </div>

          {/* Series */}
          <div>
            <label className="block text-sm font-medium text-fg mb-1">
              Series
            </label>
            <AutocompleteInput
              kind="series"
              value={series}
              onChange={setSeries}
              placeholder="Search or type series name..."
            />
          </div>

          {/* Tags (comma chips) */}
          <div>
            <label className="block text-sm font-medium text-fg mb-1">
              Tags
            </label>
            <div className="flex flex-wrap gap-1 p-2 rounded-lg border border-line bg-surface min-h-[42px]">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-raised text-fg text-xs font-medium"
                >
                  {tag}
                  <button
                    onClick={() => removeTag(tag)}
                    className="hover:text-danger transition-colors"
                  >
                    ×
                  </button>
                </span>
              ))}
              <div className="flex-1 min-w-[120px]">
                <AutocompleteInput
                  kind="tag"
                  value={tagInput}
                  onChange={setTagInput}
                  onSubmit={addTag}
                  onEmptyBackspace={() => tags.length > 0 && removeTag(tags[tags.length - 1])}
                  placeholder={tags.length === 0 ? 'Search or type a tag...' : ''}
                />
              </div>
            </div>
            <p className="mt-1 text-xs text-fg-faint">
              Press Enter to add, Backspace to remove the last one
            </p>
          </div>

          {/* Language & Date row */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-fg mb-1">
                Language
              </label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm text-fg focus:ring-2 focus:ring-accent"
              >
                <option value="">Select language...</option>
                {LANGUAGES.map((lang) => (
                  <option key={lang} value={lang}>{lang}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-fg mb-1">
                Date
              </label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm text-fg focus:ring-2 focus:ring-accent"
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-fg mb-1">
              Summary
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description/summary..."
              rows={3}
              className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm text-fg focus:ring-2 focus:ring-accent resize-none"
            />
          </div>

          {/* Cover image */}
          <div>
            <label className="block text-sm font-medium text-fg mb-1">
              Cover Image
            </label>
            <div className="flex items-start gap-3">
              {/* Preview: the chosen cover, or the source's first page as a
                  stand-in so the entry is never a blank card. */}
              <div className="w-[90px] h-[120px] shrink-0 rounded-lg border border-line bg-raised overflow-hidden flex items-center justify-center">
                {coverPreview ? (
                  <img src={coverPreview} alt="Cover preview" className="w-full h-full object-cover" />
                ) : (
                  <BookOpen size={22} strokeWidth={1.5} className="text-fg-faint" aria-hidden="true" />
                )}
              </div>

              <div className="min-w-0 space-y-2">
                <div className="flex items-center gap-2">
                  <button
                    onClick={handlePickCover}
                    className="px-3 py-2 rounded-lg bg-raised text-sm text-fg hover:bg-raised transition-colors"
                  >
                    Choose Image...
                  </button>
                  {coverPath && (
                    <button
                      onClick={() => {
                        setCoverPath(null)
                        setCoverPreview(null)
                        setPreviewFromSource(false)
                        // Fall back to the source's first page again.
                        if (sourcePath) void loadSourcePreview(sourcePath, sourceType)
                      }}
                      className="text-xs text-danger hover:text-danger"
                    >
                      Remove
                    </button>
                  )}
                </div>
                {coverPath ? (
                  <p className="text-xs text-fg-muted break-all">{coverPath}</p>
                ) : (
                  <p className="text-xs text-fg-faint">
                    {previewFromSource
                      ? 'Using the first page of the source.'
                      : 'Optional. The first page of the source is used when empty.'}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Source */}
          <div>
            <label className="block text-sm font-medium text-fg mb-1">
              Source <span className="text-danger">*</span>
            </label>
            <div className="flex items-center gap-3">
              <button
                onClick={handlePickPdf}
                className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  sourcePath && sourceType === 'pdf'
                    ? 'bg-accent-fill text-white'
                    : 'bg-raised text-fg hover:bg-raised'
                }`}
              >
                <FileText size={14} aria-hidden="true" /> PDF File
              </button>
              <button
                onClick={handlePickImageFolder}
                className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  sourcePath && sourceType === 'images'
                    ? 'bg-accent-fill text-white'
                    : 'bg-raised text-fg hover:bg-raised'
                }`}
              >
                <Images size={14} aria-hidden="true" /> Image Folder
              </button>
            </div>
            {sourcePath && (
              // Full path, not just the basename: several folders of images are
              // usually named alike, and the leaf alone does not identify which.
              <p className="mt-1.5 text-xs text-fg-muted break-all">
                {sourcePath}
              </p>
            )}
            {fieldErrors.source && (
              <p className="mt-1 text-xs text-danger">{fieldErrors.source}</p>
            )}
          </div>

          {/* Output format */}
          <div>
            <label className="block text-sm font-medium text-fg mb-1">
              Save as
            </label>
            <div className="flex items-center gap-3">
              <FormatSelector
                value={outputFormat}
                onChange={(f) => {
                  setOutputFormat(f)
                  // CBZ on, PDF off: storing images verbatim in an archive wastes
                  // space, whereas PDF pages are usually already compressed.
                  setCompressEnabled(f === 'cbz')
                }}
              />
              <span className="text-xs text-fg-muted">
                {outputFormat === 'cbz'
                  ? sourceType === 'pdf'
                    ? 'Pages are extracted from the PDF without re-compressing them.'
                    : 'Images are stored as-is, with metadata in ComicInfo.xml.'
                  : 'Metadata is embedded as XMP.'}
              </span>
            </div>
          </div>

          {/* Advanced: compression */}
          <div className="border-t border-line pt-3">
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-2 text-sm font-medium text-fg hover:text-fg"
            >
              <span className="text-xs">{showAdvanced ? '\u25BC' : '\u25B6'}</span>
              Advanced
              <span className="text-xs font-normal text-fg-faint">
                {compressEnabled
                  ? `compressing at quality ${quality}${maxDimension ? `, max ${maxDimension}px` : ''}`
                  : 'no compression'}
              </span>
            </button>

            {showAdvanced && (
              <div className="mt-3 space-y-3 pl-4 border-l-2 border-line">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={compressEnabled}
                    onChange={(e) => setCompressEnabled(e.target.checked)}
                    className="mt-0.5 w-4 h-4 rounded border-line text-accent focus:ring-accent"
                  />
                  <div>
                    <label className="text-sm text-fg">
                      Re-encode pages
                    </label>
                    <p className="text-xs text-fg-faint mt-0.5">
                      {outputFormat === 'cbz'
                        ? 'Off means pages are stored exactly as they are, so the archive ends up as large as the source.'
                        : 'Off means the source images are embedded untouched.'}
                    </p>
                  </div>
                </div>

                {/* PDF sources are usually compressed already, so re-encoding
                    them mostly costs quality. Worth saying out loud. */}
                {compressEnabled && sourceType === 'pdf' && (
                  <div className="p-2.5 rounded-lg bg-warning-wash border border-warning">
                    <p className="text-xs text-warning">
                      This source is a PDF, and its pages are most likely compressed already.
                      Re-encoding them loses a little quality each time for a small size gain. Leave
                      this off unless the file is unusually large.
                    </p>
                  </div>
                )}

                {compressEnabled && (
                  <>
                    <div>
                      <label className="block text-sm text-fg mb-1">
                        JPEG quality: <span className="tabular-nums">{quality}</span>
                      </label>
                      <input
                        type="range"
                        min={40}
                        max={95}
                        value={quality}
                        onChange={(e) => setQuality(Number(e.target.value))}
                        className="w-full accent-accent"
                      />
                      <div className="flex justify-between text-xs text-fg-faint">
                        <span>40, smaller</span>
                        <span>95, better</span>
                      </div>
                    </div>

                    {outputFormat === 'cbz' ? (
                      <div>
                        <label className="block text-sm text-fg mb-1">
                          Maximum page size
                        </label>
                        <select
                          value={maxDimension ?? 0}
                          onChange={(e) =>
                            setMaxDimension(Number(e.target.value) || null)
                          }
                          className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm text-fg"
                        >
                          <option value={0}>Original size</option>
                          <option value={1600}>1600 px longest edge</option>
                          <option value={2000}>2000 px longest edge</option>
                          <option value={2400}>2400 px longest edge</option>
                        </select>
                        <p className="text-xs text-fg-faint mt-1">
                          Pages smaller than the cap are left alone rather than upscaled.
                        </p>
                      </div>
                    ) : (
                      <>
                        <div>
                          <label className="block text-sm text-fg mb-1">
                            Page size
                          </label>
                          <select
                            value={pdfPageSize}
                            onChange={(e) =>
                              setPdfPageSize(e.target.value as 'dynamic' | 'fit' | 'letter' | 'a4')
                            }
                            className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-sm text-fg"
                          >
                            <option value="fit">Fit to image</option>
                            <option value="dynamic">Dynamic</option>
                            <option value="letter">Letter</option>
                            <option value="a4">A4</option>
                          </select>
                        </div>
                        <label className="flex items-center gap-2 text-sm text-fg">
                          <input
                            type="checkbox"
                            checked={blackBackground}
                            onChange={(e) => setBlackBackground(e.target.checked)}
                            className="w-4 h-4 rounded border-line text-accent focus:ring-accent"
                          />
                          Black page background
                        </label>
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="p-3 rounded-lg bg-danger-wash border border-danger text-danger text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-line sticky bottom-0 bg-surface space-y-3">
          {/* Same shared bar as every other job in the app. total is 0 for the
              steps that are not per-page, which renders as indeterminate. */}
          {submitting && progress && (
            <ProgressBar
              id="add-custom"
              label={progress.phase}
              current={progress.current}
              total={progress.total}
              tone="write"
            />
          )}

          <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded-lg text-sm font-medium text-fg bg-raised hover:bg-raised transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-success-fill hover:bg-success-fill transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {submitting ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Adding...
              </>
            ) : (
              'Add to Library'
            )}
          </button>
          </div>
        </div>
      </div>
    </div>
  )
}
