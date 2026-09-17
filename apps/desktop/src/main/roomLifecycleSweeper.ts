import type { RoomLifecycleSweepResult, RoomOrchestrator } from '@devhotel/core'

export interface RoomLifecycleSweeperOptions {
  intervalMs?: number
  onSweep?: (result: RoomLifecycleSweepResult) => void
  onError?: (error: unknown) => void
}

export interface RoomLifecycleSweeper {
  stop(): void
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000

/** Drives persisted Room lifecycle policy without overlapping slow cleanup passes. */
export function startRoomLifecycleSweeper(
  orch: RoomOrchestrator,
  opts: RoomLifecycleSweeperOptions = {}
): RoomLifecycleSweeper {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  let stopped = false
  let running = false

  const sweep = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      const result = await orch.sweepRoomLifecycle()
      opts.onSweep?.(result)
    } catch (error) {
      opts.onError?.(error)
    } finally {
      running = false
    }
  }

  void sweep()
  const timer = setInterval(() => void sweep(), intervalMs)
  timer.unref?.()
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    }
  }
}
