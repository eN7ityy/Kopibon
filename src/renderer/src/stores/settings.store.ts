import { create } from 'zustand'

/**
 * Persisted application settings.
 *
 * Theme is deliberately NOT here: it is owned solely by the ui store, which
 * persists it to localStorage. It previously lived in both places, and only
 * the ui store copy was ever read.
 */
export type OutputFormat = 'pdf' | 'epub'
export type PageSizeOption = 'Dynamic' | 'Fit to Image' | 'Letter' | 'A4'

interface SettingsState {
  libraryPath: string
  downloadConcurrency: number
  outputFormat: OutputFormat

  // PDF compression options
  compressPdf: boolean
  compressionQuality: number
  pageSize: PageSizeOption
  blackBackground: boolean

  // Notification
  showNotifications: boolean

  // Track if settings have been loaded from DB
  loaded: boolean

  setLibraryPath: (path: string) => void
  setDownloadConcurrency: (n: number) => void
  setOutputFormat: (format: OutputFormat) => void
  setCompressPdf: (compress: boolean) => void
  setCompressionQuality: (quality: number) => void
  setPageSize: (size: PageSizeOption) => void
  setBlackBackground: (black: boolean) => void
  setShowNotifications: (show: boolean) => void

  loadFromDb: () => Promise<void>
  saveToDb: () => Promise<void>
}

const DEFAULT_LIBRARY_PATH = '/mnt/bragi/Kavita/Doujins/'

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  libraryPath: DEFAULT_LIBRARY_PATH,
  downloadConcurrency: 3,
  outputFormat: 'pdf',
  compressPdf: true,
  compressionQuality: 80,
  pageSize: 'Dynamic',
  blackBackground: true,
  showNotifications: true,
  loaded: false,

  setLibraryPath: (path) => set({ libraryPath: path }),
  setDownloadConcurrency: (n) => set({ downloadConcurrency: n }),
  setOutputFormat: (format) => set({ outputFormat: format }),
  setCompressPdf: (compress) => set({ compressPdf: compress }),
  setCompressionQuality: (quality) => set({ compressionQuality: Math.max(1, Math.min(95, quality)) }),
  setPageSize: (size) => set({ pageSize: size }),
  setBlackBackground: (black) => set({ blackBackground: black }),
  setShowNotifications: (show) => set({ showNotifications: show }),

  loadFromDb: async () => {
    try {
      // IPC responses are wrapped as { success, data } — reading fields off
      // the envelope meant every value came back undefined, so the store kept
      // its defaults and a later save silently overwrote the real settings.
      const response = await window.api.settings.getAll()
      const settings = response?.success ? (response.data as Record<string, string>) : null

      if (!settings) {
        set({ loaded: true })
        return
      }

      const asBool = (value: string | undefined, fallback: boolean): boolean =>
        value === undefined ? fallback : value === 'true'

      const asNumber = (value: string | undefined, fallback: number): number => {
        const n = Number(value)
        return Number.isFinite(n) ? n : fallback
      }

      set({
        libraryPath: settings.libraryPath || DEFAULT_LIBRARY_PATH,
        downloadConcurrency: asNumber(settings.downloadConcurrency, 3),
        outputFormat: (settings.outputFormat as OutputFormat) ?? 'pdf',
        compressPdf: asBool(settings.compressPdf, true),
        compressionQuality: asNumber(settings.compressionQuality, 80),
        pageSize: (settings.pageSize as PageSizeOption) ?? 'Dynamic',
        blackBackground: asBool(settings.blackBackground, true),
        showNotifications: asBool(settings.showNotifications, true),
        loaded: true
      })
    } catch {
      set({ loaded: true })
    }
  },

  saveToDb: async () => {
    const state = get()
    try {
      await window.api.settings.setAll({
        libraryPath: state.libraryPath,
        downloadConcurrency: String(state.downloadConcurrency),
        outputFormat: state.outputFormat,
        compressPdf: String(state.compressPdf),
        compressionQuality: String(state.compressionQuality),
        pageSize: state.pageSize,
        blackBackground: String(state.blackBackground),
        showNotifications: String(state.showNotifications)
      })
    } catch {
      console.error('Failed to save settings to database')
    }
  }
}))
