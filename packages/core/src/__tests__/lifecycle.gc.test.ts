import { describe, expect, it } from 'vitest'
import type { HostFootprint, HotelArtifact } from '@devhotel/shared'
import { executeHostGc, planHostGc } from '../lifecycle/gc'

function artifact(overrides: Partial<HotelArtifact> = {}): HotelArtifact {
  return {
    id: 'disk:dh-room1abc-src-r1',
    kind: 'room-disk',
    scope: 'room',
    roomId: 'room1abc',
    sizeBytes: 100,
    sizeKnown: true,
    ownership: { kind: 'managed-labels', proved: true, detail: 'labels' },
    reachability: { kind: 'unreachable', reachable: false, known: true, detail: 'nothing reaches it' },
    collectable: true,
    reason: 'nothing reaches it',
    ...overrides
  }
}

function footprint(artifacts: HotelArtifact[], overrides: Partial<HostFootprint> = {}): HostFootprint {
  const empty = { artifactCount: 0, bytes: 0, ownedCount: 0, ownedBytes: 0, collectableCount: 0, collectableBytes: 0, undeterminedCount: 0 }
  return {
    observedAt: '2026-09-17T00:00:00.000Z',
    runtimeMode: 'managed',
    artifacts,
    byKind: {
      'room-network': { ...empty },
      'room-container': { ...empty },
      'room-disk': { ...empty },
      'shared-cache': { ...empty },
      'ingress-route': { ...empty }
    },
    rooms: [],
    hotel: { ...empty },
    totals: { ...empty, artifactCount: artifacts.length },
    complete: true,
    incompleteReasons: [],
    ...overrides
  }
}

const BOUNDS = { maxArtifacts: 10, maxBytes: 10_000 }

describe('GC cannot remove without proving ownership', () => {
  it('refuses an artifact whose ownership is only its name', () => {
    const plan = planHostGc(
      footprint([
        artifact({
          ownership: { kind: 'name-only', proved: false, detail: 'name matches a DevHotel pattern' },
          collectable: false,
          reason: 'Ownership is not proved (name-only): name matches a DevHotel pattern'
        })
      ]),
      BOUNDS
    )
    expect(plan.collect).toEqual([])
    expect(plan.refused[0]?.reason).toContain('Ownership is not proved')
  })

  it('refuses even an artifact that claims to be collectable without an ownership proof', () => {
    // A hand-built footprint must not be able to talk GC past its own gate.
    const plan = planHostGc(
      footprint([
        artifact({
          ownership: { kind: 'none', proved: false, detail: 'nothing identifies it' },
          collectable: true
        })
      ]),
      BOUNDS
    )
    expect(plan.collect).toEqual([])
    expect(plan.refused[0]?.reason).toBe('Ownership is not proved.')
  })
})

describe('GC cannot remove without proving unreachability', () => {
  it('refuses an artifact something still reaches', () => {
    const plan = planHostGc(
      footprint([
        artifact({
          reachability: { kind: 'room-record', reachable: true, known: true, detail: 'Room room1abc still exists.' },
          collectable: false,
          reason: 'Room room1abc still exists.'
        })
      ]),
      BOUNDS
    )
    expect(plan.collect).toEqual([])
  })

  it('refuses an artifact whose reachability could not be established', () => {
    const plan = planHostGc(
      footprint([
        artifact({
          reachability: { kind: 'undetermined', reachable: false, known: false, detail: 'attachment state unknown' },
          collectable: false,
          reason: 'Reachability could not be established: attachment state unknown'
        })
      ]),
      BOUNDS
    )
    expect(plan.collect).toEqual([])
    expect(plan.refused[0]?.reason).toContain('Reachability could not be established')
  })

  it('refuses an unreachable artifact whose size nobody could establish', () => {
    const plan = planHostGc(footprint([artifact({ sizeKnown: false, collectable: false, reason: 'Size is unknown' })]), BOUNDS)
    expect(plan.collect).toEqual([])
  })
})

