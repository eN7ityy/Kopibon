import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// ─── Typed API exposed to renderer ───────────────────────────────────────────

const api = {
  // Search & Gallery
  search: (
    query: string,
    options?: { page?: number; sort?: string; language?: string; category?: string }
  ) => ipcRenderer.invoke('api:search', query, options),
  getGallery: (id: number) => ipcRenderer.invoke('api:getGallery', id),
  getCdnConfig: () => ipcRenderer.invoke('api:getCdnConfig'),
  getApiConfig: () => ipcRenderer.invoke('api:getConfig'),
  setApiKey: (key: string | null) => ipcRenderer.invoke('api:setApiKey', key),
  getFavorites: (page: number, query?: string) =>
    ipcRenderer.invoke('api:getFavorites', page, query),
  getUser: () => ipcRenderer.invoke('api:getUser'),

  // Auth
  auth: {
    validateKey: (key: string) => ipcRenderer.invoke('auth:validateKey', key),
    getAuthStatus: () => ipcRenderer.invoke('auth:getAuthStatus'),
    setKey: (key: string) => ipcRenderer.invoke('auth:setKey', key),
    clearKey: () => ipcRenderer.invoke('auth:clearKey')
  },

  // Shell
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url)
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
    getByGalleryId: (galleryId: number) => ipcRenderer.invoke('library:getByGalleryId', galleryId),
    search: (query: string) => ipcRenderer.invoke('library:search', query),
    getArtists: (libraryItemId: number) => ipcRenderer.invoke('library:getArtists', libraryItemId),
    getAllArtistNames: () => ipcRenderer.invoke('library:getAllArtistNames'),
    count: () => ipcRenderer.invoke('library:count')
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
