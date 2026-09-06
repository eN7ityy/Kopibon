// ─── Tauri bridge shim (Phase B, 08-GUI §2.1) ───────────────────────────────
// Rebuilds the IDENTICAL `window.api` object (same method names, same
// positional arguments, same envelope passthrough) over Tauri's
// `invoke`/`listen` instead of Electron's `ipcRenderer`.
//
// Wire encoding (B-phase decision, invisible to renderer and logs):
// positional args travel as ONE object `{ args: [...] }` and every Rust
// command takes `args: Vec<Value>` positionally — the exact shape of
// `ipcMain.handle(channel, (event, ...args))`. `undefined` optionals
// (e.g. `options?`, `force?`) arrive as JSON null: Rust treats null as
// absent, matching the `?? default` idioms of the preload.
// Envelope shapes (02-ipc-surface §1.1) are built Rust-side and passed
// through untouched — including thrown-with-errorId, soft-fail-without,
// bare-`{success:bool}` and the raw `log:*` variants.
//
// Event subscriptions return a SYNCHRONOUS unsubscribe closure like the
// preload's `removeListener` returns (02-ipc-surface §1.3). Tauri's
// `listen()` is async, so the shim bridges it: the closure unlistens once
// registered, or cancels a still-pending registration.
//
// 1.x safety: the shim assigns `window.api` ONLY when it is undefined —
// under Electron the preload already set it and the shim is a no-op, so
// 1.x builds and behavior are untouched (D8).
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { CbzConvertProgress } from '../../preload/index'

/** Positional invoke: `api:search` + `(query, options)` → `{ args: [query, options] }`. */
function call<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  return invoke<T>(channel, { args })
}

/** Sync-unsubscribe event binding (see header). */
function on<T>(channel: string, callback: (payload: T) => void): () => void {
  let unlisten: (() => void) | null = null
  let cancelled = false
  void listen<T>(channel, (event) => {
    callback(event.payload)
  }).then((u) => {
    if (cancelled) u()
    else unlisten = u
  })
  return () => {
    if (unlisten) unlisten()
    else cancelled = true
  }
}

