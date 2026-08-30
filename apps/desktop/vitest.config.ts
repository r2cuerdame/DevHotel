import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Opt-in continuous observation that the suite leaves the Host desktop
    // alone; a no-op unless DEVHOTEL_HOST_INPUT_PROBE=1.
    globalSetup: ['./src/main/hostInputProbe.globalSetup.ts']
  }
})
