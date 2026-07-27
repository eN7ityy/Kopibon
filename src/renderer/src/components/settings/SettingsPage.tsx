import { useSettingsStore } from '../../stores/settings.store'
import { useUiStore } from '../../stores/ui.store'
import type { ThemeMode } from '../../stores/ui.store'
import type { OutputFormat } from '../../stores/settings.store'

export default function SettingsPage(): React.JSX.Element {
  const settings = useSettingsStore()
  const ui = useUiStore()

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

        {/* API */}
        <section>
          <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-3">API</h2>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                API Key (optional)
              </label>
              <input
                type="password"
                value={settings.apiKey ?? ''}
                onChange={(e) => settings.setApiKey(e.target.value || null)}
                placeholder="Enter nhentai API key for higher rate limits"
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                Increases rate limits from 30 to higher tier
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