const api = {
  // Search & Gallery
  search: (query: string, options?: { page?: number; sort?: string }) =>
    call('api:search', query, options),
  getGallery: (id: number) => call('api:getGallery', id),
  getLatest: (page?: number) => call('api:getLatest', page ?? 1),
  getPopular: () => call('api:getPopular'),
  getCdnConfig: () => call('api:getCdnConfig'),
  getApiConfig: () => call('api:getConfig'),
  setApiKey: (key: string | null) => call('api:setApiKey', key),
  getFavorites: (page: number, query?: string) => call('api:getFavorites', page, query),
  getUser: () => call('api:getUser'),
  getRelatedGalleries: (id: number) => call('api:getRelatedGalleries', id),
  addFavorite: (galleryId: number) => call('api:addFavorite', galleryId),
  removeFavorite: (galleryId: number) => call('api:removeFavorite', galleryId),

  // Auth
  auth: {
    validateKey: (key: string) => call('auth:validateKey', key),
    getAuthStatus: () => call('auth:getAuthStatus'),
    setKey: (key: string) => call('auth:setKey', key),
    clearKey: () => call('auth:clearKey')
  },

  // Shell
  shell: {
    openExternal: (url: string) => call('shell:openExternal', url),
    openPath: (path: string) => call('shell:openPath', path),
    showItemInFolder: (path: string) => call('shell:showItemInFolder', path)
  },

  // Dialogs
  dialog: {
    openFile: (options?: { filters?: Array<{ name: string; extensions: string[] }> }) =>
      call('dialog:openFile', options),
    openDirectory: (defaultPath?: string) => call('dialog:openDirectory', defaultPath)
  },

  // Downloads
  downloads: {
    getAll: () => call('download:getAll'),
    getById: (id: number) => call('download:getById', id),
    getByStatus: (status: string) => call('download:getByStatus', status),
    getByGalleryId: (galleryId: number) => call('download:getByGalleryId', galleryId),
    addToQueue: (galleryId: number, outputFormat?: string, outputDirectory?: string) =>
      call('download:addToQueue', galleryId, outputFormat, outputDirectory),
    remove: (id: number) => call('download:remove', id),
    pause: (id: number) => call('download:pause', id),
    resume: (id: number) => call('download:resume', id),
    cancel: (id: number) => call('download:cancel', id),
    pauseAll: () => call('download:pauseAll'),
    resumeAll: () => call('download:resumeAll'),
    getPages: (queueId: number) => call('download:getPages', queueId),
    getStatusCounts: () => call('download:getStatusCounts')
  },

  // Library
  library: {
    getAll: () => call('library:getAll'),
    getById: (id: number) => call('library:getById', id),
    getPaginated: (params: {
      offset: number
      limit: number
      sortField?: string
      searchQuery?: string
      artistFilters?: string[]
      seriesFilters?: string[]
      tagFilters?: string[]
      showUnmatchedOnly?: boolean
    }) => call('library:getPaginated', params),
    getPaginatedGrouped: (params: {
      offset: number
      limit: number
      sortField?: string
      searchQuery?: string
      artistFilters?: string[]
      seriesFilters?: string[]
      tagFilters?: string[]
      showUnmatchedOnly?: boolean
    }) => call('library:getPaginatedGrouped', params),
    getSeriesMembers: (
      seriesId: number,
      params?: {
        searchQuery?: string
        artistFilters?: string[]
        seriesFilters?: string[]
        tagFilters?: string[]
        showUnmatchedOnly?: boolean
      }
    ) => call('library:getSeriesMembers', seriesId, params ?? {}),
    getSeriesFacts: (
      seriesId: number,
      params?: {
        searchQuery?: string
        artistFilters?: string[]
        seriesFilters?: string[]
        tagFilters?: string[]
        showUnmatchedOnly?: boolean
      }
    ) => call('library:getSeriesFacts', seriesId, params ?? {}),
    findSeries: (name: string) => call('library:findSeries', name),
    getByGalleryId: (galleryId: number) => call('library:getByGalleryId', galleryId),
    getAllIds: (params: {
      searchQuery?: string
      artistFilters?: string[]
      seriesFilters?: string[]
      tagFilters?: string[]
      showUnmatchedOnly?: boolean
    }) => call('library:getAllIds', params),
    getGalleryTags: (galleryId: number) => call('library:getGalleryTags', galleryId),
    search: (query: string) => call('library:search', query),
    getArtists: (libraryItemId: number) => call('library:getArtists', libraryItemId),
    getAllArtistNames: () => call('library:getAllArtistNames'),
    getAllSeriesNames: () => call('library:getAllSeriesNames'),
    getAllTagNames: () => call('library:getAllTagNames'),
    count: () => call('library:count'),
    scan: (libraryRoot: string) => call('library:scan', libraryRoot),
    pauseScan: () => call('library:pauseScan'),
    resumeScan: () => call('library:resumeScan'),
    cancelScan: () => call('library:cancelScan'),
    getScanStatus: () => call('library:getScanStatus'),
    reset: () => call('library:reset'),
    autocompleteArtists: (query: string) => call('library:autocompleteArtists', query),
    autocompleteSeries: (query: string) => call('library:autocompleteSeries', query),
    autocompleteTags: (query: string) => call('library:autocompleteTags', query),
    assignSeries: (
      entries: Array<{ id: number; seriesIndex?: number | null }>,
      seriesName: string
    ) => call('library:assignSeries', entries, seriesName),
    delete: (id: number, alsoFromKavita?: boolean) =>
      call('library:delete', id, alsoFromKavita ?? false),
    deleteFile: (id: number) => call('library:deleteFile', id),
    deleteMultiple: (ids: number[], alsoFromKavita?: boolean) =>
      call('library:deleteMultiple', ids, alsoFromKavita ?? false),
    deleteFileMultiple: (ids: number[]) => call('library:deleteFileMultiple', ids),
    getThumbnail: (id: number) => call('library:getThumbnail', id),
    getPageCount: (id: number) => call('library:getPageCount', id),
    setGalleryId: (itemId: number, galleryId: number | null) =>
      call('library:setGalleryId', itemId, galleryId),
    updateMetadata: (
      id: number,
      metadata: Record<string, string | number | null>,
      libraryRoot?: string
    ) => call('library:updateMetadata', id, metadata, libraryRoot),
    addCustom: (metadata: Record<string, unknown>, libraryRoot: string) =>
      call('library:addCustom', metadata, libraryRoot),
    isPathAccessible: (dirPath: string) => call('library:isPathAccessible', dirPath),
    convertAllMetadata: (runners?: number) => call('library:convertAllMetadata', runners),
    cancelConversion: () => call('library:cancelConversion'),
    convertToCbz: (
      ids: number[],
      dryRun?: boolean,
      options?: { keepOriginal?: boolean; resume?: boolean }
    ) => call('library:convertToCbz', ids, dryRun, options),
    getConversionQueue: () => call('library:getConversionQueue'),
    clearConversionQueue: () => call('library:clearConversionQueue'),
    getDefaultPaths: () => call('library:getDefaultPaths'),
    getOriginalsInfo: () => call('library:getOriginalsInfo'),
    previewSource: (sourcePath: string, sourceType: 'pdf' | 'images') =>
      call('library:previewSource', sourcePath, sourceType),
    restoreOriginals: () => call('library:restoreOriginals'),
    purgeOriginals: (includeLossy?: boolean) => call('library:purgeOriginals', includeLossy),
    cancelConvertToCbz: () => call('library:cancelConvertToCbz'),
    getCbzConversionState: () => call('library:getCbzConversionState'),
    syncItem: (itemId: number) => call('library:syncItem', itemId),
    syncBatch: (ids: number[]) => call('library:syncBatch', ids),
    isSyncing: (itemId: number) => call('library:isSyncing', itemId),
    getSyncQueue: () => call('library:getSyncQueue'),
    clearSyncQueue: () => call('library:clearSyncQueue'),
    resumeSync: () => call('library:syncBatch', []),
    cancelSync: () => call('library:cancelSync'),
    previewSeriesGrouping: () => call('library:previewSeriesGrouping'),
    setSeriesGrouping: (enabled: boolean) => call('library:setSeriesGrouping', enabled),
    renameSeries: (seriesId: number, name: string) =>
      call('library:renameSeries', seriesId, name),
    setSeriesDissolved: (seriesId: number, dissolved: boolean) =>
      call('library:setSeriesDissolved', seriesId, dissolved),
    setSeriesCover: (seriesId: number, itemId: number | null) =>
      call('library:setSeriesCover', seriesId, itemId)
  },

  // File read (for PDF viewer)
  readFile: (filePath: string) => call('file:read', filePath),

  // CBZ reader
  cbz: {
    getPageCount: (filePath: string) => call('cbz:getPageCount', filePath),
    readPage: (filePath: string, pageIndex: number) => call('cbz:readPage', filePath, pageIndex)
  },

  // Events
  onDownloadProgress: (
    callback: (progress: {
      queueId: number
      galleryId: number
      title: string
      status: string
      totalPages: number
      completedPages: number
      percentage: number
      speedKBps: number
      etaSeconds: number
      errorMessage?: string
    }) => void
  ) => on('download:progress', callback),
  onLibraryScanProgress: (
    callback: (progress: { current: number; total: number; status: string }) => void
  ) => on('library:scanProgress', callback),
  onLibraryScanComplete: (
    callback: (result: {
      total: number
      newItems: number
      removedItems: number
      errors: string[]
      removalSkippedReason?: string | null
    }) => void
  ) => on('library:scanComplete', callback),
  onLibraryScanError: (callback: (error: string) => void) => on('library:scanError', callback),
  onLibraryNewItem: (callback: (item: { id: number; title: string; artist: string }) => void) =>
    on('library:newItem', callback),
  onLibraryNewItems: (
    callback: (items: Array<{ id: number; title: string; artist: string }>) => void
  ) => on('library:newItems', callback),
  onSyncProgress: (
    callback: (progress: {
      current: number
      total: number
      title: string
      etaSeconds: number | null
    }) => void
  ) => on('library:syncProgress', callback),
  onSyncComplete: (
    callback: (data: {
      succeeded: number
      failed: number
      total: number
      cancelled?: boolean
    }) => void
  ) => on('library:syncComplete', callback),
  onConvertProgress: (
    callback: (progress: { current: number; total: number; converted: number; failed: number }) => void
  ) => on('library:convertProgress', callback),
  onUpdateStatus: (
    callback: (status: {
      state: 'available' | 'current' | 'downloading' | 'ready' | 'error'
      version?: string
      percent?: number
      message?: string
      releaseNotes?: string | null
    }) => void
  ) => on('app:updateStatus', callback),
  onAddCustomProgress: (
    callback: (p: { phase: string; current: number; total: number }) => void
  ) => on('library:addCustomProgress', callback),
  onConvertToCbzProgress: (callback: (progress: CbzConvertProgress) => void) =>
    on('library:convertToCbzProgress', callback),
  onLibraryScanPaused: (callback: () => void) => on('library:scanPaused', callback),
  onLibraryScanCancelled: (callback: () => void) => on('library:scanCancelled', callback),

  // Logging
  log: {
    write: (level: string, scope: string, msg: string, fields?: Record<string, unknown>) =>
      call('log:write', level, scope, msg, fields),
    getRecords: () => call('log:getRecords'),
    setLevel: (level: string) => call('log:setLevel', level),
    getLevel: () => call('log:getLevel'),
    setRetention: (days: number) => call('log:setRetention', days),
    getRetention: () => call('log:getRetention'),
    openFolder: () => call('log:openFolder'),
    exportDiagnostics: () => call('log:exportDiagnostics')
  },

  // App
  app: {
    checkForUpdates: () => call('app:checkForUpdates'),
    downloadUpdate: () => call('app:downloadUpdate'),
    installUpdate: () => call('app:installUpdate'),
    getUpdateStatus: () => call('app:getUpdateStatus'),
    getVersion: () => call('app:getVersion'),
    checkToolchain: (force?: boolean) => call('app:checkToolchain', force)
  },

  // Settings
  settings: {
    get: (key: string) => call('settings:get', key),
    getAll: () => call('settings:getAll'),
    set: (key: string, value: string) => call('settings:set', key, value),
    setAll: (settings: Record<string, string>) => call('settings:setAll', settings),
    delete: (key: string) => call('settings:delete', key)
  },

  // Kavita
  kavita: {
    testConnection: (url?: string, apiKey?: string) =>
      call('kavita:testConnection', url, apiKey),
    getLibraries: (url?: string, apiKey?: string) => call('kavita:getLibraries', url, apiKey),
    getItemCount: (url?: string, apiKey?: string) => call('kavita:getItemCount', url, apiKey),
    getSeriesDetail: (
      seriesName: string,
      title: string,
      url?: string,
      apiKey?: string,
      filePath?: string
    ) => call('kavita:getSeriesDetail', seriesName, title, url, apiKey, filePath)
  },

  // Search defaults and the blocked-value list
  searchSettings: {
    get: () => call('searchSettings:get'),
    set: (patch: Record<string, unknown>) => call('searchSettings:set', patch),
    buildQuery: (userQuery: string) => call('searchSettings:buildQuery', userQuery),
    evaluateResults: (
      galleries: Array<{
        id: number
        title?: string | null
        tag_ids?: number[]
        blacklisted?: boolean
      }>
    ) => call('search:evaluateResults', galleries)
  },

  blocked: {
    list: () => call('blocked:list'),
    add: (entries: Array<{ type: string; value: string; mode: string }>) =>
      call('blocked:add', entries),
    setMode: (id: number, mode: string) => call('blocked:setMode', id, mode),
    remove: (id: number) => call('blocked:remove', id)
  },

  tags: {
    resolveForGalleries: (galleries: Array<{ id: number; tag_ids?: number[] }>) =>
      call('tags:resolveForGalleries', galleries),
    autocomplete: (query: string, type?: string | null) =>
      call('tags:autocomplete', query, type),
    cacheStats: () => call('tags:cacheStats')
  }
}

// ─── Expose to renderer (no-op under Electron — the preload owns window.api) ─
//
// NOTE on the `Api` type (`src/preload/index.ts`): the preload's event
// subscriptions incidentally return `() => Electron.IpcRenderer`
// (`removeListener` returns the emitter), while the shim honestly returns
// `() => void`. Every renderer call site only invokes the closure and
// ignores the return (verified by grep: `unsubX()` bare calls only), so the
// shapes are runtime-identical and the narrower return is safe. The shim
// therefore carries its own `BridgeApi` type rather than `satisfies Api`;
// channel-name coverage (131 invokes + 14 events) is enforced by B2's
// `npm run contract:bridge` suite, which drives all 144 through this file.

export type BridgeApi = typeof api

if (typeof window !== 'undefined' && typeof window.api === 'undefined') {
  ;(window as unknown as { api: BridgeApi }).api = api
}
