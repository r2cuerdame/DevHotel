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
  log: (line: string) => void,
  options: { preserveAwakeRoomIds?: ReadonlySet<string> } = {}
): Promise<ReconcileResult> {
  const knownOciRooms = new Set(rooms.list().filter((room) => room.provider !== 'windows').map((room) => room.id))
  const straysRemoved: string[] = []
  const managedContainers = await backend.listManagedContainers()
  for (const c of managedContainers) {
    // A one-shot process is owned by the client operation that started it.
    // At process startup no such operation is live, even when its Room still
    // exists, so every surviving job container is stale and must be reaped.
    const interruptedEmulatorCreate = c.role === 'svc-emulator' && c.state === 'created'
    if (c.role === 'job' || interruptedEmulatorCreate || !c.roomId || !knownOciRooms.has(c.roomId)) {
      const kind = c.role === 'job'
        ? 'stale job container'
        : interruptedEmulatorCreate
          ? 'interrupted emulator create'
          : 'stray container'
      log(`reconcile: removing ${kind} ${c.name} (room ${c.roomId || 'unknown'})`)
      await backend.removeManagedContainer(c.name)
      straysRemoved.push(c.name)
    }
  }

  const networksRemoved: string[] = []
  for (const network of await backend.listManagedNetworks()) {
    if (!network.roomId || !knownOciRooms.has(network.roomId)) {
      log(`reconcile: removing stray network ${network.name} (room ${network.roomId || 'unknown'})`)
      try {
        await backend.removeManagedNetwork(network.name)
        networksRemoved.push(network.name)
      } catch (err) {
        log(`reconcile: could not remove stray network ${network.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  const roomsSlept: string[] = []
  for (const room of rooms.list()) {
    // Windows VMs have a separate ownership ledger and lifecycle reconciler.
    // Never hand one to the OCI backend just because it shares the Room table.
    if (room.provider === 'windows') continue
    // Some startup recovery protocols retain an exact live runtime as durable
    // restoration authority. Stopping or sleeping it here would turn their
    // mutation gate into a permanent recovery deadlock.
    if (
      options.preserveAwakeRoomIds?.has(room.id) &&
      (room.status === 'running' || room.status === 'ready' || room.status === 'attention' || room.status === 'sleeping')
    ) {
      if (room.status === 'sleeping') {
        log(`reconcile: preserving fenced Room ${room.id} for recovery`)
      } else {
        log(`reconcile: preserving attention-gated Room ${room.id} for exact Android locale recovery`)
      }
      continue
    }
    if (room.status === 'sleeping') {
      const hasStray = managedContainers.some(
        (c) => c.roomId === room.id && !straysRemoved.includes(c.name) && (c.state === 'running' || c.state === 'restarting' || c.state === 'paused')
      )
      if (hasStray) {
        log(`reconcile: room ${room.id} is sleeping but has stray runtimes — stopping proven owned resources`)
        try {
          await backend.stopRoomPod(room.id)
        } catch (err) {
          log(`reconcile: could not stop stray runtime for room ${room.id}: ${err instanceof Error ? err.message : String(err)}`)
        }
        rooms.update(room.id, { hostPort: null })
      }
      continue
    }
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
