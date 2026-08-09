import { create } from 'zustand'

/**
 * Persisted application settings.
 *
 * Theme is deliberately NOT here: it is owned solely by the ui store, which
 * persists it to localStorage. It previously lived in both places, and only
 * the ui store copy was ever read.
 */
export type OutputFormat = 'pdf' | 'cbz'
export type PageSizeOption = 'Dynamic' | 'Fit to Image' | 'Letter' | 'A4'
export type ReleaseChannel = 'stable' | 'beta'

interface SettingsState {
  libraryPath: string
  /** Where cached covers are written. Empty means the app default. */
  thumbnailPath: string
  /** Where converted PDFs are archived. Empty means <library>/_originals. */
  originalsPath: string
  downloadConcurrency: number
  outputFormat: OutputFormat

  // PDF compression options
  compressPdf: boolean
  compressionQuality: number
  pageSize: PageSizeOption
  blackBackground: boolean

  /**
   * Whether a PDF→CBZ conversion archives the source PDF under `_originals/`
   * rather than deleting it. Only the default — each conversion can override it.
   */
  cbzKeepOriginal: boolean

  // Notification
  showNotifications: boolean

  /**
   * Which update feed the app checks: GitHub's stable releases, or also the
   * pre-releases published from the `test` branch. Read by main
   * (updater.ipc.ts) — the value here only reflects what is persisted.
   */
  releaseChannel: ReleaseChannel

  // Kavita integration (optional — every API call is gated on isConfigured)
  kavitaUrl: string
  kavitaApiKey: string
  kavitaLibraryId: string
  kavitaLibraryRoot: string
  kavitaEnabled: boolean

  /**
   * Whether the first-boot onboarding wizard has been completed. When false
   * (a fresh database, or one that was deleted), App.tsx shows the wizard
   * instead of the normal UI until the user finishes it.
   */
  onboardingCompleted: boolean

  // Track if settings have been loaded from DB
  loaded: boolean

  setLibraryPath: (path: string) => void
  setThumbnailPath: (path: string) => void
  setOriginalsPath: (path: string) => void
  setDownloadConcurrency: (n: number) => void
  setOutputFormat: (format: OutputFormat) => void
  setCompressPdf: (compress: boolean) => void
  setCompressionQuality: (quality: number) => void
  setPageSize: (size: PageSizeOption) => void
  setBlackBackground: (black: boolean) => void
  setCbzKeepOriginal: (keep: boolean) => void
  setShowNotifications: (show: boolean) => void
  setReleaseChannel: (channel: ReleaseChannel) => void
  setKavitaUrl: (value: string) => void
  setKavitaApiKey: (value: string) => void
  setKavitaLibraryId: (value: string) => void
  setKavitaLibraryRoot: (value: string) => void
  setKavitaEnabled: (enabled: boolean) => void
  setOnboardingCompleted: (completed: boolean) => void

  loadFromDb: () => Promise<void>
  saveToDb: () => Promise<void>
}

