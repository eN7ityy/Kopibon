import { useState, useEffect } from 'react'
import { Check, X } from 'lucide-react'
import { useSettingsStore } from '../../stores/settings.store'
import Button from '../shared/Button'

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
 * Kavita settings pane.
 *
 * The connection mirrors the nhentai API key section: validating the URL + key
 * persists them immediately, and on the next open the saved connection is
 * restored as a green "Connected …" card with a Remove button. The library is
 * chosen by name — the ID is never hand-entered; it is written to the settings
 * store when a library is picked (or auto-picked when the server has a single
 * library), and Library Root is filled in from the library's folders.
 */
export default function KavitaSettings(): React.JSX.Element {
  const settings = useSettingsStore()

  const [conn, setConn] = useState<ConnState>({ status: 'idle' })
  const [libraries, setLibraries] = useState<LibraryOption[]>([])
  const [selectedLibrary, setSelectedLibrary] = useState<LibraryOption | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [fetchingLibraries, setFetchingLibraries] = useState(false)
  const [libraryError, setLibraryError] = useState<string | null>(null)

  const urlFilled = settings.kavitaUrl.trim().length > 0
  const keyFilled = settings.kavitaApiKey.trim().length > 0
  const connected = conn.status === 'connected'

  // Restore a previously saved connection and library selection. App holds the
  // first paint until settings are loaded, so this runs with the persisted
  // values already in the store.
  useEffect(() => {
    if (!settings.loaded) return undefined
    let cancelled = false

    const url = settings.kavitaUrl.trim()
    const key = settings.kavitaApiKey.trim()

    // Validate the saved connection so the persistent "Connected" card shows
    // without the user having to click Test again. A dead server leaves the
    // pane in the (re-testable) input state rather than erroring.
    if (url && key) {
      window.api.kavita
        .testConnection(url, key)
        .then((r) => {
          if (cancelled || !r.success || !r.data) return
          const data = r.data as { serverVersion?: string; username?: string }
          setConn({ status: 'connected', version: data.serverVersion, username: data.username })
        })
        .catch(() => {
          /* stay in the input state */
        })
    }

    // Resolve a saved library id to its name for the readout.
    if (settings.kavitaLibraryId) {
      window.api.kavita
        .getLibraries(url, key)
        .then((r) => {
          if (cancelled || !r.success || !Array.isArray(r.data)) return
          const match = (r.data as LibraryOption[]).find(
            (l) => String(l.id) === settings.kavitaLibraryId
          )
          if (match) setSelectedLibrary(match)
        })
        .catch(() => {
          /* readout stays empty; Find Libraries can resolve it */
        })
    }

    return () => {
      cancelled = true
    }
    // Run once settings are loaded; the stored values don't change while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.loaded])

  // Editing the URL or key invalidates any earlier test result.
  const resetConnection = (): void => {
    if (conn.status !== 'idle') setConn({ status: 'idle' })
  }

  /**
   * Commit a picked library: write its id to the store (that is what the backend
   * uses) and pre-fill Library Root from the library's first scanned folder.
   */
  const applyLibrary = (lib: LibraryOption): void => {
    settings.setKavitaLibraryId(String(lib.id))
    if (lib.folders.length > 0) settings.setKavitaLibraryRoot(lib.folders[0])
    setSelectedLibrary(lib)
  }

  const handleTestConnection = async (): Promise<void> => {
    if (!urlFilled || !keyFilled) return
    setConn({ status: 'testing' })
    // Pass the form's current values: they are not in the database until Save,
    // and the point of the test is to validate what the user just typed.
    const result = await window.api.kavita.testConnection(settings.kavitaUrl, settings.kavitaApiKey)
    if (result.success && result.data) {
      const data = result.data as { serverVersion?: string; username?: string }
      setConn({ status: 'connected', version: data.serverVersion, username: data.username })
      // Persist immediately so the connection survives a restart — exactly how
      // the nhentai key is saved on validate.
      await settings.saveToDb()
    } else {
      setConn({ status: 'failed', error: result.error || 'Could not connect to Kavita' })
    }
  }

  /** Drop the connection: clears the credential and its library binding. */
  const handleRemove = async (): Promise<void> => {
    settings.setKavitaApiKey('')
    settings.setKavitaLibraryId('')
    setSelectedLibrary(null)
    setConn({ status: 'idle' })
    await settings.saveToDb()
  }

  const handleFindLibraries = async (): Promise<void> => {
    if (!urlFilled || !keyFilled) return
    setFetchingLibraries(true)
    setLibraryError(null)
    try {
      const result = await window.api.kavita.getLibraries(settings.kavitaUrl, settings.kavitaApiKey)
      if (!result.success || !Array.isArray(result.data)) {
        setLibraryError(result.error || 'Could not fetch libraries')
        setPickerOpen(false)
        return
      }
      const libs = result.data as LibraryOption[]
      setLibraries(libs)
      if (libs.length === 0) {
        setLibraryError('No libraries found on the server.')
        setPickerOpen(false)
        return
      }
      if (libs.length === 1) {
        applyLibrary(libs[0])
        setPickerOpen(false)
        return
      }
      // Multiple libraries — let the user pick from the name dropdown.
      setPickerOpen(true)
    } catch (err) {
      setLibraryError(String(err))
      setPickerOpen(false)
    } finally {
      setFetchingLibraries(false)
    }
  }

  const formatVersion = (version?: string): string =>
    version ? (version.startsWith('v') ? version : `v${version}`) : ''

  const openInstance = (): void => {
    window.api.shell.openExternal(settings.kavitaUrl.trim())
  }

  return (
    <section>
      <h2 className="text-section font-semibold text-fg mb-3">Kavita</h2>
      <div className="space-y-3">
        {/* Enable toggle */}
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={settings.kavitaEnabled}
            onChange={(e) => settings.setKavitaEnabled(e.target.checked)}
            className="w-4 h-4 rounded border-line text-accent focus:ring-accent bg-surface"
          />
          <label className="text-sm text-fg">Enable Kavita integration</label>
        </div>
        <p className="text-xs text-fg-faint -mt-2">
          Tells Kavita to scan the library right after files change, so new or
          renamed series appear immediately instead of on the next periodic scan.
        </p>

        {/* Connection — replaced by the persistent card once connected */}
        {!connected ? (
          <>
            <div>
              <label className="block text-sm font-medium text-fg mb-1">Server URL</label>
              <input
                type="text"
                value={settings.kavitaUrl}
                onChange={(e) => {
                  settings.setKavitaUrl(e.target.value)
                  resetConnection()
                }}
                placeholder="http://localhost:5000"
                spellCheck={false}
                className="w-full px-3 py-2 rounded-lg border border-line bg-surface font-mono text-sm text-fg placeholder-fg-faint focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-fg mb-1">API Key</label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={settings.kavitaApiKey}
                  onChange={(e) => {
                    settings.setKavitaApiKey(e.target.value)
                    resetConnection()
                  }}
                  placeholder="Kavita auth key (User Settings → Manage Auth Keys)"
                  className="flex-1 px-3 py-2 rounded-lg border border-line bg-surface text-fg focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <button
                  onClick={handleTestConnection}
                  disabled={conn.status === 'testing' || !urlFilled || !keyFilled}
                  className="shrink-0 px-4 py-2 rounded-lg bg-accent-fill text-white font-medium hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {conn.status === 'testing' ? 'Testing…' : 'Test Connection'}
                </button>
              </div>

              {conn.status === 'failed' && (
                <p className="mt-2 text-sm text-danger flex items-center gap-1">
                  <X size={14} aria-hidden="true" />
                  <span>{conn.error}</span>
                </p>
              )}
            </div>
          </>
        ) : (
          <div className="px-4 py-3 rounded-lg bg-success-wash border border-success flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Check size={18} className="text-success shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-success">
                  Connected to Kavita{conn.version ? ` ${formatVersion(conn.version)}` : ''}
                </p>
                {conn.username && (
                  <button
                    onClick={openInstance}
                    className="text-xs text-success hover:text-success underline transition-colors"
                  >
                    Connected as {conn.username}
                  </button>
                )}
              </div>
            </div>
            <button
              onClick={handleRemove}
              className="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium bg-danger-wash text-danger hover:bg-danger-wash transition-colors"
            >
              Remove
            </button>
          </div>
        )}

        {/* Library — chosen by name; the id goes to the backend */}
        <div>
          <label className="block text-sm font-medium text-fg mb-1">Library</label>
          <Button
            onClick={handleFindLibraries}
            disabled={!urlFilled || !keyFilled || fetchingLibraries}
            extraClass="w-full"
          >
            {fetchingLibraries
              ? 'Loading…'
              : selectedLibrary
                ? 'Change Library'
                : 'Find Libraries'}
          </Button>

          {libraryError && (
            <p className="mt-2 text-sm text-danger flex items-center gap-1">
              <X size={14} aria-hidden="true" />
              <span>{libraryError}</span>
            </p>
          )}

          {pickerOpen && libraries.length > 1 && (
            <div className="mt-2">
              <select
                value={selectedLibrary ? String(selectedLibrary.id) : ''}
                onChange={(e) => {
                  const lib = libraries.find((l) => String(l.id) === e.target.value)
                  if (lib) {
                    applyLibrary(lib)
                    setPickerOpen(false)
                  }
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

          {selectedLibrary && !pickerOpen && (
            <div className="mt-2 px-4 py-3 rounded-lg bg-raised border border-line flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <Check size={18} className="text-success shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg truncate">
                    {selectedLibrary.name} ({selectedLibrary.type})
                  </p>
                  {selectedLibrary.folders.length > 0 && (
                    <p className="text-xs text-fg-muted font-mono truncate">
                      {selectedLibrary.folders[0]}
                    </p>
                  )}
                </div>
              </div>
              <Button size="sm" onClick={handleFindLibraries} extraClass="shrink-0">
                Change
              </Button>
            </div>
          )}
        </div>

        {/* Footer — link to the Kavita auth-key guide */}
        <div className="border-t border-line pt-3">
          <button
            onClick={() =>
              window.api.shell.openExternal(
                'https://wiki.kavitareader.com/guides/user-settings/3rdpartycilents/#auth-key'
              )
            }
            className="text-xs text-accent hover:text-accent underline transition-colors"
          >
            How to create a Kavita auth key
          </button>
        </div>
      </div>
    </section>
  )
}
