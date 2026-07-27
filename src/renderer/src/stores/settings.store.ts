import { create } from 'zustand'

export type OutputFormat = 'pdf' | 'epub'

interface SettingsState {
  libraryPath: string
  apiKey: string | null
  downloadConcurrency: number
  theme: 'light' | 'dark' | 'system'
  outputFormat: OutputFormat

  // Track if settings have been loaded from DB
  loaded: boolean

  setLibraryPath: (path: string) => void
  setApiKey: (key: string | null) => void
  setDownloadConcurrency: (n: number) => void
  setTheme: (theme: 'light' | 'dark' | 'system') => void
  setOutputFormat: (format: OutputFormat) => void

  loadFromDb: () => Promise<void>
  saveToDb: () => Promise<void>
}

const DEFAULT_LIBRARY_PATH = '/mnt/bragi/Kavita/Doujins/'

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  libraryPath: DEFAULT_LIBRARY_PATH,
  apiKey: null,
  downloadConcurrency: 3,
  theme: 'system',
  outputFormat: 'pdf',
  loaded: false,

  setLibraryPath: (path) => set({ libraryPath: path }),
  setApiKey: (key) => set({ apiKey: key }),
  setDownloadConcurrency: (n) => set({ downloadConcurrency: n }),
  setTheme: (theme) => set({ theme }),
  setOutputFormat: (format) => set({ outputFormat: format }),

  loadFromDb: async () => {
    try {
      const settings = await window.api.settings.getAll()
      if (settings) {
        set({
          libraryPath: settings.libraryPath ?? DEFAULT_LIBRARY_PATH,
          apiKey: settings.apiKey ?? null,
          downloadConcurrency: settings.downloadConcurrency ?? 3,
          theme: (settings.theme as 'light' | 'dark' | 'system') ?? 'system',
          outputFormat: (settings.outputFormat as OutputFormat) ?? 'pdf',
          loaded: true
        })
      }
    } catch {
      set({ loaded: true })
    }
  },

  saveToDb: async () => {
    const state = get()
    try {
      await window.api.settings.setAll({
        libraryPath: state.libraryPath,
        apiKey: state.apiKey ?? '',
        downloadConcurrency: String(state.downloadConcurrency),
        theme: String(state.theme),
        outputFormat: state.outputFormat
      })
    } catch {
      console.error('Failed to save settings to database')
    }
  }
}))