// Empty rather than a guessed path: there is no library path that makes sense
// on every machine, so a fresh install starts blank and the Settings field
// shows "Not set" until the user configures their own.
const DEFAULT_LIBRARY_PATH = ''

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  libraryPath: DEFAULT_LIBRARY_PATH,
  // Empty rather than a guessed default: main resolves these, and storing a
  // placeholder here would write it to the database as if it were chosen.
  thumbnailPath: '',
  originalsPath: '',
  downloadConcurrency: 3,
  outputFormat: 'cbz',
  compressPdf: true,
  compressionQuality: 80,
  pageSize: 'Dynamic',
  blackBackground: true,
  cbzKeepOriginal: true,
  showNotifications: true,
  releaseChannel: 'stable',

  // Kavita is off until configured; the root pre-fills from libraryPath on load.
  kavitaUrl: 'http://localhost:5000',
  kavitaApiKey: '',
  kavitaLibraryId: '',
  kavitaLibraryRoot: '',
  kavitaEnabled: false,
  onboardingCompleted: false,
  loaded: false,

  setLibraryPath: (path) => set({ libraryPath: path }),
  setThumbnailPath: (path) => set({ thumbnailPath: path }),
  setOriginalsPath: (path) => set({ originalsPath: path }),
  setDownloadConcurrency: (n) => set({ downloadConcurrency: n }),
  setOutputFormat: (format) => set({ outputFormat: format }),
  setCompressPdf: (compress) => set({ compressPdf: compress }),
  setCompressionQuality: (quality) => set({ compressionQuality: Math.max(1, Math.min(95, quality)) }),
  setPageSize: (size) => set({ pageSize: size }),
  setBlackBackground: (black) => set({ blackBackground: black }),
  setCbzKeepOriginal: (keep) => set({ cbzKeepOriginal: keep }),
  setShowNotifications: (show) => set({ showNotifications: show }),
  setReleaseChannel: (channel) => set({ releaseChannel: channel }),
  setKavitaUrl: (value) => set({ kavitaUrl: value }),
  setKavitaApiKey: (value) => set({ kavitaApiKey: value }),
  setKavitaLibraryId: (value) => set({ kavitaLibraryId: value }),
  setKavitaLibraryRoot: (value) => set({ kavitaLibraryRoot: value }),
  setKavitaEnabled: (enabled) => set({ kavitaEnabled: enabled }),
  setOnboardingCompleted: (completed) => set({ onboardingCompleted: completed }),

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

      let defaults: { thumbnailPath?: string; originalsPath?: string } = {}
      try {
        const r = await window.api.library.getDefaultPaths()
        if (r?.success && r.data) defaults = r.data
      } catch {
        // Without them the field simply stays empty, which still works.
      }

      const asNumber = (value: string | undefined, fallback: number): number => {
        const n = Number(value)
        return Number.isFinite(n) ? n : fallback
      }

      set({
        libraryPath: settings.libraryPath || DEFAULT_LIBRARY_PATH,
        // Prefilled with the resolved default when unset, so the field shows the
        // real path instead of an empty box. Fetched from main because only it
        // knows the per-platform userData location.
        thumbnailPath: settings.thumbnailPath || defaults.thumbnailPath || '',
        originalsPath: settings.originalsPath || '',
        downloadConcurrency: asNumber(settings.downloadConcurrency, 3),
        outputFormat: (settings.outputFormat as OutputFormat) ?? 'cbz',
        compressPdf: asBool(settings.compressPdf, true),
        compressionQuality: asNumber(settings.compressionQuality, 80),
        pageSize: (settings.pageSize as PageSizeOption) ?? 'Dynamic',
        blackBackground: asBool(settings.blackBackground, true),
        cbzKeepOriginal: asBool(settings.cbzKeepOriginal, true),
        showNotifications: asBool(settings.showNotifications, true),
        releaseChannel: settings.releaseChannel === 'beta' ? 'beta' : 'stable',
        // The root defaults to the app's library path so the user rarely needs
        // to set it by hand — it only needs to differ when Kavita scans a
        // different root than the app writes into.
        kavitaUrl: settings.kavitaUrl || 'http://localhost:5000',
        kavitaApiKey: settings.kavitaApiKey || '',
        kavitaLibraryId: settings.kavitaLibraryId || '',
        kavitaLibraryRoot:
          settings.kavitaLibraryRoot ||
          settings.libraryPath ||
          DEFAULT_LIBRARY_PATH,
        kavitaEnabled: asBool(settings.kavitaEnabled, false),
        onboardingCompleted: settings.onboardingCompleted === 'true',
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
        thumbnailPath: state.thumbnailPath,
        originalsPath: state.originalsPath,
        downloadConcurrency: String(state.downloadConcurrency),
        outputFormat: state.outputFormat,
        compressPdf: String(state.compressPdf),
        compressionQuality: String(state.compressionQuality),
        pageSize: state.pageSize,
        blackBackground: String(state.blackBackground),
        cbzKeepOriginal: String(state.cbzKeepOriginal),
        showNotifications: String(state.showNotifications),
        releaseChannel: state.releaseChannel,
        kavitaUrl: state.kavitaUrl,
        kavitaApiKey: state.kavitaApiKey,
        kavitaLibraryId: state.kavitaLibraryId,
        kavitaLibraryRoot: state.kavitaLibraryRoot,
        kavitaEnabled: String(state.kavitaEnabled),
        onboardingCompleted: String(state.onboardingCompleted)
      })
    } catch {
      console.error('Failed to save settings to database')
    }
  }
}))
