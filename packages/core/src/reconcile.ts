import type { IsolationBackend } from './backend/types'
import type { RoomsRepo } from './store/roomsRepo'

export interface ReconcileResult {
  straysRemoved: string[]
  networksRemoved: string[]
  roomsSlept: string[]
}

/**
 * Boot-time crash recovery: containers with our label but no room record are
 * removed; rooms that believe they are awake are put to sleep (the app just
 * started — nothing should be running yet). Room data is never touched.
 */
export async function reconcile(
  backend: IsolationBackend,
  rooms: RoomsRepo,
  log: (line: string) => void
): Promise<ReconcileResult> {
  const known = new Set(rooms.list().map((r) => r.id))
  const straysRemoved: string[] = []
  for (const c of await backend.listManagedContainers()) {
    // A one-shot process is owned by the client operation that started it.
    // At process startup no such operation is live, even when its Room still
    // exists, so every surviving job container is stale and must be reaped.
    if (c.role === 'job' || !c.roomId || !known.has(c.roomId)) {
      const kind = c.role === 'job' ? 'stale job container' : 'stray container'
      log(`reconcile: removing ${kind} ${c.name} (room ${c.roomId || 'unknown'})`)
      await backend.removeManagedContainer(c.name)
      straysRemoved.push(c.name)
    }
  }

  const networksRemoved: string[] = []
  for (const network of await backend.listManagedNetworks()) {
    if (!network.roomId || !known.has(network.roomId)) {
      log(`reconcile: removing stray network ${network.name} (room ${network.roomId || 'unknown'})`)
      await backend.removeManagedNetwork(network.name)
      networksRemoved.push(network.name)
    }
  }

  const roomsSlept: string[] = []
  for (const room of rooms.list()) {
    if (room.status === 'sleeping') continue
    if (room.status === 'preparing') {
      // Creation/clone is not resumable: its workspace or data volumes may be
      // only partly initialized. Keep that fact visible instead of presenting
      // the room as a complete sleeping environment that can be woken.
      log(`reconcile: room ${room.id} was interrupted while preparing — marking broken`)
      rooms.update(room.id, { status: 'broken', hostPort: null })
      try {
        await backend.stopRoomPod(room.id)
      } catch (err) {
        log(`reconcile: could not stop interrupted room ${room.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
      continue
    }
    if (room.status === 'broken') {
      // broken rooms can still own running containers (e.g. anchor up, web crashed)
      await backend.stopRoomPod(room.id)
      rooms.update(room.id, { hostPort: null })
      continue
    }
    log(`reconcile: room ${room.id} was ${room.status} — putting to sleep after restart`)
    await backend.stopRoomPod(room.id)
    rooms.update(room.id, { status: 'sleeping', hostPort: null })
    roomsSlept.push(room.id)
  }
  return { straysRemoved, networksRemoved, roomsSlept }
}
