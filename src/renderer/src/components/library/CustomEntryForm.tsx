import { useState } from 'react'
import AutocompleteInput from '../shared/AutocompleteInput'
import FormatSelector from '../shared/FormatSelector'
import { useSettingsStore, type OutputFormat } from '../../stores/settings.store'

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
  const [date, setDate] = useState('')
  const [description, setDescription] = useState('')
  const [coverPath, setCoverPath] = useState<string | null>(null)
  const [sourcePath, setSourcePath] = useState<string | null>(null)
  const [sourceType, setSourceType] = useState<'pdf' | 'images'>('pdf')
  // Output format for the entry being created. Defaults to the same setting
  // downloads use so the library stays consistent, but is overridable here.
  const [outputFormat, setOutputFormat] = useState<OutputFormat>(
    useSettingsStore.getState().outputFormat
  )

  // UI state
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  if (!isOpen) return null

  // ─── Artist Chip Handlers ──────────────────────────────────────────────────

  const addArtist = () => {
    const name = artistInput.trim()
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

  const addTag = () => {
    const name = tagInput.trim()
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

  const handleTagKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      addTag()
    }
    if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
      removeTag(tags[tags.length - 1])
    }
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
      }
    } catch {
      // ignore
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

    try {
      const result = await window.api.library.addCustom(
        {
          title: title.trim(),
          artists,
          series: series.trim() || undefined,
          tags: tags.length > 0 ? tags.join(', ') : undefined,
          language: language || undefined,
          date: date || undefined,
          description: description.trim() || undefined,
          coverPath,
          sourcePath,
          sourceType,
          format: outputFormat
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
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 sticky top-0 bg-white dark:bg-gray-900 z-10">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Add Custom Entry
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Add a doujinshi that isn't on nhentai
          </p>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4">
          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Title <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter doujinshi title..."
              className={`w-full px-3 py-2 rounded-lg border bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-purple-500 focus:border-transparent ${
                fieldErrors.title ? 'border-red-500' : 'border-gray-300 dark:border-gray-600'
              }`}
            />
            {fieldErrors.title && (
              <p className="mt-1 text-xs text-red-500">{fieldErrors.title}</p>
            )}
          </div>

          {/* Artists (multi-chip) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Artists <span className="text-red-500">*</span>
            </label>
            <div className={`flex flex-wrap gap-1 p-2 rounded-lg border bg-white dark:bg-gray-800 min-h-[42px] ${
              fieldErrors.artists ? 'border-red-500' : 'border-gray-300 dark:border-gray-600'
            }`}>
              {artists.map((artist) => (
                <span
                  key={artist}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 text-xs font-medium"
                >
                  {artist}
                  <button
                    onClick={() => removeArtist(artist)}
                    className="hover:text-red-500 transition-colors"
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
                  placeholder="Search or type artist name..."
                />
              </div>
              <button
                onClick={addArtist}
                disabled={!artistInput.trim()}
                className="px-2 py-1 rounded bg-purple-600 text-white text-xs font-medium hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Add
              </button>
            </div>
            {fieldErrors.artists && (
              <p className="mt-1 text-xs text-red-500">{fieldErrors.artists}</p>
            )}
            <p className="mt-1 text-xs text-gray-400">
              Type Enter to add, Backspace to remove last
            </p>
          </div>

          {/* Series */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
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
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Tags
            </label>
            <div className="flex flex-wrap gap-1 p-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 min-h-[42px]">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs font-medium"
                >
                  {tag}
                  <button
                    onClick={() => removeTag(tag)}
                    className="hover:text-red-500 transition-colors"
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={handleTagKeyDown}
                placeholder={tags.length === 0 ? 'Type tag and press Enter...' : ''}
                className="flex-1 min-w-[100px] bg-transparent text-sm text-gray-900 dark:text-gray-100 outline-none border-none"
              />
            </div>
          </div>

          {/* Language & Date row */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Language
              </label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-purple-500"
              >
                <option value="">Select language...</option>
                {LANGUAGES.map((lang) => (
                  <option key={lang} value={lang}>{lang}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Date
              </label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-purple-500"
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Summary
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description/summary..."
              rows={3}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-purple-500 resize-none"
            />
          </div>

          {/* Cover image */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Cover Image
            </label>
            <div className="flex items-center gap-3">
              <button
                onClick={handlePickCover}
                className="px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              >
                Choose Image...
              </button>
              {coverPath && (
                <span className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-[200px]">
                  {coverPath.split('/').pop() || coverPath}
                </span>
              )}
              {coverPath && (
                <button
                  onClick={() => setCoverPath(null)}
                  className="text-xs text-red-500 hover:text-red-700"
                >
                  Remove
                </button>
              )}
            </div>
          </div>

          {/* Source */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Source <span className="text-red-500">*</span>
            </label>
            <div className="flex items-center gap-3">
              <button
                onClick={handlePickPdf}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  sourcePath && sourceType === 'pdf'
                    ? 'bg-purple-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                }`}
              >
                📄 PDF File
              </button>
              <button
                onClick={handlePickImageFolder}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  sourcePath && sourceType === 'images'
                    ? 'bg-purple-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                }`}
              >
                🖼️ Image Folder
              </button>
              {sourcePath && (
                <span className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-[200px]">
                  {sourcePath.split('/').pop() || sourcePath}
                </span>
              )}
            </div>
            {fieldErrors.source && (
              <p className="mt-1 text-xs text-red-500">{fieldErrors.source}</p>
            )}
          </div>

          {/* Output format */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Save as
            </label>
            <div className="flex items-center gap-3">
              <FormatSelector value={outputFormat} onChange={setOutputFormat} />
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {outputFormat === 'cbz'
                  ? sourceType === 'pdf'
                    ? 'Pages are extracted from the PDF without re-compressing them.'
                    : 'Images are stored as-is, with metadata in ComicInfo.xml.'
                  : 'Metadata is embedded as XMP.'}
              </span>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3 sticky bottom-0 bg-white dark:bg-gray-900">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-green-600 hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
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
  )
}
