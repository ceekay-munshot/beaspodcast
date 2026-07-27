import { defineConfig } from 'vitest/config'

// Standalone test config — intentionally does NOT extend vite.config.ts, which
// pulls in the live-feed/summary server middleware (server/*). The engine under
// test (src/lib/*) is pure, dependency-free TypeScript; the server/* units under
// test use only node:fs and the global fetch, so a bare node runner stays both
// correct and fast.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
  },
})
