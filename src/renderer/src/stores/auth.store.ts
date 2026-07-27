import { create } from 'zustand'

export interface AuthState {
  loggedIn: boolean
  username: string | undefined
  loaded: boolean

  setAuth: (loggedIn: boolean, username?: string) => void
  loadAuthFromMain: () => Promise<void>
  clearAuth: () => void
}

export const useAuthStore = create<AuthState>()((set) => ({
  loggedIn: false,
  username: undefined,
  loaded: false,

  setAuth: (loggedIn, username) => set({ loggedIn, username, loaded: true }),

  loadAuthFromMain: async () => {
    try {
      const result = await window.api.auth.getAuthStatus()
      if (result.success) {
        set({
          loggedIn: result.data.loggedIn,
          username: result.data.username,
          loaded: true
        })
      }
    } catch {
      set({ loggedIn: false, username: undefined, loaded: true })
    }
  },

  clearAuth: () => set({ loggedIn: false, username: undefined })
}))
