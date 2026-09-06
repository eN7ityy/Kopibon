// Tauri-only Vite config (Phase B). 1.x keeps electron.vite.config.ts
// untouched — this file serves the SAME renderer (src/renderer/) to the
// Tauri webview for `tauri dev` (devUrl) and `tauri build` (frontendDist).
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'src/renderer',
  resolve: {
    alias: {
      '@': resolve('src/renderer/src'),
      '@renderer': resolve('src/renderer/src')
    }
  },
  plugins: [react(), tailwindcss()],
  // Tauri expects the dev server on a fixed port (devUrl in tauri.conf.json).
  server: { port: 1420, strictPort: true },
  build: { outDir: resolve('dist'), emptyOutDir: true },
  clearScreen: false
})
