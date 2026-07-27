/// <reference types="vite/client" />

declare module '*.svg' {
  const content: string
  export default content
}

declare module '*.png' {
  const content: string
  export default content
}

interface Window {
  api: import('../preload/index').Api
  electron: import('@electron-toolkit/preload').ElectronAPI
}
