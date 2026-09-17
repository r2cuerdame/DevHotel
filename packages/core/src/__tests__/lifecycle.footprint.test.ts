import { describe, expect, it } from 'vitest'
import type { VolumeRecord } from '@devhotel/shared'
import { buildHostFootprint } from '../lifecycle/footprint'
import { emptyObservation, type LifecycleObservation } from '../lifecycle/observations'
import { makeRoom } from './fakes'

function disk(overrides: Partial<VolumeRecord> = {}): VolumeRecord {
  return {
    name: 'dh-room1abc-src',
    roomId: 'room1abc',
    purpose: 'workspace',
    revision: 0,
    generation: null,
    nodeMajor: null,
    serviceKind: null,
    snapshotOperationId: null,
    sizeBytes: 1024,
    sizeKnown: true,
    ownership: 'managed-labels',
    links: 0,
    linksKnown: true,
    labels: { 'devhotel.managed': '1', 'devhotel.role': 'volume', 'devhotel.room': 'room1abc' },
    class: 'retained-current',
    safeToDelete: false,
    reason: 'Current workspace revision r0.',
    ...overrides
  }
}

function observation(overrides: Partial<LifecycleObservation> = {}): LifecycleObservation {
  return { ...emptyObservation('2026-09-17T00:00:00.000Z', 'managed'), ...overrides }
}

describe('Host footprint enumerates every owned artifact', () => {
  it('accounts for one artifact per observation, across every kind', () => {
    const room = makeRoom({ id: 'room1abc', status: 'sleeping' })
    const footprint = buildHostFootprint(
      observation({
        containers: [{ name: 'dh-room1abc-web', roomId: 'room1abc', role: 'web', state: 'exited' }],
        networks: [{ name: 'dh-room1abc-net', roomId: 'room1abc' }],
        volumes: [disk(), disk({ name: 'dh-room1abc-cache', purpose: 'cache', revision: null, class: 'retained-sleeping' })],
        sharedCaches: [
          { name: 'dh-shared-npm', purpose: 'npm', sizeBytes: 4096, sizeKnown: true, ownershipProved: true, attachments: 0 }
        ],
        ingress: [
          { roomId: 'room1abc', hostPort: 52345, target: '192.168.0.2:41000', runtimeId: 'rt-1', createdAt: '2026-09-17T00:00:00.000Z' }
        ]
      }),
      { rooms: [room], currentRuntimeId: 'rt-1' }
    )

    expect(footprint.complete).toBe(true)
    expect(footprint.incompleteReasons).toEqual([])
    expect(footprint.artifacts).toHaveLength(6)
    expect(footprint.totals.artifactCount).toBe(6)
    expect(new Set(footprint.artifacts.map((artifact) => artifact.kind))).toEqual(
      new Set(['room-container', 'room-network', 'room-disk', 'shared-cache', 'ingress-route'])
    )
    // Every artifact id is unique, which is what "once each" has to mean.
    expect(new Set(footprint.artifacts.map((artifact) => artifact.id)).size).toBe(6)
  })

  it('counts a Room total that matches the sum of that Room’s artifacts', () => {
    const room = makeRoom({ id: 'room1abc', status: 'sleeping' })
    const footprint = buildHostFootprint(
      observation({
        volumes: [
          disk({ sizeBytes: 100 }),
          disk({ name: 'dh-room1abc-cache', purpose: 'cache', revision: null, sizeBytes: 250, class: 'retained-sleeping' })
        ]
      }),
      { rooms: [room] }
    )

    const summary = footprint.rooms.find((entry) => entry.roomId === 'room1abc')
    expect(summary?.exists).toBe(true)
    expect(summary?.totals.bytes).toBe(350)
    expect(summary?.artifactIds).toEqual(['disk:dh-room1abc-cache', 'disk:dh-room1abc-src'])
    expect(footprint.totals.bytes).toBe(350)
  })

  it('lists a Room that owns nothing rather than omitting it', () => {
    const footprint = buildHostFootprint(observation(), { rooms: [makeRoom({ id: 'emptyroo' })] })
    expect(footprint.rooms).toHaveLength(1)
    expect(footprint.rooms[0]?.artifactIds).toEqual([])
  })

  it('is incomplete, and says why, when an engine listing failed', () => {
    const footprint = buildHostFootprint(
      observation({ gaps: ['Owned containers could not be listed: engine is restarting'] }),
      { rooms: [] }
    )
    expect(footprint.complete).toBe(false)
    expect(footprint.incompleteReasons[0]).toContain('engine is restarting')
  })

  it('is incomplete when the same artifact is reported twice', () => {
    const footprint = buildHostFootprint(
      observation({
        networks: [
          { name: 'dh-room1abc-net', roomId: 'room1abc' },
          { name: 'dh-room1abc-net', roomId: 'room1abc' }
        ]
      }),
      { rooms: [makeRoom({ id: 'room1abc' })] }
    )
    expect(footprint.complete).toBe(false)
    expect(footprint.incompleteReasons.join(' ')).toContain('more than once')
  })

  it('orders artifacts stably so two footprints of one Host compare cleanly', () => {
    const inputs = observation({
      networks: [
        { name: 'dh-bbbbbbbb-net', roomId: 'bbbbbbbb' },
        { name: 'dh-aaaaaaaa-net', roomId: 'aaaaaaaa' }
      ]
    })
    const rooms = [makeRoom({ id: 'aaaaaaaa' }), makeRoom({ id: 'bbbbbbbb' })]
    const first = buildHostFootprint(inputs, { rooms })
    const second = buildHostFootprint(inputs, { rooms })
    expect(first.artifacts.map((artifact) => artifact.id)).toEqual(second.artifacts.map((artifact) => artifact.id))
    expect(first.artifacts.map((artifact) => artifact.id)).toEqual(['network:dh-aaaaaaaa-net', 'network:dh-bbbbbbbb-net'])
  })
})

