import type { RoomOrchestrator } from '@devhotel/core'

export interface DeviceSweeperOptions {
  intervalMs?: number
  onError?: (error: unknown) => void
}

export interface DeviceSweeper {
  stop(): void
}

/** Often enough that a queued project is not left staring at a dead lease. */
const DEFAULT_INTERVAL_MS = 15_000

/**
 * Keeps the shared-phone inventory and the lease table honest while DevHotel
 * runs.
 *
 * Both halves matter and neither can be driven by a request: a phone that is
 * unplugged reports nothing, and the whole point of stale-lease recovery is
 * that the owner is gone and will never call anything again. So the Hotel
 * sweeps on its own clock.
 */
export function startDeviceSweeper(orch: RoomOrchestrator, opts: DeviceSweeperOptions = {}): DeviceSweeper {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  let stopped = false
  let running = false

  const sweep = async (): Promise<void> => {
    // A sweep that outlives its interval must not stack: overlapping passes
    // would race two reclaims onto the same lease.
    if (running || stopped) return
    running = true
    try {
      // Discovery and recovery are independent. A failed `adb devices` must
      // still not leave a dead owner holding the phone, so reclaim regardless.
      try {
        await orch.refreshAndroidDevices()
      } catch (error) {
        opts.onError?.(error)
      }
      try {
        await orch.reapAndroidDevices()
      } catch (error) {
        opts.onError?.(error)
      }
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void sweep(), intervalMs)
  timer.unref?.()

  return {
    stop() {
      stopped = true
      clearInterval(timer)
    }
  }
}
