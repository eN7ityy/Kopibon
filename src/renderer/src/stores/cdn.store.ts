import { create } from 'zustand'

/**
 * Live CDN server list for image URLs.
 *
 * Every card, cover and download thumbnail used to build URLs against a
 * hardcoded `t.nhentai.net`, which breaks wholesale when that host is slow or
 * down. This module-scope singleton fetches `/cdn` once (through the api-client
 * cache) and every component reads the server lists from it, so preview
 * rotation has a single source of truth without each card fetching its own.
 *
 * `loaded` stays false until the first successful fetch; consumers fall back to
 * a placeholder (or the legacy absolute URL) until then.
 */
interface CdnConfigStore {
  thumbServers: string[]
  imageServers: string[]
  loaded: boolean

  fetch: () => Promise<void>
}

export const useCdnConfigStore = create<CdnConfigStore>()((set) => ({
  thumbServers: [],
  imageServers: [],
  loaded: false,

  fetch: async () => {
    try {
      const result = await window.api.getCdnConfig()
      if (result.success && result.data) {
        set({
          thumbServers: result.data.thumb_servers,
          imageServers: result.data.image_servers,
          loaded: true
        })
      }
    } catch {
      // Leave loaded=false so consumers fall back gracefully.
    }
  }
}))
