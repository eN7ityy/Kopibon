export default function StatusBar(): React.JSX.Element {
  return (
    <footer className="flex items-center h-8 px-4 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 text-xs text-gray-500 dark:text-gray-400 select-none">
      <span>⬇️ 0 active · 0 queued · 0 in library</span>
      <span className="ml-auto">v1.0.0</span>
    </footer>
  )
}
