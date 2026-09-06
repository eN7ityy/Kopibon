import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Only the pure, dependency-free units are covered here. Anything that
    // touches Electron, SQLite or a worker thread needs a different harness
    // and is deliberately out of scope for this suite. The bridge contract
    // suite is static file analysis (no imports under test) and rides along.
    include: ['src/**/*.test.ts', 'tests/contract/**/*.test.ts'],
    environment: 'node'
  }
})
