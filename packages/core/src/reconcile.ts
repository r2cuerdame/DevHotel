import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ReconcilePlan } from '@devhotel/shared'
import type { IsolationBackend } from './backend/types'
import type { RoomsRepo } from './store/roomsRepo'
import { emptyObservation, type IngressRouteObservation } from './lifecycle/observations'
import { planReconciliation } from './lifecycle/reconcilePlan'

export interface ReconcileResult {
  straysRemoved: string[]
  networksRemoved: string[]
  roomsSlept: string[]
  roomsDeleted?: string[]
  /** Host ingress ports closed because nothing survives a restart behind them. */
  ingressRevoked?: string[]
  /**
   * The plan that was executed. Two builds that agree on what a restart owes the
   * Rooms produce the same digest, which is how a change in recovery behaviour
   * becomes visible in a diff instead of in a user's Rooms.
   */
  plan?: ReconcilePlan
}

export interface ReconcileOptions {
  preserveAwakeRoomIds?: ReadonlySet<string>
  userData?: string
  /** Host ingress routes inherited from a previous run, from the durable ledger. */
  ingressRoutes?: readonly IngressRouteObservation[]
  /** Closes one inherited Host port and forgets its ledger entry. */
  revokeIngress?: (roomId: string) => Promise<void>
  /** The runtime generation now serving Rooms; routes from any other are stale. */
  currentRuntimeId?: string | null
}

/**
 * Boot-time crash recovery, decided before it is done.
 *
 * The rules are unchanged and deliberately so — containers with our label but
 * no Room record are removed, Rooms that believe they are awake are put to
 * sleep because nothing can be running yet, and Room data is never touched.
 * What changed with #109 is that the decision now lives in
 * `planReconciliation`, a pure function over an observed snapshot. This
 * function observes, asks for the plan, and carries it out.
 *
 * That separation is what makes the lifecycle testable without an engine and
 * comparable between builds. It also adds the one artifact that had no owner
 * before: a Host ingress port inherited from a process that did not exit
 * cleanly, which no engine can enumerate and which would otherwise accept
 * connections on behalf of a container that no longer exists.
 */
export async function reconcile(
  backend: IsolationBackend,
  rooms: RoomsRepo,
  log: (line: string) => void,
  options: ReconcileOptions = {}
): Promise<ReconcileResult> {
  const observation = emptyObservation(new Date().toISOString())
  observation.containers = (await backend.listManagedContainers()).map((container) => ({
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
  const networksRemoved: string[] = []
  const roomsSlept: string[] = []
  const roomsDeleted: string[] = []
  const ingressRevoked: string[] = []
  // A Room whose deletion could not be finished must not then be treated as a
  // live Room by the rest of the plan, nor silently forgotten.
  const deletionStalled = new Set<string>()

  for (const action of plan.actions) {
    switch (action.kind) {
      case 'resume-delete': {
        log(`reconcile: resuming deletion of room ${action.roomId}`)
        try {
          await backend.deleteRoomPod(action.target, { volumes: true })
        } catch (err) {
          log(
            `reconcile: could not finish deleting room pod ${action.target}: ${err instanceof Error ? err.message : String(err)}`
          )
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
          log(
            `reconcile: could not revoke ingress ${action.target}: ${err instanceof Error ? err.message : String(err)}`
          )
        }
        break
      }
      case 'remove-container': {
        log(`reconcile: removing container ${action.target} (room ${action.roomId || 'unknown'}) — ${action.reason}`)
        await backend.removeManagedContainer(action.target)
        straysRemoved.push(action.target)
        break
      }
      case 'remove-network': {
        log(`reconcile: removing stray network ${action.target} (room ${action.roomId || 'unknown'})`)
        try {
          await backend.removeManagedNetwork(action.target)
          networksRemoved.push(action.target)
        } catch (err) {
          log(
            `reconcile: could not remove stray network ${action.target}: ${err instanceof Error ? err.message : String(err)}`
          )
        }
        break
      }
      case 'adopt-network': {
        try {
          await backend.adoptManagedNetwork?.(action.target)
        } catch (err) {
          log(`reconcile: could not adopt network ${action.target}: ${err instanceof Error ? err.message : String(err)}`)
        }
        break
      }
      case 'mark-broken': {
        log(`reconcile: room ${action.target} was interrupted while preparing — marking broken`)
        rooms.update(action.target, { status: 'broken', hostPort: null })
        try {
          await backend.stopRoomPod(action.target)
        } catch (err) {
          log(
            `reconcile: could not stop interrupted room ${action.target}: ${err instanceof Error ? err.message : String(err)}`
          )
        }
        break
      }
      case 'stop-room': {
        // A broken Room can still own running containers — anchor up, web dead.
        await backend.stopRoomPod(action.target)
        rooms.update(action.target, { hostPort: null })
        break
      }
      case 'sleep-room': {
        log(`reconcile: ${action.reason} — putting room ${action.target} to sleep after restart`)
        await backend.stopRoomPod(action.target)
        rooms.update(action.target, { status: 'sleeping', hostPort: null })
        roomsSlept.push(action.target)
        break
      }
      case 'preserve':
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
    ...(ingressRevoked.length > 0 ? { ingressRevoked } : {})
  }
}
