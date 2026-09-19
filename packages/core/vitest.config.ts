import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Every file gets its own process and module registry, so a test-only
    // environment stub or a memoised runtime never leaks between files. The
    // Keep the default at the concurrency proven by the issue #77 gate.
    // Using every advertised CPU on hosted Windows overloads the SQLite-heavy
    // tests and makes their execution time depend on runner contention. A CLI
    // `--maxWorkers=N` still overrides this when a different lane needs it.
    pool: 'forks',
    isolate: true,
    maxWorkers: 4,
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
})
