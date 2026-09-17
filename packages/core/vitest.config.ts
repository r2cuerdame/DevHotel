import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Every file gets its own process and module registry, so a test-only
    // environment stub or a memoised runtime never leaks between files. The
    // worker count is deliberately not pinned here: `pnpm test` runs the
    // suite in parallel by default and `--maxWorkers=N` is the caller's
    // choice (issue #77).
    pool: 'forks',
    isolate: true,
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
})
