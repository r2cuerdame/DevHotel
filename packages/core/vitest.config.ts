import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Every file gets its own process and module registry, so a test-only
    // environment stub or a memoised runtime never leaks between files. The
    // Keep local runs at the concurrency proven by the issue #77 gate. Hosted
    // Windows runners need spare capacity for Vitest's coordinator: four busy
    // forks can delay worker RPC replies past Vitest's fixed 60-second limit
    // even after every assertion passed. A CLI `--maxWorkers=N` still
    // overrides this when a different lane needs it.
    pool: 'forks',
    isolate: true,
    maxWorkers: process.env.CI ? 2 : 4,
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
})
