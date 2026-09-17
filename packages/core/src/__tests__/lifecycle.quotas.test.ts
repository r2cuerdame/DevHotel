import { describe, expect, it } from 'vitest'
import type { HostFootprint, HotelArtifact, LifecycleQuotas } from '@devhotel/shared'
import { DEFAULT_LIFECYCLE_QUOTAS, evaluateQuotas } from '../lifecycle/quotas'

const EMPTY = {
  artifactCount: 0,
  bytes: 0,
  ownedCount: 0,
  ownedBytes: 0,
  collectableCount: 0,
  collectableBytes: 0,
  undeterminedCount: 0
}

function footprint(overrides: Partial<HostFootprint> = {}): HostFootprint {
  return {
    observedAt: '2026-09-17T00:00:00.000Z',
    runtimeMode: 'managed',
    artifacts: [],
    byKind: {
      'room-network': { ...EMPTY },
      'room-container': { ...EMPTY },
      'room-disk': { ...EMPTY },
      'shared-cache': { ...EMPTY },
      'ingress-route': { ...EMPTY }
    },
    rooms: [],
    hotel: { ...EMPTY },
    totals: { ...EMPTY },
    complete: true,
    incompleteReasons: [],
    ...overrides
  }
}

const TIGHT: LifecycleQuotas = {
  maxRoomBytes: 1000,
  maxRoomArtifacts: 3,
  maxRoomWorkspaceGenerations: 2,
  maxHotelBytes: 5000,
  maxHotelArtifacts: 10,
  maxIngressRoutes: 2
}

describe('quotas refuse creation and never delete', () => {
  it('passes a Host well inside every limit', () => {
    const verdict = evaluateQuotas(footprint(), DEFAULT_LIFECYCLE_QUOTAS, { roomId: 'room1abc', bytes: 1024 })
    expect(verdict.ok).toBe(true)
    expect(verdict.breaches).toEqual([])
    expect(verdict.conclusive).toBe(true)
  })

  it('refuses a Room that would pass its byte limit, and says by how much', () => {
    const verdict = evaluateQuotas(
      footprint({
        totals: { ...EMPTY, bytes: 900 },
        rooms: [{ roomId: 'room1abc', exists: true, totals: { ...EMPTY, bytes: 900 }, artifactIds: [] }]
      }),
      TIGHT,
      { roomId: 'room1abc', bytes: 200 }
    )
    expect(verdict.ok).toBe(false)
    const breach = verdict.breaches.find((entry) => entry.limit === 'maxRoomBytes')
    expect(breach).toMatchObject({ scope: 'room', roomId: 'room1abc', allowed: 1000, observed: 1100 })
  })

  it('refuses one workspace generation too many', () => {
    const disks: HotelArtifact[] = ['dh-room1abc-src', 'dh-room1abc-src-r1'].map((name) => ({
      id: `disk:${name}`,
      kind: 'room-disk',
      scope: 'room',
      roomId: 'room1abc',
      sizeBytes: 0,
      sizeKnown: true,
      ownership: { kind: 'managed-labels', proved: true, detail: '' },
      reachability: { kind: 'room-record', reachable: true, known: true, detail: '' },
      collectable: false,
      reason: ''
    }))
    const verdict = evaluateQuotas(footprint({ artifacts: disks }), TIGHT, {
      roomId: 'room1abc',
      workspaceGeneration: true
    })
    expect(verdict.breaches.map((entry) => entry.limit)).toContain('maxRoomWorkspaceGenerations')
  })

  it('refuses one Host ingress port too many', () => {
    const verdict = evaluateQuotas(
      footprint({
        byKind: {
          'room-network': { ...EMPTY },
          'room-container': { ...EMPTY },
          'room-disk': { ...EMPTY },
          'shared-cache': { ...EMPTY },
          'ingress-route': { ...EMPTY, artifactCount: 2 }
        }
      }),
      TIGHT,
      { ingressRoute: true }
    )
    expect(verdict.breaches[0]).toMatchObject({ limit: 'maxIngressRoutes', allowed: 2, observed: 3 })
  })

  it('reports every limit a single creation would cross, not just the first', () => {
    const verdict = evaluateQuotas(
      footprint({
        totals: { ...EMPTY, bytes: 4900, ownedCount: 10 },
        rooms: [{ roomId: 'room1abc', exists: true, totals: { ...EMPTY, bytes: 990, ownedCount: 3 }, artifactIds: [] }]
      }),
      TIGHT,
      { roomId: 'room1abc', bytes: 200, artifacts: 1 }
    )
    expect(new Set(verdict.breaches.map((entry) => entry.limit))).toEqual(
      new Set(['maxHotelBytes', 'maxHotelArtifacts', 'maxRoomBytes', 'maxRoomArtifacts'])
    )
  })

  it('is inconclusive when the footprint it read was incomplete', () => {
    // An incomplete footprint can only understate usage, so a clean verdict from
    // one is not evidence of headroom.
    const verdict = evaluateQuotas(
      footprint({ complete: false, incompleteReasons: ['engine listing failed'] }),
      DEFAULT_LIFECYCLE_QUOTAS
    )
    expect(verdict.ok).toBe(true)
    expect(verdict.conclusive).toBe(false)
  })
})
