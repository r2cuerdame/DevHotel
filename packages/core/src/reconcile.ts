import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ReconcilePlan } from '@devhotel/shared'
import { managedContainerInventory, type IsolationBackend } from './backend/types'
import type { RoomsRepo } from './store/roomsRepo'
import { emptyObservation, type IngressRouteObservation } from './lifecycle/observations'
import { planReconciliation } from './lifecycle/reconcilePlan'

export interface ReconcileResult {
  straysRemoved: string[]
  networksRemoved: string[]
  roomsSlept: string[]
  roomsDeleted?: string[]
  ingressRevoked?: string[]
  invalidContainers?: { name: string; reason: string }[]
  straysFailed?: string[]
  roomsFailedToSleep?: string[]
  plan?: ReconcilePlan
}

export interface ReconcileOptions {
  preserveAwakeRoomIds?: ReadonlySet<string>
  userData?: string
  ingressRoutes?: readonly IngressRouteObservation[]
  revokeIngress?: (roomId: string) => Promise<void>
  currentRuntimeId?: string | null
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function reconcile(
  backend: IsolationBackend,
  rooms: RoomsRepo,
  log: (line: string) => void,
  options: ReconcileOptions = {}
): Promise<ReconcileResult> {
  const observation = emptyObservation(new Date().toISOString())
  const inventory = await managedContainerInventory(backend)
  for (const entry of inventory.invalid) {
    log(`reconcile: ignoring container ${entry.name}: not owned by DevHotel (${entry.reason})`)
  }
  observation.containers = inventory.owned.map((container) => ({
    name: container.name,
    roomId: container.roomId || null,
    role: container.role,
    state: container.state
  }))
  observation.networks = (await backend.listManagedNetworks()).map((network) => ({
    name: network.name,
    roomId: network.roomId || null
  }))
  observation.ingress = [...(options.ingressRoutes ?? [])]

  const plan = planReconciliation(observation, {
    rooms: rooms.list(),
    ...(options.preserveAwakeRoomIds ? { preserveAwakeRoomIds: options.preserveAwakeRoomIds } : {}),
    currentRuntimeId: options.currentRuntimeId ?? null
  })
  log(`reconcile: plan ${plan.digest.slice(0, 12)} with ${plan.actions.length} action(s)`)

  const straysRemoved: string[] = []
  const straysFailed: string[] = []
  const networksRemoved: string[] = []
  const roomsSlept: string[] = []
  const roomsFailedToSleep: string[] = []
  const roomsDeleted: string[] = []
  const ingressRevoked: string[] = []
  const deletionStalled = new Set<string>()

  for (const action of plan.actions) {
    switch (action.kind) {
      case 'resume-delete': {
        log(`reconcile: resuming deletion of room ${action.roomId}`)
        try {
          await backend.deleteRoomPod(action.target, { volumes: true })
        } catch (err) {
          log(`reconcile: could not finish deleting room pod ${action.target}: ${message(err)}`)
          deletionStalled.add(action.target)
          break
        }
        if (options.userData) {
          rmSync(join(options.userData, 'rooms', action.target), { recursive: true, force: true })
        }
        rooms.delete(action.target)
        roomsDeleted.push(action.target)
        break
      }
      case 'revoke-ingress': {
        if (!options.revokeIngress) break
        log(`reconcile: revoking inherited Host ingress for room ${action.roomId} (${action.reason})`)
        try {
          await options.revokeIngress(action.roomId ?? '')
          ingressRevoked.push(action.target)
        } catch (err) {
          log(`reconcile: could not revoke ingress ${action.target}: ${message(err)}`)
        }
        break
      }
      case 'remove-container': {
        log(`reconcile: removing container ${action.target} (room ${action.roomId || 'unknown'}) — ${action.reason}`)
        try {
          await backend.removeManagedContainer(action.target)
          straysRemoved.push(action.target)
        } catch (err) {
          log(`reconcile: could not remove container ${action.target}: ${message(err)}`)
          straysFailed.push(action.target)
        }
        break
      }
      case 'remove-network': {
        log(`reconcile: removing stray network ${action.target} (room ${action.roomId || 'unknown'})`)
        try {
          await backend.removeManagedNetwork(action.target)
          networksRemoved.push(action.target)
        } catch (err) {
          log(`reconcile: could not remove stray network ${action.target}: ${message(err)}`)
        }
        break
      }
      case 'adopt-network': {
        try {
          await backend.adoptManagedNetwork?.(action.target)
        } catch (err) {
          log(`reconcile: could not adopt network ${action.target}: ${message(err)}`)
        }
        break
      }
      case 'mark-broken': {
        log(`reconcile: room ${action.target} was interrupted while preparing — marking broken`)
        rooms.update(action.target, { status: 'broken', hostPort: null })
        try {
          await backend.stopRoomPod(action.target)
        } catch (err) {
          log(`reconcile: could not stop interrupted room ${action.target}: ${message(err)}`)
        }
        break
      }
      case 'stop-room': {
        log(`reconcile: room ${action.target} — ${action.reason}`)
        try {
          await backend.stopRoomPod(action.target)
        } catch (err) {
          log(`reconcile: could not stop room ${action.target}: ${message(err)}`)
        }
        rooms.update(action.target, { hostPort: null })
        break
      }
      case 'sleep-room': {
        log(`reconcile: ${action.reason} — putting room ${action.target} to sleep after restart`)
        try {
          await backend.stopRoomPod(action.target)
        } catch (err) {
          log(`reconcile: could not stop room ${action.target}, marking broken: ${message(err)}`)
          rooms.update(action.target, { status: 'broken', hostPort: null })
          roomsFailedToSleep.push(action.target)
          break
        }
        rooms.update(action.target, { status: 'sleeping', hostPort: null })
        roomsSlept.push(action.target)
        break
      }
      case 'preserve':
        if (action.target === action.roomId && options.preserveAwakeRoomIds?.has(action.target)) {
          log(`reconcile: preserving fenced Room ${action.target} — ${action.reason}`)
        }
        break
    }
  }

  for (const roomId of deletionStalled) {
    log(`reconcile: room ${roomId} remains in deleting state and will be retried on the next start`)
  }

  return {
    straysRemoved,
    networksRemoved,
    roomsSlept,
    plan,
    ...(roomsDeleted.length > 0 ? { roomsDeleted } : {}),
    ...(ingressRevoked.length > 0 ? { ingressRevoked } : {}),
    ...(inventory.invalid.length > 0 ? { invalidContainers: inventory.invalid } : {}),
    ...(straysFailed.length > 0 ? { straysFailed } : {}),
    ...(roomsFailedToSleep.length > 0 ? { roomsFailedToSleep } : {})
  }
}
