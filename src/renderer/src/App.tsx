import { HashRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import AppRoutes from './routes'
import { useUiStore } from './stores/ui.store'
import { useSettingsStore } from './stores/settings.store'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 2
    }
  }
})

function App(): React.JSX.Element {
  const theme = useUiStore((s) => s.theme)
  const loadSettings = useSettingsStore((s) => s.loadFromDb)
  const settingsLoaded = useSettingsStore((s) => s.loaded)

  // Pull persisted settings out of the DB before anything reads them.
  // Without this the store served hardcoded defaults for the whole session.
  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') {
      root.classList.add('dark')
    } else if (theme === 'light') {
      root.classList.remove('dark')
    } else {
      // system
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      root.classList.toggle('dark', prefersDark)
    }
  }, [theme])

  // Hold the first paint until settings exist, so pages that depend on the
  // library path don't briefly act on a default value.
  if (!settingsLoaded) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-white dark:bg-gray-950">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-purple-500 border-t-transparent" />
      </div>
    )
  }

  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </QueryClientProvider>
  )
}

export default App
