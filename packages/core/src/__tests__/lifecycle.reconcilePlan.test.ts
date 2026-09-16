import { describe, expect, it } from 'vitest'
import type { RoomRecord, RoomStatus } from '@devhotel/shared'
import { emptyObservation, type LifecycleObservation } from '../lifecycle/observations'
import { isDestructiveReconcileAction, planReconciliation } from '../lifecycle/reconcilePlan'
import { makeRoom } from './fakes'

function observation(overrides: Partial<LifecycleObservation> = {}): LifecycleObservation {
  return { ...emptyObservation('2026-09-17T00:00:00.000Z', 'managed'), ...overrides }
}

/**
 * Applies a plan to the snapshot it was made from, the way the executor does.
 * A model rather than the real thing on purpose: what is being asserted is that
 * the plan converges, which is a property of the plan, not of the engine.
 */
function apply(
  observed: LifecycleObservation,
  rooms: RoomRecord[],
  plan: ReturnType<typeof planReconciliation>
): { observed: LifecycleObservation; rooms: RoomRecord[] } {
  const removedContainers = new Set<string>()
  const removedNetworks = new Set<string>()
  const revokedRooms = new Set<string>()
  const deletedRooms = new Set<string>()
  const statusChanges = new Map<string, RoomStatus>()

  for (const action of plan.actions) {
    if (action.kind === 'remove-container') removedContainers.add(action.target)
    if (action.kind === 'remove-network') removedNetworks.add(action.target)
    if (action.kind === 'revoke-ingress') revokedRooms.add(action.roomId ?? '')
    if (action.kind === 'resume-delete') deletedRooms.add(action.target)
    if (action.kind === 'mark-broken') statusChanges.set(action.target, 'broken')
    if (action.kind === 'sleep-room') statusChanges.set(action.target, 'sleeping')
  }

  return {
    observed: {
      ...observed,
      containers: observed.containers.filter((container) => !removedContainers.has(container.name)),
      networks: observed.networks.filter((network) => !removedNetworks.has(network.name)),
      ingress: observed.ingress.filter((route) => !revokedRooms.has(route.roomId))
    },
    rooms: rooms
      .filter((room) => !deletedRooms.has(room.id))
      .map((room) => (statusChanges.has(room.id) ? { ...room, status: statusChanges.get(room.id)! } : room))
  }
}

