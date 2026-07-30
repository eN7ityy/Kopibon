import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Only the pure, dependency-free units are covered here. Anything that
    // touches Electron, SQLite or a worker thread needs a different harness
    // and is deliberately out of scope for this suite.
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
})
