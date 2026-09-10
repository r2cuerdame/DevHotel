import type { OrchestratorEvent } from '@devhotel/core'

/** Room events that can change what the tray menu shows. */
export const TRAY_REBUILD_EVENT_KINDS: ReadonlySet<OrchestratorEvent['kind']> = new Set(['status', 'created', 'deleted'])

export const TRAY_REBUILD_DEBOUNCE_MS = 250

export interface RebuildScheduler {
  /** Ask for one rebuild soon; a burst of requests collapses into one. */
  request(): void
  /** Rebuild now, sharing any rebuild already in flight. */
  now(): Promise<void>
}

/**
 * Collapses a burst of rebuild requests into one debounced rebuild, and never
 * runs two rebuilds at once: a request that arrives mid-rebuild is honoured by
 * exactly one more rebuild afterwards, so the menu never shows a state older
 * than the last event while still paying for one backend probe per burst.
 */
export function createRebuildScheduler(
  rebuild: () => Promise<void>,
  debounceMs = TRAY_REBUILD_DEBOUNCE_MS
): RebuildScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let requestedDuringFlight = false

  const run = (): Promise<void> => {
    if (inFlight) {
      requestedDuringFlight = true
      return inFlight
    }
    inFlight = rebuild()
      .catch(() => undefined)
      .finally(() => {
        inFlight = null
        if (requestedDuringFlight) {
          requestedDuringFlight = false
          request()
        }
      })
    return inFlight
  }

  const request = (): void => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      void run()
    }, debounceMs)
  }

  return { request, now: run }
}
