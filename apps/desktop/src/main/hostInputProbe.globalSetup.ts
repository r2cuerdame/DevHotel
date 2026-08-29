import { captureHostInputSnapshot, hostInputDrift, HOST_INPUT_PROBE_SUPPORTED, type HostInputSnapshot } from './hostInputProbe'

/**
 * Wraps the whole desktop suite in a live Host observation: sample the real
 * cursor, foreground window and keyboard before the first test, sample again
 * after the last one, and fail the run if any of them moved.
 *
 * Opt-in, because it is a measurement of the physical machine — a human who
 * uses the mouse while it runs is drift the run cannot distinguish from a
 * regression. Enable it on an idle machine:
 *
 *     $env:DEVHOTEL_HOST_INPUT_PROBE='1'; pnpm --filter devhotel test
 */
const ENABLED = process.env.DEVHOTEL_HOST_INPUT_PROBE === '1'

let before: HostInputSnapshot | null = null

export async function setup(): Promise<void> {
  if (!ENABLED) return
  if (!HOST_INPUT_PROBE_SUPPORTED) {
    throw new Error(
      `DEVHOTEL_HOST_INPUT_PROBE=1 was set but the Host input probe is Windows-only (this Host is ${process.platform})`
    )
  }
  before = await captureHostInputSnapshot()
  if (!before.interactiveDesktop) {
    throw new Error(
      'Host input probe found no interactive desktop (cursor and foreground window both read zero). ' +
        'Run it from a logged-in session; a session-0 sample cannot prove the Host was left alone.'
    )
  }
}

export async function teardown(): Promise<void> {
  if (!ENABLED || !before) return
  const after = await captureHostInputSnapshot()
  const drift = hostInputDrift(before, after)
  if (drift.length) {
    throw new Error(
      `The test run changed Host input state, which breaks the Room isolation contract:\n  ${drift.join('\n  ')}\n` +
        'If a human used the machine during the run, repeat it on an idle desktop before treating this as a regression.'
    )
  }
}
