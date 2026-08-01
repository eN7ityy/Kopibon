import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// ─── Typed API exposed to renderer ───────────────────────────────────────────

/**
 * PDF → CBZ conversion progress.
 *
 * `activeIds` and `queuedIds` are what let the library mark individual rows
 * busy: the main process refuses edits on those items, so the UI has to know
 * which ones rather than merely that *something* is converting.
 */
export interface CbzConvertProgress {
  current: number
  total: number
  converted: number
  failed: number
  /** Selected items that were not PDFs and so were never queued. */
  skipped?: number
  running?: boolean
  activeIds?: number[]
  queuedIds?: number[]
  logLines?: string[]
}

const api = {
  // Search & Gallery
  search: (query: string, options?: { page?: number; sort?: string }) =>
    ipcRenderer.invoke('api:search', query, options),
  getGallery: (id: number) => ipcRenderer.invoke('api:getGallery', id),
  getLatest: (page?: number) => ipcRenderer.invoke('api:getLatest', page ?? 1),
  getPopular: () => ipcRenderer.invoke('api:getPopular'),
  getCdnConfig: () => ipcRenderer.invoke('api:getCdnConfig'),
  getApiConfig: () => ipcRenderer.invoke('api:getConfig'),
  setApiKey: (key: string | null) => ipcRenderer.invoke('api:setApiKey', key),
  getFavorites: (page: number, query?: string) =>
    ipcRenderer.invoke('api:getFavorites', page, query),
  getUser: () => ipcRenderer.invoke('api:getUser'),
  getRelatedGalleries: (id: number) => ipcRenderer.invoke('api:getRelatedGalleries', id),
  checkFavorite: (galleryId: number) => ipcRenderer.invoke('api:checkFavorite', galleryId),
  addFavorite: (galleryId: number) => ipcRenderer.invoke('api:addFavorite', galleryId),
  removeFavorite: (galleryId: number) => ipcRenderer.invoke('api:removeFavorite', galleryId),

  // Auth
  auth: {
    validateKey: (key: string) => ipcRenderer.invoke('auth:validateKey', key),
    getAuthStatus: () => ipcRenderer.invoke('auth:getAuthStatus'),
    setKey: (key: string) => ipcRenderer.invoke('auth:setKey', key),
    clearKey: () => ipcRenderer.invoke('auth:clearKey')
  },

  // Shell
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
    showItemInFolder: (path: string) => ipcRenderer.invoke('shell:showItemInFolder', path)
  },

  // Dialogs
  dialog: {
    openFile: (options?: { filters?: Array<{ name: string; extensions: string[] }> }) =>
      ipcRenderer.invoke('dialog:openFile', options),
    openDirectory: (defaultPath?: string) =>
      ipcRenderer.invoke('dialog:openDirectory', defaultPath)
  },

  // Downloads
  downloads: {
    getAll: () => ipcRenderer.invoke('download:getAll'),
    getById: (id: number) => ipcRenderer.invoke('download:getById', id),
    getByStatus: (status: string) => ipcRenderer.invoke('download:getByStatus', status),
    getByGalleryId: (galleryId: number) => ipcRenderer.invoke('download:getByGalleryId', galleryId),
    addToQueue: (galleryId: number, outputFormat?: string, outputDirectory?: string) =>
      ipcRenderer.invoke('download:addToQueue', galleryId, outputFormat, outputDirectory),
    remove: (id: number) => ipcRenderer.invoke('download:remove', id),
    pause: (id: number) => ipcRenderer.invoke('download:pause', id),
    resume: (id: number) => ipcRenderer.invoke('download:resume', id),
    cancel: (id: number) => ipcRenderer.invoke('download:cancel', id),
    pauseAll: () => ipcRenderer.invoke('download:pauseAll'),
    resumeAll: () => ipcRenderer.invoke('download:resumeAll'),
    getPages: (queueId: number) => ipcRenderer.invoke('download:getPages', queueId),
    getStatusCounts: () => ipcRenderer.invoke('download:getStatusCounts')
  },

  // Library
  library: {
    getAll: () => ipcRenderer.invoke('library:getAll'),
    getById: (id: number) => ipcRenderer.invoke('library:getById', id),
    getPaginated: (params: {
      offset: number
      limit: number
      sortField?: string
      searchQuery?: string
      artistFilters?: string[]
      seriesFilters?: string[]
      tagFilters?: string[]
      showUnmatchedOnly?: boolean
    }) => ipcRenderer.invoke('library:getPaginated', params),
    /**
     * One page with series collapsed into single rows.
     *
     * Rows come back tagged 'item' or 'series'. When grouping is switched off
     * every row is an 'item', so the caller does not branch on the setting.
     */
    getPaginatedGrouped: (params: {
      offset: number
      limit: number
      sortField?: string
      searchQuery?: string
      artistFilters?: string[]
      seriesFilters?: string[]
      tagFilters?: string[]
      showUnmatchedOnly?: boolean
    }) => ipcRenderer.invoke('library:getPaginatedGrouped', params),
    /** Item ids a series card stands for, honouring the active filters. */
    getSeriesMembers: (
      seriesId: number,
      params?: {
        searchQuery?: string
        artistFilters?: string[]
        seriesFilters?: string[]
        tagFilters?: string[]
        showUnmatchedOnly?: boolean
      }
    ) => ipcRenderer.invoke('library:getSeriesMembers', seriesId, params ?? {}),
    /**
     * The whole series for its detail panel: members in reading order, each
     * flagged as matching the active filters, plus merged tags and gaps.
     */
    getSeriesFacts: (
      seriesId: number,
      params?: {
        searchQuery?: string
        artistFilters?: string[]
        seriesFilters?: string[]
        tagFilters?: string[]
        showUnmatchedOnly?: boolean
      }
    ) => ipcRenderer.invoke('library:getSeriesFacts', seriesId, params ?? {}),
    /**
     * The group a series name refers to, or null when there is none to open.
     * Null whenever grouping is off, or the name holds only one gallery.
     */
    findSeries: (name: string) => ipcRenderer.invoke('library:findSeries', name),
    getByGalleryId: (galleryId: number) => ipcRenderer.invoke('library:getByGalleryId', galleryId),
    /** Ids of every item matching the given filters, ignoring pagination. */
    getAllIds: (params: {
      searchQuery?: string
      artistFilters?: string[]
      seriesFilters?: string[]
      tagFilters?: string[]
      showUnmatchedOnly?: boolean
    }) => ipcRenderer.invoke('library:getAllIds', params),
    /** Typed tags from the cached gallery row; empty when only flat tags exist. */
    getGalleryTags: (galleryId: number) => ipcRenderer.invoke('library:getGalleryTags', galleryId),
    search: (query: string) => ipcRenderer.invoke('library:search', query),
    getArtists: (libraryItemId: number) => ipcRenderer.invoke('library:getArtists', libraryItemId),
    getAllArtistNames: () => ipcRenderer.invoke('library:getAllArtistNames'),
    getAllSeriesNames: () => ipcRenderer.invoke('library:getAllSeriesNames'),
    getAllTagNames: () => ipcRenderer.invoke('library:getAllTagNames'),
    count: () => ipcRenderer.invoke('library:count'),
    scan: (libraryRoot: string) => ipcRenderer.invoke('library:scan', libraryRoot),
    pauseScan: () => ipcRenderer.invoke('library:pauseScan'),
    resumeScan: () => ipcRenderer.invoke('library:resumeScan'),
    cancelScan: () => ipcRenderer.invoke('library:cancelScan'),
    getScanStatus: () => ipcRenderer.invoke('library:getScanStatus'),
    reset: () => ipcRenderer.invoke('library:reset'),
    autocompleteArtists: (query: string) =>
      ipcRenderer.invoke('library:autocompleteArtists', query),
    autocompleteSeries: (query: string) => ipcRenderer.invoke('library:autocompleteSeries', query),
    autocompleteTags: (query: string) => ipcRenderer.invoke('library:autocompleteTags', query),
    assignSeries: (
      entries: Array<{ id: number; seriesIndex?: number | null }>,
      seriesName: string
    ) => ipcRenderer.invoke('library:assignSeries', entries, seriesName),
    delete: (id: number) => ipcRenderer.invoke('library:delete', id),
    deleteFile: (id: number) => ipcRenderer.invoke('library:deleteFile', id),
    getThumbnail: (id: number) => ipcRenderer.invoke('library:getThumbnail', id),
    updateMetadata: (
      id: number,
      metadata: Record<string, string | number | null>,
      libraryRoot?: string
    ) => ipcRenderer.invoke('library:updateMetadata', id, metadata, libraryRoot),
    addCustom: (metadata: Record<string, unknown>, libraryRoot: string) =>
      ipcRenderer.invoke('library:addCustom', metadata, libraryRoot),
    isPathAccessible: (dirPath: string) => ipcRenderer.invoke('library:isPathAccessible', dirPath),
    convertAllMetadata: (runners?: number) =>
      ipcRenderer.invoke('library:convertAllMetadata', runners),
    cancelConversion: () => ipcRenderer.invoke('library:cancelConversion'),
    convertToCbz: (
      ids: number[],
      dryRun?: boolean,
      options?: { keepOriginal?: boolean; resume?: boolean }
    ) => ipcRenderer.invoke('library:convertToCbz', ids, dryRun, options),
    /** Outstanding conversion work left by an interrupted run. */
    getConversionQueue: () => ipcRenderer.invoke('library:getConversionQueue'),
    clearConversionQueue: () => ipcRenderer.invoke('library:clearConversionQueue'),
    /** The paths the thumbnail and originals settings fall back to when unset. */
    getDefaultPaths: () => ipcRenderer.invoke('library:getDefaultPaths'),
    getOriginalsInfo: () => ipcRenderer.invoke('library:getOriginalsInfo'),
    /** Base64 JPEG preview of a source's first page, for the add-entry form. */
    previewSource: (sourcePath: string, sourceType: 'pdf' | 'images') =>
      ipcRenderer.invoke('library:previewSource', sourcePath, sourceType),
    /** Put archived PDFs back and delete the CBZs that replaced them. */
    restoreOriginals: () => ipcRenderer.invoke('library:restoreOriginals'),
    purgeOriginals: (includeLossy?: boolean) =>
      ipcRenderer.invoke('library:purgeOriginals', includeLossy),
    cancelConvertToCbz: () => ipcRenderer.invoke('library:cancelConvertToCbz'),
    getCbzConversionState: () => ipcRenderer.invoke('library:getCbzConversionState'),
    syncItem: (itemId: number) => ipcRenderer.invoke('library:syncItem', itemId),
    syncBatch: (ids: number[]) => ipcRenderer.invoke('library:syncBatch', ids),
    isSyncing: (itemId: number) => ipcRenderer.invoke('library:isSyncing', itemId)
  },

  // File read (for PDF viewer)
  readFile: (filePath: string) => ipcRenderer.invoke('file:read', filePath),

  // CBZ reader
  cbz: {
    getPageCount: (filePath: string) => ipcRenderer.invoke('cbz:getPageCount', filePath),
    readPage: (filePath: string, pageIndex: number) =>
      ipcRenderer.invoke('cbz:readPage', filePath, pageIndex)
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
  ) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: any) => callback(progress)
    ipcRenderer.on('download:progress', handler)
    return () => {
      ipcRenderer.removeListener('download:progress', handler)
    }
  },
  onLibraryScanProgress: (
    callback: (progress: { current: number; total: number; status: string }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      progress: { current: number; total: number; status: string }
    ) => callback(progress)
    ipcRenderer.on('library:scanProgress', handler)
    return () => ipcRenderer.removeListener('library:scanProgress', handler)
  },
  onLibraryScanComplete: (
    callback: (result: {
      total: number
      newItems: number
      removedItems: number
      errors: string[]
      removalSkippedReason?: string | null
    }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      result: {
        total: number
        newItems: number
        removedItems: number
        errors: string[]
        removalSkippedReason?: string | null
      }
    ) => callback(result)
    ipcRenderer.on('library:scanComplete', handler)
    return () => ipcRenderer.removeListener('library:scanComplete', handler)
  },
  onLibraryScanError: (callback: (error: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: string) => callback(error)
    ipcRenderer.on('library:scanError', handler)
    return () => ipcRenderer.removeListener('library:scanError', handler)
  },
  onLibraryNewItem: (callback: (item: { id: number; title: string; artist: string }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      item: { id: number; title: string; artist: string }
    ) => callback(item)
    ipcRenderer.on('library:newItem', handler)
    return () => ipcRenderer.removeListener('library:newItem', handler)
  },
  onLibraryNewItems: (
    callback: (items: Array<{ id: number; title: string; artist: string }>) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      items: Array<{ id: number; title: string; artist: string }>
    ) => callback(items)
    ipcRenderer.on('library:newItems', handler)
    return () => ipcRenderer.removeListener('library:newItems', handler)
  },
  onSyncProgress: (
    callback: (progress: {
      current: number
      total: number
      title: string
      etaSeconds: number | null
    }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      progress: { current: number; total: number; title: string; etaSeconds: number | null }
    ) => callback(progress)
    ipcRenderer.on('library:syncProgress', handler)
    return () => ipcRenderer.removeListener('library:syncProgress', handler)
  },
  onSyncComplete: (
    callback: (data: { succeeded: number; failed: number; total: number }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { succeeded: number; failed: number; total: number }
    ) => callback(data)
    ipcRenderer.on('library:syncComplete', handler)
    return () => ipcRenderer.removeListener('library:syncComplete', handler)
  },
  onConvertProgress: (
    callback: (progress: {
      current: number
      total: number
      converted: number
      failed: number
    }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      progress: { current: number; total: number; converted: number; failed: number }
    ) => callback(progress)
    ipcRenderer.on('library:convertProgress', handler)
    return () => ipcRenderer.removeListener('library:convertProgress', handler)
  },
  /**
   * Updater state changes.
   *
   * `ready` means an update has downloaded and will apply on restart — the
   * previous implementation only raised a native notification, so a staged
   * update was invisible and applied without the user knowing why the app
   * changed.
   */
  onUpdateStatus: (
    callback: (status: {
      state: 'available' | 'current' | 'downloading' | 'ready' | 'error'
      version?: string
      percent?: number
      message?: string
    }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      status: Parameters<typeof callback>[0]
    ): void => callback(status)
    ipcRenderer.on('app:updateStatus', handler)
    return () => ipcRenderer.removeListener('app:updateStatus', handler)
  },
  /**
   * Progress while a custom entry is being built.
   *
   * Re-encoding a folder of pages takes long enough that the dialog looked hung
   * without it. `total` is 0 for the steps that are not per-page.
   */
  onAddCustomProgress: (
    callback: (p: { phase: string; current: number; total: number }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      p: { phase: string; current: number; total: number }
    ): void => callback(p)
    ipcRenderer.on('library:addCustomProgress', handler)
    return () => ipcRenderer.removeListener('library:addCustomProgress', handler)
  },
  onConvertToCbzProgress: (callback: (progress: CbzConvertProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: CbzConvertProgress): void =>
      callback(progress)
    ipcRenderer.on('library:convertToCbzProgress', handler)
    return () => ipcRenderer.removeListener('library:convertToCbzProgress', handler)
  },
  onLibraryScanPaused: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('library:scanPaused', handler)
    return () => ipcRenderer.removeListener('library:scanPaused', handler)
  },
  onLibraryScanCancelled: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('library:scanCancelled', handler)
    return () => ipcRenderer.removeListener('library:scanCancelled', handler)
  },

  // Logging (§1.6 — renderer console output is invisible in a packaged build)
  log: {
    write: (level: string, scope: string, msg: string, fields?: Record<string, unknown>) =>
      ipcRenderer.invoke('log:write', level, scope, msg, fields),
    getRecords: () => ipcRenderer.invoke('log:getRecords'),
    setLevel: (level: string) => ipcRenderer.invoke('log:setLevel', level),
    getLevel: () => ipcRenderer.invoke('log:getLevel'),
    setRetention: (days: number) => ipcRenderer.invoke('log:setRetention', days),
    getRetention: () => ipcRenderer.invoke('log:getRetention'),
    openFolder: () => ipcRenderer.invoke('log:openFolder'),
    exportDiagnostics: () => ipcRenderer.invoke('log:exportDiagnostics')
  },

  // App
  app: {
    checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
    /** Apply a staged update and relaunch. No-op until one has downloaded. */
    installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    /** Probe Python/pikepdf and poppler. `force` re-checks after installing. */
    checkToolchain: (force?: boolean) => ipcRenderer.invoke('app:checkToolchain', force)
  },

  // Settings
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    set: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
    setAll: (settings: Record<string, string>) => ipcRenderer.invoke('settings:setAll', settings),
    delete: (key: string) => ipcRenderer.invoke('settings:delete', key)
  },

  /** Search defaults and the blocked-value list. */
  searchSettings: {
    get: () => ipcRenderer.invoke('searchSettings:get'),
    set: (patch: Record<string, unknown>) => ipcRenderer.invoke('searchSettings:set', patch),
    /**
     * The query the API should receive, composed in main from the defaults and
     * the blocked list, so the renderer never assembles nhentai query syntax.
     */
    buildQuery: (userQuery: string) => ipcRenderer.invoke('searchSettings:buildQuery', userQuery),
    /** Which results to mark, and what matched, for the `dim` entries. */
    evaluateResults: (
      galleries: Array<{
        id: number
        title?: string | null
        tag_ids?: number[]
        blacklisted?: boolean
      }>
    ) => ipcRenderer.invoke('search:evaluateResults', galleries)
  },

  blocked: {
    list: () => ipcRenderer.invoke('blocked:list'),
    add: (entries: Array<{ type: string; value: string; mode: string }>) =>
      ipcRenderer.invoke('blocked:add', entries),
    setMode: (id: number, mode: string) => ipcRenderer.invoke('blocked:setMode', id, mode),
    remove: (id: number) => ipcRenderer.invoke('blocked:remove', id)
  },

  tags: {
    /** Tag names per gallery id, for marking results that match a dim entry. */
    resolveForGalleries: (galleries: Array<{ id: number; tag_ids?: number[] }>) =>
      ipcRenderer.invoke('tags:resolveForGalleries', galleries),
    autocomplete: (query: string, type?: string | null) =>
      ipcRenderer.invoke('tags:autocomplete', query, type),
    cacheStats: () => ipcRenderer.invoke('tags:cacheStats')
  }
}

export type Api = typeof api

// ─── Expose to renderer ─────────────────────────────────────────────────────

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('Failed to expose API:', error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
