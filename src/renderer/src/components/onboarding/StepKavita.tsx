import { useState } from 'react'
import { Check } from 'lucide-react'
import { useSettingsStore } from '../../stores/settings.store'
import Button from '../shared/Button'
import Notice from '../shared/Notice'

interface LibraryOption {
  id: number
  name: string
  type: string
  folders: string[]
}

type ConnState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'connected'; version?: string; username?: string }
  | { status: 'failed'; error: string }

/**
 * Step 5 — Kavita integration.
 *
 * Skippable. Reuses the same IPC as KavitaSettings (`kavita.testConnection`,
 * `kavita.getLibraries`). On advance the settings are saved if configured.
 */
export default function StepKavita({
  onNext,
  onConfigured
}: {
  onNext: () => void
  onConfigured: (configured: boolean) => void
}): React.JSX.Element {
  const settings = useSettingsStore()
  const [url, setUrl] = useState(settings.kavitaUrl)
  const [apiKey, setApiKey] = useState(settings.kavitaApiKey)
  const [conn, setConn] = useState<ConnState>({ status: 'idle' })
  const [libraries, setLibraries] = useState<LibraryOption[]>([])
  const [selectedLibrary, setSelectedLibrary] = useState<LibraryOption | null>(null)
  const [fetching, setFetching] = useState(false)
  const [libraryError, setLibraryError] = useState<string | null>(null)

  const urlFilled = url.trim().length > 0
  const keyFilled = apiKey.trim().length > 0

  const resetConnection = (): void => {
    if (conn.status !== 'idle') setConn({ status: 'idle' })
  }

  const handleTest = async (): Promise<void> => {
    if (!urlFilled || !keyFilled) return
    setConn({ status: 'testing' })
    const r = await window.api.kavita.testConnection(url, apiKey)
    if (r.success && r.data) {
      const d = r.data as { serverVersion?: string; username?: string }
      setConn({ status: 'connected', version: d.serverVersion, username: d.username })
    } else {
      setConn({ status: 'failed', error: r.error || 'Could not connect to Kavita' })
    }
  }

  const handleFindLibraries = async (): Promise<void> => {
    if (!urlFilled || !keyFilled) return
    setFetching(true)
    setLibraryError(null)
    try {
      const r = await window.api.kavita.getLibraries(url, apiKey)
      if (!r.success || !Array.isArray(r.data)) {
        setLibraryError(r.error || 'Could not fetch libraries')
        return
      }
      const libs = r.data as LibraryOption[]
      setLibraries(libs)
      if (libs.length === 0) {
        setLibraryError('No libraries found on the server.')
        return
      }
      if (libs.length === 1) {
        setSelectedLibrary(libs[0])
      }
      // Multiple libraries: the dropdown below lets the user pick one.
    } catch (err) {
      setLibraryError(String(err))
    } finally {
      setFetching(false)
    }
  }

  const handleContinue = async (): Promise<void> => {
    if (urlFilled && keyFilled && conn.status === 'connected') {
      settings.setKavitaUrl(url.trim())
      settings.setKavitaApiKey(apiKey.trim())
      if (selectedLibrary) settings.setKavitaLibraryId(String(selectedLibrary.id))
      settings.setKavitaEnabled(true)
      await settings.saveToDb()
      onConfigured(true)
    } else {
      onConfigured(false)
    }
    onNext()
  }

  const handleSkip = (): void => {
    onConfigured(false)
    onNext()
  }

  return (
    <div>
      <h2 className="text-2xl font-bold tracking-tight text-fg">Connect to Kavita (optional)</h2>
      <p className="mt-3 text-sm text-fg-muted">
        Kavita is a self-hosted comic and manga server. Kopibon writes metadata that Kavita
        understands and can tell Kavita to rescan when new files arrive.
      </p>

      <div className="mt-6 space-y-4">
        <div>
          <label htmlFor="onboarding-kavita-url" className="block text-sm font-medium text-fg mb-1">
            Server URL
          </label>
          <input
            id="onboarding-kavita-url"
            type="text"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              resetConnection()
            }}
            placeholder="http://localhost:5000"
            spellCheck={false}
            className="w-full px-3 py-2 rounded-lg border border-line bg-surface font-mono text-sm text-fg placeholder-fg-faint focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>

        <div>
          <label htmlFor="onboarding-kavita-key" className="block text-sm font-medium text-fg mb-1">
            API Key
          </label>
          <input
            id="onboarding-kavita-key"
            type="password"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value)
              resetConnection()
            }}
            placeholder="Kavita auth key"
            className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-fg focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={handleTest}
            disabled={!urlFilled || !keyFilled || conn.status === 'testing'}
          >
            {conn.status === 'testing' ? 'Testing…' : 'Test Connection'}
          </Button>
          <Button
            onClick={handleFindLibraries}
            disabled={!urlFilled || !keyFilled || fetching}
          >
            {fetching ? 'Loading…' : 'Find Libraries'}
          </Button>
          {conn.status === 'connected' && (
            <span className="inline-flex items-center gap-1 text-sm text-success">
              <Check size={14} aria-hidden="true" /> Connected
            </span>
          )}
        </div>

        {conn.status === 'failed' && (
          <Notice tone="error">{conn.error}</Notice>
        )}
        {libraryError && <Notice tone="error">{libraryError}</Notice>}

        {libraries.length > 1 && (
          <div>
            <label
              htmlFor="onboarding-kavita-library"
              className="block text-sm font-medium text-fg mb-1"
            >
              Library
            </label>
            <select
              id="onboarding-kavita-library"
              value={selectedLibrary ? String(selectedLibrary.id) : ''}
              onChange={(e) => {
                const lib = libraries.find((l) => String(l.id) === e.target.value)
                if (lib) setSelectedLibrary(lib)
              }}
              className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-fg focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="" disabled>
                Choose a library…
              </option>
              {libraries.map((lib) => (
                <option key={lib.id} value={lib.id}>
                  {lib.name} ({lib.type})
                </option>
              ))}
            </select>
          </div>
        )}

        {selectedLibrary && libraries.length <= 1 && (
          <div className="px-4 py-3 rounded-lg bg-raised border border-line flex items-center gap-2">
            <Check size={16} className="text-success shrink-0" aria-hidden="true" />
            <span className="text-sm font-medium text-fg truncate">
              {selectedLibrary.name} ({selectedLibrary.type})
            </span>
          </div>
        )}
      </div>

      <div className="mt-8 flex items-center justify-between">
        <Button onClick={handleSkip}>Skip for now</Button>
        <Button role="primary" onClick={handleContinue}>
          Continue
        </Button>
      </div>
    </div>
  )
}