describe('footprint reachability', () => {
  it('holds a Room artifact whose Room record is gone but whose directory state is unknown', () => {
    const footprint = buildHostFootprint(
      observation({ networks: [{ name: 'dh-ghostroo-net', roomId: 'ghostroo' }] }),
      { rooms: [] }
    )
    const artifact = footprint.artifacts[0]
    expect(artifact?.reachability.known).toBe(false)
    expect(artifact?.collectable).toBe(false)
    expect(artifact?.reason).toContain('Reachability could not be established')
  })

  it('proves a Room artifact unreachable only when both the record and the directory are gone', () => {
    const footprint = buildHostFootprint(
      observation({ networks: [{ name: 'dh-ghostroo-net', roomId: 'ghostroo' }] }),
      { rooms: [], roomDirExists: () => false }
    )
    expect(footprint.artifacts[0]?.reachability.reachable).toBe(false)
    expect(footprint.artifacts[0]?.reachability.known).toBe(true)
    expect(footprint.artifacts[0]?.collectable).toBe(true)
  })

  it('keeps a running container reachable even when nothing claims its Room', () => {
    const footprint = buildHostFootprint(
      observation({ containers: [{ name: 'dh-ghostroo-web', roomId: 'ghostroo', role: 'web', state: 'running' }] }),
      { rooms: [], roomDirExists: () => false }
    )
    expect(footprint.artifacts[0]?.reachability.kind).toBe('attached')
    expect(footprint.artifacts[0]?.collectable).toBe(false)
  })

  it('treats an ingress route from a superseded runtime as unreachable', () => {
    const footprint = buildHostFootprint(
      observation({
        ingress: [
          { roomId: 'room1abc', hostPort: 52345, target: '192.168.0.2:41000', runtimeId: 'rt-old', createdAt: '' }
        ]
      }),
      { rooms: [makeRoom({ id: 'room1abc', status: 'ready' })], currentRuntimeId: 'rt-new' }
    )
    expect(footprint.artifacts[0]?.reachability.reachable).toBe(false)
    expect(footprint.artifacts[0]?.reason).toContain('rt-old')
  })

  it('keeps an ingress route reachable while its Room is awake on this runtime', () => {
    const footprint = buildHostFootprint(
      observation({
        ingress: [{ roomId: 'room1abc', hostPort: 52345, target: '192.168.0.2:41000', runtimeId: 'rt-1', createdAt: '' }]
      }),
      { rooms: [makeRoom({ id: 'room1abc', status: 'ready' })], currentRuntimeId: 'rt-1' }
    )
    expect(footprint.artifacts[0]?.collectable).toBe(false)
    expect(footprint.artifacts[0]?.reachability.kind).toBe('room-record')
  })

  it('frees an ingress route whose Room went back to sleep', () => {
    const footprint = buildHostFootprint(
      observation({
        ingress: [{ roomId: 'room1abc', hostPort: 52345, target: '192.168.0.2:41000', runtimeId: 'rt-1', createdAt: '' }]
      }),
      { rooms: [makeRoom({ id: 'room1abc', status: 'sleeping' })], currentRuntimeId: 'rt-1' }
    )
    expect(footprint.artifacts[0]?.collectable).toBe(true)
  })

  it('never widens the disk reconciler’s verdict', () => {
    // The reconciler declined; the footprint must decline too, whatever its own
    // reasoning would have concluded from the same fields.
    const footprint = buildHostFootprint(
      observation({
        volumes: [
          disk({
            class: 'orphaned-stale-generation',
            safeToDelete: false,
            revision: 1,
            reason: 'Retained workspace generation r1 required for change undo.'
          })
        ]
      }),
      { rooms: [makeRoom({ id: 'room1abc' })] }
    )
    expect(footprint.artifacts[0]?.collectable).toBe(false)
  })

  it('carries the disk reconciler’s clearance through unchanged', () => {
    const footprint = buildHostFootprint(
      observation({
        volumes: [
          disk({
            name: 'dh-room1abc-src-r1',
            revision: 1,
            class: 'orphaned-stale-generation',
            safeToDelete: true,
            reason: 'Stale historical workspace generation r1 superseded by r2.'
          })
        ]
      }),
      { rooms: [makeRoom({ id: 'room1abc' })] }
    )
    expect(footprint.artifacts[0]?.collectable).toBe(true)
    expect(footprint.artifacts[0]?.reachability.kind).toBe('unreachable')
  })
})

