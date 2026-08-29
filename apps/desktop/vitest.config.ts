import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Opt-in live check that the suite left the Host desktop alone; a no-op
    // unless DEVHOTEL_HOST_INPUT_PROBE=1. See docs/host-input-isolation.md.
    globalSetup: ['./src/main/hostInputProbe.globalSetup.ts']
  }
})
