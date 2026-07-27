export default function StatusBar(): React.JSX.Element {
  const handleOpenNhentai = async (): Promise<void> => {
    try {
      await window.api.shell.openExternal('https://nhentai.net')
    } catch {
      // Silently ignore — shell.openExternal may fail in restricted environments
    }
  }

  return (
    <footer className="flex items-center h-8 px-4 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 text-xs text-gray-500 dark:text-gray-400 select-none">
      <span>⬇️ 0 active · 0 queued · 0 in library</span>
      <span className="ml-auto flex items-center gap-3">
        <button
          onClick={handleOpenNhentai}
          className="hover:text-purple-600 dark:hover:text-purple-400 transition-colors cursor-pointer"
          title="Open nhentai.net in browser"
        >
          nhentai.net ↗
        </button>
        <span>v1.0.0</span>
      </span>
    </footer>
  )
}
