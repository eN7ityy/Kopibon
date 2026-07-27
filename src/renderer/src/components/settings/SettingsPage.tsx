import { useState, useEffect } from 'react'
import { useSettingsStore } from '../../stores/settings.store'
import { useUiStore } from '../../stores/ui.store'
import { useAuthStore } from '../../stores/auth.store'
import type { ThemeMode } from '../../stores/ui.store'
import type { OutputFormat } from '../../stores/settings.store'

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

  console.log('[SettingsPage] Rendering. keyInput:', keyInput, 'apiKey:', settings.apiKey, 'auth:', auth.loggedIn, 'window.api:', typeof window.api?.auth)

  // Load the current key from the store on mount
  useEffect(() => {
    if (settings.apiKey) {
      setKeyInput(settings.apiKey)
      if (auth.loggedIn && auth.username) {
        setValidation({ status: 'valid', username: auth.username })
      }
    }
  }, [settings.apiKey, auth.loggedIn, auth.username])

  const handleValidateAndSave = async (): Promise<void> => {
    if (!keyInput.trim()) return
    setValidation({ status: 'validating' })

    const result = await window.api.auth.validateKey(keyInput.trim())
    if (result.success) {
      setValidation({ status: 'valid', username: result.data.username })
      settings.setApiKey(keyInput.trim())
      auth.setAuth(true, result.data.username)
    } else {
      setValidation({ status: 'invalid', error: result.error || 'Invalid API key' })
    }
  }

  const handleClearKey = async (): Promise<void> => {
    await window.api.auth.clearKey()
    setKeyInput('')
    setValidation({ status: 'idle' })
    settings.setApiKey(null)
    auth.clearAuth()
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

              {/* Validation result */}
              {validation.status === 'valid' && (
                <p className="mt-2 text-sm text-green-600 dark:text-green-400 flex items-center gap-1">
                  <span>✓</span>
                  <span>Connected as {validation.username}</span>
                </p>
              )}
              {validation.status === 'invalid' && (
                <p className="mt-2 text-sm text-red-600 dark:text-red-400 flex items-center gap-1">
                  <span>✗</span>
                  <span>{validation.error}</span>
                </p>
              )}

              {validation.status === 'valid' && (
                <button
                  onClick={handleClearKey}
                  className="mt-2 text-sm text-red-600 dark:text-red-400 hover:underline"
                >
                  Clear Key
                </button>
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
