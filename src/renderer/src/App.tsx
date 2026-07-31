import { HashRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import AppRoutes from './routes'
import { useUiStore } from './stores/ui.store'
import { useSettingsStore } from './stores/settings.store'
import { setupSyncProgressListeners } from './stores/sync-progress.store'
import { setupCbzConversionListeners, useCbzConversionStore } from './stores/cbz-conversion.store'

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

  /**
   * Register background-job listeners once, for the life of the app.
   *
   * These used to be set up inside the progress-bar components, which tore them
   * down on unmount — so navigating away from the library genuinely stopped
   * progress from being tracked, despite a comment claiming otherwise. App never
   * unmounts, so a multi-hour conversion now keeps reporting wherever the user
   * goes, and its state is correct when they come back.
   */
  useEffect(() => {
    const offSync = setupSyncProgressListeners()
    const offCbz = setupCbzConversionListeners()

    // Progress arrives as events, so a window opened while a conversion is
    // already running would show nothing busy — and offer edits the main process
    // refuses. Ask for the current state once at startup.
    window.api.library
      .getCbzConversionState()
      .then((r) => {
        if (r?.success && r.data?.running) useCbzConversionStore.getState().hydrate(r.data)
      })
      .catch(() => {
        /* absence of a running job is the safe assumption */
      })

    return () => {
      offSync()
      offCbz()
    }
  }, [])

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
      <div className="flex h-screen w-screen items-center justify-center bg-app">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
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
