export interface RefreshCoalescer {
  /** The Room list needs one refresh soon. */
  rooms(): void
  /** One Room's inspection needs one refresh soon. */
  inspection(roomId: string): void
  /** Run whatever is pending now. */
  flush(): void
}

export const REFRESH_COALESCE_MS = 25

/**
 * Collapses a burst of Room events into one Room-list refresh and one
 * inspection refresh per Room, so one logical status revision costs one IPC
 * round trip of each kind however many events or channels announced it.
 */
export function createRefreshCoalescer(
  handlers: { refreshRooms: () => unknown; refreshInspection: (roomId: string) => unknown },
  opts: { delayMs?: number; schedule?: (run: () => void, delayMs: number) => unknown } = {}
): RefreshCoalescer {
  let pending: { rooms: boolean; inspections: Set<string> } | null = null
  const schedule = opts.schedule ?? ((run, delayMs) => setTimeout(run, delayMs))

  const flush = (): void => {
    const batch = pending
    pending = null
    if (!batch) return
    if (batch.rooms) void handlers.refreshRooms()
    for (const roomId of batch.inspections) void handlers.refreshInspection(roomId)
  }

  const arm = (): { rooms: boolean; inspections: Set<string> } => {
    if (!pending) {
      pending = { rooms: false, inspections: new Set() }
      schedule(flush, opts.delayMs ?? REFRESH_COALESCE_MS)
    }
    return pending
  }

  return {
    rooms: () => {
      arm().rooms = true
    },
    inspection: (roomId) => {
      arm().inspections.add(roomId)
    },
    flush
  }
}