describe('reconciliation is deterministic', () => {
  const rooms = [
    makeRoom({ id: 'aliveroo1', status: 'ready' }),
    makeRoom({ id: 'prepareme', status: 'preparing' }),
    makeRoom({ id: 'deleting1', status: 'deleting' }),
    makeRoom({ id: 'brokenroo', status: 'broken' }),
    makeRoom({ id: 'sleepyroo', status: 'sleeping' })
  ]
  const observed = observation({
    containers: [
      { name: 'dh-aliveroo1-web', roomId: 'aliveroo1', role: 'web', state: 'running' },
      { name: 'dh-aliveroo1-job-abc', roomId: 'aliveroo1', role: 'job', state: 'running' },
      { name: 'dh-prepareme-anchor', roomId: 'prepareme', role: 'anchor', state: 'running' },
      { name: 'dh-strayroom-web', roomId: 'strayroom', role: 'web', state: 'exited' }
    ],
    networks: [
      { name: 'dh-aliveroo1-net', roomId: 'aliveroo1' },
      { name: 'dh-prepareme-net', roomId: 'prepareme' },
      { name: 'dh-strayroom-net', roomId: 'strayroom' }
    ],
    ingress: [
      { roomId: 'aliveroo1', hostPort: 51000, target: '192.168.0.2:41000', runtimeId: 'rt-1', createdAt: '' },
      { roomId: 'strayroom', hostPort: 51001, target: '192.168.0.2:41001', runtimeId: 'rt-0', createdAt: '' }
    ]
  })

  it('produces the same plan and the same digest every time', () => {
    const first = planReconciliation(observed, { rooms, currentRuntimeId: 'rt-1' })
    const second = planReconciliation(observed, { rooms, currentRuntimeId: 'rt-1' })
    expect(first.digest).toBe(second.digest)
    expect(first.actions).toEqual(second.actions)
  })

  it('does not depend on the order the engine listed things in', () => {
    const shuffled = observation({
      containers: [...observed.containers].reverse(),
      networks: [...observed.networks].reverse(),
      ingress: [...observed.ingress].reverse()
    })
    const straight = planReconciliation(observed, { rooms, currentRuntimeId: 'rt-1' })
    const scrambled = planReconciliation(shuffled, { rooms: [...rooms].reverse(), currentRuntimeId: 'rt-1' })
    expect(scrambled.digest).toBe(straight.digest)
  })

  it('asks to destroy nothing the second time round', () => {
    const plan = planReconciliation(observed, { rooms, currentRuntimeId: 'rt-1' })
    expect(plan.actions.some(isDestructiveReconcileAction)).toBe(true)

    const next = apply(observed, rooms, plan)
    const replan = planReconciliation(next.observed, { rooms: next.rooms, currentRuntimeId: 'rt-1' })
    expect(replan.actions.filter(isDestructiveReconcileAction)).toEqual([])
    // What is left is convergent: re-adopting a subnet the allocator already
    // tracks and re-stopping a broken Room are both no-ops it can absorb
    // forever.
    expect(new Set(replan.actions.map((action) => action.kind))).toEqual(
      new Set(['preserve', 'stop-room', 'adopt-network'])
    )
  })

  it('removes strays before it adopts surviving isolation domains', () => {
    const plan = planReconciliation(observed, { rooms, currentRuntimeId: 'rt-1' })
    const kinds = plan.actions.map((action) => action.kind)
    expect(kinds.indexOf('remove-network')).toBeLessThan(kinds.indexOf('adopt-network'))
    expect(kinds.indexOf('resume-delete')).toBe(0)
  })

  it('reaps a one-shot job even when its Room is healthy', () => {
    const plan = planReconciliation(observed, { rooms, currentRuntimeId: 'rt-1' })
    const job = plan.actions.find((action) => action.target === 'dh-aliveroo1-job-abc')
    expect(job?.kind).toBe('remove-container')
    expect(job?.reason).toContain('stale job container')
  })

  it('keeps a healthy Room’s own containers', () => {
    const plan = planReconciliation(observed, { rooms, currentRuntimeId: 'rt-1' })
    expect(plan.actions.find((action) => action.target === 'dh-aliveroo1-web')?.kind).toBe('preserve')
  })

  it('reclaims everything an interrupted preparing Room half-built', () => {
    const plan = planReconciliation(observed, { rooms, currentRuntimeId: 'rt-1' })
    expect(plan.actions.find((action) => action.target === 'dh-prepareme-anchor')?.kind).toBe('remove-container')
    expect(plan.actions.find((action) => action.target === 'dh-prepareme-net')?.kind).toBe('remove-network')
    expect(plan.actions.find((action) => action.target === 'prepareme')?.kind).toBe('mark-broken')
  })

  it('revokes every inherited Host port, because no workload survives a restart', () => {
    const plan = planReconciliation(observed, { rooms, currentRuntimeId: 'rt-1' })
    const revocations = plan.actions.filter((action) => action.kind === 'revoke-ingress')
    expect(revocations.map((action) => action.target)).toEqual(['aliveroo1:51000', 'strayroom:51001'])
    expect(revocations[1]?.reason).toContain('rt-0')
  })

  it('never hands a Windows Room to the OCI lifecycle', () => {
    const plan = planReconciliation(observation(), {
      rooms: [makeRoom({ id: 'winroom1', provider: 'windows', status: 'ready' })]
    })
    expect(plan.actions).toEqual([])
  })

  it('preserves a Room whose durable recovery gate still needs its live runtime', () => {
    const plan = planReconciliation(observation(), {
      rooms: [makeRoom({ id: 'gatedroo', status: 'attention' })],
      preserveAwakeRoomIds: new Set(['gatedroo'])
    })
    expect(plan.actions).toEqual([
      {
        kind: 'preserve',
        target: 'gatedroo',
        roomId: 'gatedroo',
        reason: 'A durable recovery gate still needs this exact live runtime.'
      }
    ])
  })

  it('does not attribute anything to a Room that is being deleted', () => {
    const plan = planReconciliation(
      observation({ networks: [{ name: 'dh-deleting1-net', roomId: 'deleting1' }] }),
      { rooms: [makeRoom({ id: 'deleting1', status: 'deleting' })] }
    )
    expect(plan.actions.find((action) => action.target === 'dh-deleting1-net')?.kind).toBe('remove-network')
  })
})
