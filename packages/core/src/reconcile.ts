import { runDocker } from './backend/cli'
import type { IsolationBackend } from './backend/types'
import type { RoomsRepo } from './store/roomsRepo'

export interface ReconcileResult {
  straysRemoved: string[]
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
    if (!c.roomId || !known.has(c.roomId)) {
      log(`reconcile: removing stray container ${c.name} (room ${c.roomId || 'unknown'})`)
      await runDocker(['rm', '-f', c.name])
      straysRemoved.push(c.name)
    }
  }

  const roomsSlept: string[] = []
  for (const room of rooms.list()) {
    if (room.status === 'sleeping') continue
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
  return { straysRemoved, roomsSlept }
}