describe('GC will not plan at all from an incomplete footprint', () => {
  it('refuses every artifact and says the inventory was partial', () => {
    const plan = planHostGc(
      footprint([artifact()], { complete: false, incompleteReasons: ['Owned containers could not be listed'] }),
      BOUNDS
    )
    expect(plan.authorized).toBe(false)
    expect(plan.collect).toEqual([])
    expect(plan.refused).toHaveLength(1)
    expect(plan.authorizationDetail).toContain('Owned containers could not be listed')
  })

  it('downgrades a real pass to a dry run rather than collecting unproved things', async () => {
    let collected = 0
    const result = await executeHostGc(
      footprint([artifact()], { complete: false, incompleteReasons: ['partial'] }),
      { dryRun: false, maxArtifacts: 5, maxBytes: 5000 },
      {
        collect: async () => {
          collected += 1
          return 100
        }
      }
    )
    expect(result.dryRun).toBe(true)
    expect(result.collectedIds).toEqual([])
    expect(collected).toBe(0)
  })
})

describe('GC stays bounded', () => {
  it('refuses to plan without finite bounds', () => {
    const plan = planHostGc(footprint([artifact()]), { maxArtifacts: 0, maxBytes: 10 })
    expect(plan.authorized).toBe(false)
    expect(plan.authorizationDetail).toContain('explicit, finite bounds')
  })

  it('stops at the artifact bound and records why the rest were left', () => {
    const plan = planHostGc(
      footprint([artifact({ id: 'disk:a' }), artifact({ id: 'disk:b' }), artifact({ id: 'disk:c' })]),
      { maxArtifacts: 2, maxBytes: 10_000 }
    )
    expect(plan.collect).toHaveLength(2)
    expect(plan.refused[0]?.reason).toContain('artifact bound')
  })

  it('stops at the byte bound', () => {
    const plan = planHostGc(
      footprint([artifact({ id: 'disk:a', sizeBytes: 400 }), artifact({ id: 'disk:b', sizeBytes: 400 })]),
      { maxArtifacts: 10, maxBytes: 500 }
    )
    expect(plan.collect.map((entry) => entry.id)).toEqual(['disk:a'])
    expect(plan.plannedBytes).toBe(400)
    expect(plan.refused[0]?.reason).toContain('byte bound')
  })

  it('takes the smallest first, so one huge disk cannot starve the pass', () => {
    const plan = planHostGc(
      footprint([
        artifact({ id: 'disk:huge', sizeBytes: 9_000 }),
        artifact({ id: 'disk:small', sizeBytes: 10 }),
        artifact({ id: 'disk:medium', sizeBytes: 100 })
      ]),
      { maxArtifacts: 10, maxBytes: 200 }
    )
    expect(plan.collect.map((entry) => entry.id)).toEqual(['disk:small', 'disk:medium'])
  })

  it('refuses a real pass with no re-proving executor', async () => {
    await expect(
      executeHostGc(footprint([artifact()]), { dryRun: false, maxArtifacts: 1, maxBytes: 1000 })
    ).rejects.toThrow(/re-proving removal executor/)
  })

  it('refuses a real pass that brought no bounds', async () => {
    await expect(
      executeHostGc(footprint([artifact()]), { dryRun: false }, { collect: async () => 0 })
    ).rejects.toThrow(/explicit maxArtifacts and maxBytes/)
  })

  it('is a dry run by default', async () => {
    const result = await executeHostGc(footprint([artifact()]))
    expect(result.dryRun).toBe(true)
    expect(result.plan.collect).toHaveLength(1)
    expect(result.reclaimedBytes).toBe(0)
  })
})

describe('a real pass records what the executor refused', () => {
  it('keeps going past one refusal and reports it', async () => {
    const result = await executeHostGc(
      footprint([artifact({ id: 'disk:a', sizeBytes: 10 }), artifact({ id: 'disk:b', sizeBytes: 20 })]),
      { dryRun: false, maxArtifacts: 5, maxBytes: 1000 },
      {
        collect: async (candidate) => {
          if (candidate.id === 'disk:a') throw new Error('Artifact disk:a changed state before guarded removal')
          return candidate.sizeBytes
        }
      }
    )
    expect(result.collectedIds).toEqual(['disk:b'])
    expect(result.reclaimedBytes).toBe(20)
    expect(result.errors[0]).toContain('changed state before guarded removal')
  })
})
