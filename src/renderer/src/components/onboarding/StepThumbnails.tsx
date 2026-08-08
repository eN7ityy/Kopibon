import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../stores/settings.store'
import Button from '../shared/Button'
import PathField from '../shared/PathField'

/**
 * Step 3 — Thumbnail path.
 *
 * Optional. Empty means "use the default", which is shown as a hint below the
 * input. On advance the value (or empty string) is saved to the settings store.
 */
export default function StepThumbnails({
  onNext,
  onBack
}: {
  onNext: () => void
  onBack: () => void
}): React.JSX.Element {
  const settings = useSettingsStore()
  const [path, setPath] = useState('')
  const [defaultPath, setDefaultPath] = useState('')

  useEffect(() => {
    window.api.library
      .getDefaultPaths()
      .then((r) => {
        if (r?.success && r.data?.thumbnailPath) setDefaultPath(String(r.data.thumbnailPath))
      })
      .catch(() => {
        /* the hint simply stays empty */
      })
  }, [])

  const handleContinue = async (): Promise<void> => {
    settings.setThumbnailPath(path.trim())
    await settings.saveToDb()
    onNext()
  }

  return (
    <div>
      <h2 className="text-2xl font-bold tracking-tight text-fg">
        Where should cover thumbnails be cached?
      </h2>
      <p className="mt-3 text-sm text-fg-muted">
        Cover images for your library are cached as small JPEGs so the grid loads instantly. By
        default they live in the app's data folder.
      </p>
      <p className="mt-3 text-sm text-fg-muted">
        You may want to move them to a bigger drive if your library is large — a few thousand
        galleries can take a few hundred megabytes.
      </p>

      <div className="mt-6">
        <PathField
          id="onboarding-thumbnail-path"
          label="Thumbnail path (optional)"
          value={path}
          onChange={setPath}
          hint={defaultPath ? `Default: ${defaultPath}` : undefined}
        />
      </div>

      <div className="mt-8 flex items-center justify-between">
        <Button onClick={onBack}>Back</Button>
        <Button role="primary" onClick={handleContinue}>
          Continue
        </Button>
      </div>
    </div>
  )
}
