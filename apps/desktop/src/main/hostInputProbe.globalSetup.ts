import {
  hostInputMonitorDrift,
  HOST_INPUT_PROBE_SUPPORTED,
  startHostInputMonitor,
  type HostInputMonitor
} from './hostInputProbe'

/**
 * Wraps the whole desktop suite in a live Host observation. A dedicated
 * Windows helper subscribes to mouse, keyboard and foreground changes for the
 * entire run and latches a violation even if teardown sees the original state.
 *
 * Opt-in, because it is a measurement of the physical machine — a human who
 * uses the mouse while it runs is drift the run cannot distinguish from a
 * regression. Enable it on an idle machine:
 *
 *     $env:DEVHOTEL_HOST_INPUT_PROBE='1'; pnpm --filter devhotel test
 */
const ENABLED = process.env.DEVHOTEL_HOST_INPUT_PROBE === '1'

let monitor: HostInputMonitor | null = null

export async function setup(): Promise<void> {
  if (!ENABLED) return
  if (!HOST_INPUT_PROBE_SUPPORTED) {
    throw new Error(
      `DEVHOTEL_HOST_INPUT_PROBE=1 was set but the Host input probe is Windows-only (this Host is ${process.platform})`
    )
  }
  monitor = await startHostInputMonitor()
}

export async function teardown(): Promise<void> {
  if (!ENABLED || !monitor) return
  const activeMonitor = monitor
  monitor = null
  const report = await activeMonitor.stop()
  const drift = hostInputMonitorDrift(report)
  if (drift.length) {
    throw new Error(
      `The test run changed Host input state at some point, which breaks the Room isolation contract:\n  ${drift.join('\n  ')}\n` +
        'If a human used the machine during the run, repeat it on an idle desktop before treating this as a regression.'
    )
  }
}