describe('shared caches in the footprint', () => {
  it('is Hotel-scoped and reachable while any Room exists', () => {
    const footprint = buildHostFootprint(
      observation({
        sharedCaches: [
          { name: 'dh-shared-npm', purpose: 'npm', sizeBytes: 900, sizeKnown: true, ownershipProved: true, attachments: 0 }
        ]
      }),
      { rooms: [makeRoom({ id: 'room1abc', status: 'sleeping' })] }
    )
    const cache = footprint.artifacts[0]
    expect(cache?.scope).toBe('hotel')
    expect(cache?.roomId).toBeNull()
    expect(cache?.reachability.kind).toBe('shared')
    expect(cache?.collectable).toBe(false)
    expect(footprint.hotel.bytes).toBe(900)
  })

  it('becomes collectable only once no Room remains that could reach it', () => {
    const footprint = buildHostFootprint(
      observation({
        sharedCaches: [
          { name: 'dh-shared-npm', purpose: 'npm', sizeBytes: 900, sizeKnown: true, ownershipProved: true, attachments: 0 }
        ]
      }),
      { rooms: [] }
    )
    expect(footprint.artifacts[0]?.collectable).toBe(true)
  })

  it('holds a shared cache whose attachment state the engine could not report', () => {
    const footprint = buildHostFootprint(
      observation({
        sharedCaches: [
          { name: 'dh-shared-npm', purpose: 'npm', sizeBytes: 900, sizeKnown: true, ownershipProved: true, attachments: null }
        ]
      }),
      { rooms: [] }
    )
    expect(footprint.artifacts[0]?.collectable).toBe(false)
    expect(footprint.artifacts[0]?.reason).toContain('Reachability could not be established')
  })
})
