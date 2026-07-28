import { useState, useEffect, useRef } from 'react'
import { useSettingsStore } from '../../stores/settings.store'
import { useConversionStore } from '../../stores/conversion.store'
import { useUiStore } from '../../stores/ui.store'
import { useAuthStore } from '../../stores/auth.store'
import type { ThemeMode } from '../../stores/ui.store'
import type { OutputFormat, PageSizeOption } from '../../stores/settings.store'

type ValidationState =
  | { status: 'idle' }
  | { status: 'validating' }
  | { status: 'valid'; username: string }
  | { status: 'invalid'; error: string }

export default function SettingsPage(): React.JSX.Element {
  const settings = useSettingsStore()
  const ui = useUiStore()
  const auth = useAuthStore()

  const [keyInput, setKeyInput] = useState('')
  const [validation, setValidation] = useState<ValidationState>({ status: 'idle' })

  // Reset state
  const [resetConfirm, setResetConfirm] = useState('')
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const [resetSuccess, setResetSuccess] = useState(false)

  console.log('[SettingsPage] Rendering. auth:', auth.loggedIn, 'username:', auth.username)

  // Check auth status on mount
  useEffect(() => {
    if (auth.loggedIn && auth.username) {
      setValidation({ status: 'valid', username: auth.username })
    }
  }, [auth.loggedIn, auth.username])

  const handleValidateAndSave = async (): Promise<void> => {
    if (!keyInput.trim()) return
    setValidation({ status: 'validating' })

    const result = await window.api.auth.validateKey(keyInput.trim())
    if (result.success) {
      setValidation({ status: 'valid', username: result.data.username })
      auth.setAuth(true, result.data.username)
    } else {
      setValidation({ status: 'invalid', error: result.error || 'Invalid API key' })
    }
  }

  const handleClearKey = async (): Promise<void> => {
    await window.api.auth.clearKey()
    setKeyInput('')
    setValidation({ status: 'idle' })
    auth.clearAuth()
  }

  const handleResetLibrary = async (): Promise<void> => {
    if (resetConfirm !== 'DELETE ALL') return
    setResetting(true)
    setResetError(null)
    try {
      const result = await window.api.library.reset()
      if (result.success) {
        setResetSuccess(true)
        setResetConfirm('')
        setTimeout(() => setResetSuccess(false), 3000)
      } else {
        setResetError(result.error || 'Reset failed')
      }
    } catch (err) {
      setResetError(String(err))
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className="flex flex-col h-full max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Settings</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Configure application preferences
        </p>
      </div>

      <div className="space-y-6">
        {/* Library */}
        <section>
          <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-3">Library</h2>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Library Path
              </label>
              <input
                type="text"
                value={settings.libraryPath}
                onChange={(e) => settings.setLibraryPath(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                Directory where doujinshi PDFs are stored
              </p>
            </div>
          </div>
        </section>

        {/* Nhentai Account */}
        <section>
          <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-3">
            Nhentai Account
          </h2>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                API Key
              </label>

              {validation.status !== 'valid' ? (
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={keyInput}
                    onChange={(e) => {
                      setKeyInput(e.target.value)
                      if (validation.status !== 'idle') setValidation({ status: 'idle' })
                    }}
                    placeholder="Enter your nhentai API key"
                    className="flex-1 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                  <button
                    onClick={handleValidateAndSave}
                    disabled={validation.status === 'validating' || !keyInput.trim()}
                    className="px-4 py-2 rounded-lg bg-purple-600 text-white font-medium hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {validation.status === 'validating' ? 'Validating...' : 'Validate & Save'}
                  </button>
                </div>
              ) : (
                <div className="px-4 py-3 rounded-lg bg-green-100 dark:bg-green-900/30 border border-green-300 dark:border-green-700 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-green-600 dark:text-green-400 text-lg">✓</span>
                    <div>
                      <p className="text-sm font-medium text-green-800 dark:text-green-300">
                        API Key Configured
                      </p>
                      <p className="text-xs text-green-600 dark:text-green-400">
                        Connected as {validation.username}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={handleClearKey}
                    className="px-3 py-1.5 rounded-md text-xs font-medium bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              )}

              {/* Validation error */}
              {validation.status === 'invalid' && (
                <p className="mt-2 text-sm text-red-600 dark:text-red-400 flex items-center gap-1">
                  <span>✗</span>
                  <span>{validation.error}</span>
                </p>
              )}

              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                Login is optional. Provides access to favorites and higher rate limits.
              </p>
            </div>
          </div>
        </section>

        {/* Downloads */}
        <section>
          <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-3">
            Downloads
          </h2>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Concurrency: {settings.downloadConcurrency}
              </label>
              <input
                type="range"
                min="1"
                max="8"
                value={settings.downloadConcurrency}
                onChange={(e) => settings.setDownloadConcurrency(Number(e.target.value))}
                className="w-full accent-purple-600"
              />
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                Number of simultaneous downloads (1-8)
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Output Format
              </label>
              <select
                value={settings.outputFormat}
                onChange={(e) => settings.setOutputFormat(e.target.value as OutputFormat)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500"
              >
                <option value="pdf">PDF</option>
                <option value="epub">EPUB (coming soon)</option>
              </select>
            </div>

            <div className="flex items-center gap-3 mb-3">
                <input
                  type="checkbox"
                  checked={settings.showNotifications}
                  onChange={(e) => settings.setShowNotifications(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-400 dark:border-gray-500 text-purple-600 focus:ring-purple-500 bg-white dark:bg-gray-700"
                />
                <label className="text-sm text-gray-700 dark:text-gray-300">
                  Show download notifications
                </label>
              </div>

              <div className="border-t border-gray-200 dark:border-gray-700 pt-3">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">PDF Compression</h3>

              <div className="flex items-center gap-3 mb-3">
                <input
                  type="checkbox"
                  checked={settings.compressPdf}
                  onChange={(e) => settings.setCompressPdf(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-400 dark:border-gray-500 text-purple-600 focus:ring-purple-500 bg-white dark:bg-gray-700"
                />
                <label className="text-sm text-gray-700 dark:text-gray-300">
                  Enable Image Compression (JPEG)
                </label>
              </div>

              <div className="mb-3">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Quality: {settings.compressionQuality}
                </label>
                <input
                  type="range"
                  min="1"
                  max="95"
                  value={settings.compressionQuality}
                  onChange={(e) => settings.setCompressionQuality(Number(e.target.value))}
                  disabled={!settings.compressPdf}
                  className="w-full accent-purple-600 disabled:opacity-40"
                />
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  Higher quality = larger file size (1-95)
                </p>
              </div>

              <div className="mb-3">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Page Size
                </label>
                <select
                  value={settings.pageSize}
                  onChange={(e) => settings.setPageSize(e.target.value as PageSizeOption)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="Dynamic">Dynamic (1800px width, auto height)</option>
                  <option value="Fit to Image">Fit to Image (original dimensions)</option>
                  <option value="Letter">Letter</option>
                  <option value="A4">A4</option>
                </select>
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={settings.blackBackground}
                  onChange={(e) => settings.setBlackBackground(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-400 dark:border-gray-500 text-purple-600 focus:ring-purple-500 bg-white dark:bg-gray-700"
                />
                <label className="text-sm text-gray-700 dark:text-gray-300">
                  Black Background (for Letter/A4)
                </label>
              </div>
            </div>
          </div>
        </section>

        {/* Interface */}
        <section>
          <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-3">
            Interface
          </h2>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Theme
              </label>
              <select
                value={ui.theme}
                onChange={(e) => ui.setTheme(e.target.value as ThemeMode)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500"
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>
          </div>
        </section>

        {/* Reset Library */}
        <section>
          <h2 className="text-lg font-semibold text-red-600 dark:text-red-400 mb-3">Reset Library</h2>
          <div className="p-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 space-y-3">
            <p className="text-sm text-red-700 dark:text-red-400">
              This will permanently delete all library items from the database. Files on disk are <strong>not</strong> affected.
            </p>
            <div>
              <label className="block text-xs font-medium text-red-600 dark:text-red-400 mb-1">
                Type <code className="font-mono bg-red-100 dark:bg-red-900/40 px-1 rounded">DELETE ALL</code> to confirm
              </label>
              <input
                type="text"
                value={resetConfirm}
                onChange={(e) => setResetConfirm(e.target.value)}
                placeholder="DELETE ALL"
                className="w-full px-3 py-2 rounded-lg border border-red-300 dark:border-red-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-red-500"
              />
            </div>
            {resetError && (
              <p className="text-xs text-red-500">{resetError}</p>
            )}
            {resetSuccess && (
              <p className="text-xs text-green-600 dark:text-green-400">✓ Library reset successfully</p>
            )}
            <button
              onClick={handleResetLibrary}
              disabled={resetConfirm !== 'DELETE ALL' || resetting}
              className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {resetting ? 'Resetting...' : 'Reset Library'}
            </button>
          </div>
        </section>

        {/* Advanced */}
        <section>
          <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-3">Advanced</h2>
          <div className="space-y-3">
            <button
              onClick={async () => {
                try {
                  await window.api.app.checkForUpdates()
                } catch { /* silently ignore */ }
              }}
              className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              Check for Updates
            </button>
            <MetadataConverter />
            <AppVersion />
          </div>
        </section>

        {/* Save */}
        <button
          onClick={() => settings.saveToDb()}
          className="px-6 py-2.5 rounded-lg bg-purple-600 text-white font-medium hover:bg-purple-700 transition-colors"
        >
          Save Settings
        </button>
      </div>
    </div>
  )
}

function AppVersion(): React.JSX.Element {
  const [version, setVersion] = useState<string>('...')

  useEffect(() => {
    window.api.app.getVersion().then((r) => {
      if (r.success && r.data) setVersion(r.data)
    }).catch(() => setVersion('unknown'))
  }, [])

  return (
    <p className="text-xs text-gray-400 dark:text-gray-500">
      Doujin Downloader v{version}
    </p>
  )
}

function MetadataConverter(): React.JSX.Element {
  const store = useConversionStore()
  const [showConfirm, setShowConfirm] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  // Auto-scroll log to bottom
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [store.logLines])

  // Listen for progress from main process when running
  useEffect(() => {
    if (!store.running) return undefined
    const cleanup = window.api.onConvertProgress((p) => {
      store.updateProgress({
        current: p.current,
        total: p.total,
        converted: p.converted,
        failed: p.failed,
        logLines: (p as any).logLines
      })
    })
    return () => { cleanup() }
  }, [store.running])

  const handleStart = async () => {
    setShowConfirm(false)
    store.reset()
    store.setRunning(true)
    try {
      const r = await window.api.library.convertAllMetadata()
      if (r.success && r.data) {
        const d = r.data as any
        store.addLogLine(`COMPLETE: ${d.converted} converted, ${d.failed} failed, ${d.total} total`)
      } else {
        store.addLogLine(`ERROR: ${r.error || 'Unknown'}`)
      }
    } catch (e) {
      store.addLogLine(`ERROR: ${String(e)}`)
    }
    store.setRunning(false)
  }

  const handleCancel = async () => {
    await window.api.library.cancelConversion()
    store.addLogLine('Cancelling after current items finish...')
  }

  const pct = store.total > 0 ? Math.round((store.current / store.total) * 100) : 0
  const etaMin = Math.floor(store.etaSeconds / 60)
  const etaSec = store.etaSeconds % 60
  const etaStr = store.etaSeconds > 0
    ? `${etaMin}m ${etaSec}s remaining`
    : ''

  return (
    <div className="space-y-2">
      <button
        onClick={() => setShowConfirm(true)}
        disabled={store.running}
        className="px-4 py-2 rounded-lg border border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400 text-sm font-medium hover:bg-orange-100 dark:hover:bg-orange-900/30 disabled:opacity-50 transition-colors"
      >
        {store.running ? 'Converting...' : 'Convert Library Metadata'}
      </button>
      <p className="text-xs text-gray-400 dark:text-gray-500">
        Re-applies correct XMP metadata to all files and fixes filenames.
      </p>

      {/* Confirmation Dialog */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-md mx-4 shadow-2xl">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">Convert Library Metadata?</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              This will rewrite XMP metadata on ALL files in your library using pikepdf. This may take several minutes for large libraries. Downloads and other operations will not be affected.
            </p>
            <div className="flex gap-3">
              <button onClick={handleStart} className="flex-1 px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:bg-orange-700">Start Conversion</button>
              <button onClick={() => setShowConfirm(false)} className="flex-1 px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Progress bar */}
      {store.running && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-gray-500">
            <span>{store.current}/{store.total} ({store.converted} ok, {store.failed} fail)</span>
            <span>{etaStr}</span>
          </div>
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
            <div className="bg-orange-500 h-2 rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {/* Scrollable log */}
      {store.logLines.length > 0 && (
        <div ref={logRef} className="max-h-40 overflow-y-auto rounded-lg bg-gray-900 text-green-400 text-xs font-mono p-2 space-y-0.5">
          {store.logLines.map((line, i) => (
            <div key={i} className={line.startsWith('ERROR') || line.startsWith('FAIL') ? 'text-red-400' : line.startsWith('COMPLETE') ? 'text-yellow-300' : ''}>{line}</div>
          ))}
        </div>
      )}

      {/* Cancel button */}
      {store.running && (
        <button onClick={handleCancel} className="px-3 py-1 rounded text-xs border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20">
          Cancel Conversion
        </button>
      )}
    </div>
  )
}
