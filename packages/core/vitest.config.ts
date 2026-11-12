import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Every file gets its own process and module registry, so a test-only
    // environment stub or a memoised runtime never leaks between files.
    // Run one isolated file at a time in CI to leave capacity for Vitest's
    // coordinator and task-update RPCs on smaller Windows runners. Keep the
    // full suite and its test/hook deadlines; local concurrency stays at the
    // issue #77 gate, and CLI --maxWorkers=N can still select another lane.
    pool: 'forks',
    isolate: true,
    maxWorkers: process.env.CI ? 1 : 4,
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
})
