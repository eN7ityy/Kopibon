import { useEffect, useState } from 'react'
import { BookOpen } from 'lucide-react'
import Button from '../shared/Button'

/**
 * Step 1 — Welcome.
 *
 * Shows the app name, the version string from `app.getVersion()` (read-only,
 * informational — not an update check), a brief description, and a single
 * "Get Started" button that advances to the library step.
 */
export default function StepWelcome({ onNext }: { onNext: () => void }): React.JSX.Element {
  const [version, setVersion] = useState('')

  useEffect(() => {
    window.api.app
      .getVersion()
      .then((r) => {
        if (r?.success && r.data) setVersion(String(r.data))
      })
      .catch(() => {
        /* version is informational; a missing one is not worth blocking on */
      })
  }, [])

  return (
    <div className="flex flex-col items-center text-center">
      <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-accent-wash text-accent">
        <BookOpen size={40} aria-hidden="true" />
      </div>
      <h1 className="text-3xl font-bold tracking-tight text-fg">Welcome to Kopibon</h1>
      {version && <p className="mt-1 text-sm text-fg-faint">v{version}</p>}
      <p className="mt-6 max-w-md text-sm text-fg-muted">
        A desktop tool for downloading doujinshi from nhentai and organising them as a local
        library with Kavita-compatible metadata.
      </p>
      <p className="mt-3 max-w-md text-sm text-fg-muted">
        This wizard will help you set up the essentials. Everything can be changed later in
        Settings.
      </p>
      <div className="mt-8">
        <Button role="primary" onClick={onNext}>
          Get Started
        </Button>
      </div>
    </div>
  )
}
