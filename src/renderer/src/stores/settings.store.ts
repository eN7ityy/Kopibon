import { create } from 'zustand'

export type OutputFormat = 'pdf' | 'epub'
export type PageSizeOption = 'Dynamic' | 'Fit to Image' | 'Letter' | 'A4'

interface SettingsState {
  libraryPath: string
  apiKey: string | null
  downloadConcurrency: number
  theme: 'light' | 'dark' | 'system'
  outputFormat: OutputFormat

  // PDF compression options
  compressPdf: boolean
  compressionQuality: number
  pageSize: PageSizeOption
  blackBackground: boolean

  // Track if settings have been loaded from DB
  loaded: boolean

  setLibraryPath: (path: string) => void
  setApiKey: (key: string | null) => void
  setDownloadConcurrency: (n: number) => void
  setTheme: (theme: 'light' | 'dark' | 'system') => void
  setOutputFormat: (format: OutputFormat) => void
  setCompressPdf: (compress: boolean) => void
  setCompressionQuality: (quality: number) => void
  setPageSize: (size: PageSizeOption) => void
  setBlackBackground: (black: boolean) => void

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
  compressPdf: true,
  compressionQuality: 80,
  pageSize: 'Dynamic',
  blackBackground: true,
  loaded: false,

  setLibraryPath: (path) => set({ libraryPath: path }),
  setApiKey: (key) => set({ apiKey: key }),
  setDownloadConcurrency: (n) => set({ downloadConcurrency: n }),
  setTheme: (theme) => set({ theme }),
  setOutputFormat: (format) => set({ outputFormat: format }),
  setCompressPdf: (compress) => set({ compressPdf: compress }),
  setCompressionQuality: (quality) => set({ compressionQuality: Math.max(1, Math.min(95, quality)) }),
  setPageSize: (size) => set({ pageSize: size }),
  setBlackBackground: (black) => set({ blackBackground: black }),

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
          compressPdf: settings.compressPdf !== undefined ? settings.compressPdf === true || settings.compressPdf === 'true' : true,
          compressionQuality: settings.compressionQuality ? Number(settings.compressionQuality) : 80,
          pageSize: (settings.pageSize as PageSizeOption) ?? 'Dynamic',
          blackBackground: settings.blackBackground !== undefined ? settings.blackBackground === true || settings.blackBackground === 'true' : true,
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
        outputFormat: state.outputFormat,
        compressPdf: String(state.compressPdf),
        compressionQuality: String(state.compressionQuality),
        pageSize: state.pageSize,
        blackBackground: String(state.blackBackground)
      })
    } catch {
      console.error('Failed to save settings to database')
    }
  }
}))
