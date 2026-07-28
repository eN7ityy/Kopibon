import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// ─── Typed API exposed to renderer ───────────────────────────────────────────

const api = {
  // Search & Gallery
  search: (query: string, options?: { page?: number; sort?: string }) =>
    ipcRenderer.invoke('api:search', query, options),
  getGallery: (id: number) => ipcRenderer.invoke('api:getGallery', id),
  getCdnConfig: () => ipcRenderer.invoke('api:getCdnConfig'),
  getApiConfig: () => ipcRenderer.invoke('api:getConfig'),
  setApiKey: (key: string | null) => ipcRenderer.invoke('api:setApiKey', key),
  getFavorites: (page: number, query?: string) =>
    ipcRenderer.invoke('api:getFavorites', page, query),
  getUser: () => ipcRenderer.invoke('api:getUser'),
  getRelatedGalleries: (id: number) => ipcRenderer.invoke('api:getRelatedGalleries', id),

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
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory')
  },

  // Downloads
  downloads: {
    getAll: () => ipcRenderer.invoke('download:getAll'),
    getById: (id: number) => ipcRenderer.invoke('download:getById', id),
    getByStatus: (status: string) => ipcRenderer.invoke('download:getByStatus', status),
    getByGalleryId: (galleryId: number) =>
      ipcRenderer.invoke('download:getByGalleryId', galleryId),
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
      offset: number; limit: number; sortField?: string; searchQuery?: string
      artistFilters?: string[]; seriesFilters?: string[]; tagFilters?: string[]
      showUnmatchedOnly?: boolean
    }) => ipcRenderer.invoke('library:getPaginated', params),
    getByGalleryId: (galleryId: number) => ipcRenderer.invoke('library:getByGalleryId', galleryId),
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
    autocompleteArtists: (query: string) => ipcRenderer.invoke('library:autocompleteArtists', query),
    autocompleteSeries: (query: string) => ipcRenderer.invoke('library:autocompleteSeries', query),
    autocompleteTags: (query: string) => ipcRenderer.invoke('library:autocompleteTags', query),
    assignSeries: (ids: number[], seriesName: string, seriesIndex?: number) =>
      ipcRenderer.invoke('library:assignSeries', ids, seriesName, seriesIndex),
    delete: (id: number) => ipcRenderer.invoke('library:delete', id),
    deleteFile: (id: number) => ipcRenderer.invoke('library:deleteFile', id),
    getThumbnail: (id: number) => ipcRenderer.invoke('library:getThumbnail', id),
    updateMetadata: (id: number, metadata: Record<string, string | number | null>, libraryRoot?: string) =>
      ipcRenderer.invoke('library:updateMetadata', id, metadata, libraryRoot),
    addCustom: (metadata: Record<string, unknown>, libraryRoot: string) =>
      ipcRenderer.invoke('library:addCustom', metadata, libraryRoot),
    isPathAccessible: (dirPath: string) => ipcRenderer.invoke('library:isPathAccessible', dirPath),
    convertAllMetadata: () => ipcRenderer.invoke('library:convertAllMetadata'),
    cancelConversion: () => ipcRenderer.invoke('library:cancelConversion')
  },

  // Events
  onDownloadProgress: (callback: (progress: {
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
  }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: any) => callback(progress)
    ipcRenderer.on('download:progress', handler)
    return () => { ipcRenderer.removeListener('download:progress', handler) }
  },
  onLibraryScanProgress: (callback: (progress: { current: number; total: number; status: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: { current: number; total: number; status: string }) =>
      callback(progress)
    ipcRenderer.on('library:scanProgress', handler)
    return () => ipcRenderer.removeListener('library:scanProgress', handler)
  },
  onLibraryScanComplete: (callback: (result: { total: number; newItems: number; removedItems: number; errors: string[] }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, result: { total: number; newItems: number; removedItems: number; errors: string[] }) =>
      callback(result)
    ipcRenderer.on('library:scanComplete', handler)
    return () => ipcRenderer.removeListener('library:scanComplete', handler)
  },
  onLibraryScanError: (callback: (error: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: string) => callback(error)
    ipcRenderer.on('library:scanError', handler)
    return () => ipcRenderer.removeListener('library:scanError', handler)
  },
  onLibraryNewItem: (callback: (item: { id: number; title: string; artist: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, item: { id: number; title: string; artist: string }) => callback(item)
    ipcRenderer.on('library:newItem', handler)
    return () => ipcRenderer.removeListener('library:newItem', handler)
  },
  onLibraryNewItems: (callback: (items: Array<{ id: number; title: string; artist: string }>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, items: Array<{ id: number; title: string; artist: string }>) => callback(items)
    ipcRenderer.on('library:newItems', handler)
    return () => ipcRenderer.removeListener('library:newItems', handler)
  },
  onConvertProgress: (callback: (progress: { current: number; total: number; converted: number; failed: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: { current: number; total: number; converted: number; failed: number }) => callback(progress)
    ipcRenderer.on('library:convertProgress', handler)
    return () => ipcRenderer.removeListener('library:convertProgress', handler)
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

  // App
  app: {
    checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
    getVersion: () => ipcRenderer.invoke('app:getVersion')
  },

  // Settings
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    set: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
    setAll: (settings: Record<string, string>) => ipcRenderer.invoke('settings:setAll', settings),
    delete: (key: string) => ipcRenderer.invoke('settings:delete', key)
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
