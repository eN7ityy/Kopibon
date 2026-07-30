import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'services/library-scanner.worker': resolve('src/main/services/library-scanner.worker.ts'),
          'services/download-pdf.worker': resolve('src/main/services/download-pdf.worker.ts'),
          'services/download-cbz.worker': resolve('src/main/services/download-cbz.worker.ts'),
          'services/metadata.worker': resolve('src/main/services/metadata.worker.ts'),
          'services/convert.worker': resolve('src/main/services/convert.worker.ts'),
          'services/sync.worker': resolve('src/main/services/sync.worker.ts')
        }
      }
    },
    resolve: {
      alias: {
        '@main': resolve('src/main')
      }
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
