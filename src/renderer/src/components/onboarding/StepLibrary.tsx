import { useState } from 'react'
import { useSettingsStore } from '../../stores/settings.store'
import Button from '../shared/Button'
import PathField from '../shared/PathField'
import Notice from '../shared/Notice'

/**
 * Step 2 — Library path.
 *
 * Required. The path is saved to the settings store (and the DB) on advance,
 * so closing the app mid-wizard keeps what was typed. A non-existent path is
 * allowed — it shows a yellow notice but the user can still continue (the
 * folder is created on first download).
 */
export default function StepLibrary({
  onNext,
  onBack,
  scanAfterSetup,
  setScanAfterSetup
}: {
  onNext: () => void
  onBack: () => void
  scanAfterSetup: boolean
  setScanAfterSetup: (checked: boolean) => void
}): React.JSX.Element {
  const settings = useSettingsStore()
  const [path, setPath] = useState(settings.libraryPath)
  const [error, setError] = useState<string | null>(null)
  const [pathExists, setPathExists] = useState<boolean | null>(null)

  const checkPath = async (value: string): Promise<void> => {
    if (!value.trim()) {
      setPathExists(null)
      return
    }
    try {
      const r = await window.api.library.isPathAccessible(value)
      setPathExists(r.success ? (r.data as boolean) : null)
    } catch {
      setPathExists(null)
    }
  }

  const handleContinue = async (): Promise<void> => {
    if (!path.trim()) {
      setError('Please enter a library path.')
      return
    }
    setError(null)
    settings.setLibraryPath(path.trim())
    await settings.saveToDb()
    onNext()
  }

  return (
    <div>
      <h2 className="text-2xl font-bold tracking-tight text-fg">Where should your doujinshi live?</h2>
      <p className="mt-3 text-sm text-fg-muted">
        Kopibon stores downloaded galleries here and scans this folder for files you already
        have. The scanner looks for PDF and CBZ files, reads their metadata, generates cover
        thumbnails, and organizes them by artist and series.
      </p>

      <div className="mt-6">
        <PathField
          id="onboarding-library-path"
          label="Library path"
          value={path}
          onChange={(v) => {
            setPath(v)
            void checkPath(v)
          }}
          placeholder="/mnt/storage/Kavita/Doujins"
        />
      </div>

      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {!error && pathExists === false && (
        <div className="mt-3">
          <Notice tone="warning">
            This folder doesn't exist yet — it will be created when you download your first
            gallery.
          </Notice>
        </div>
      )}

      <label className="mt-5 flex items-center gap-3">
        <input
          type="checkbox"
          checked={scanAfterSetup}
          onChange={(e) => setScanAfterSetup(e.target.checked)}
          className="w-4 h-4 rounded border-line text-accent focus:ring-accent bg-surface"
        />
        <span className="text-sm text-fg">Scan for existing files after setup</span>
      </label>

      <div className="mt-8 flex items-center justify-between">
        <Button onClick={onBack}>Back</Button>
        <Button role="primary" onClick={handleContinue}>
          Continue
        </Button>
      </div>
    </div>
  )
}
