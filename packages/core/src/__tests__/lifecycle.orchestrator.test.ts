import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DockerVolumeUsage } from '../backend/types'
import { RoomOrchestrator } from '../orchestrator'
import { IngressLedger } from '../lifecycle/ingressLedger'
import { sharedCacheLabels } from '../lifecycle/sharedCache'
import type { Db } from '../store/db'
import { FakeBackend, FakeGateway, makeRoom, tempDir, testDb } from './fakes'

function usage(overrides: Partial<DockerVolumeUsage> = {}): DockerVolumeUsage {
  return {
    name: 'dh-room1abc-cache',
    driver: 'local',
    scope: 'local',
    mountpoint: '/path',
    sizeBytes: 1000,
    sizeKnown: true,
    ownership: 'managed-labels',
    links: 0,
    linksKnown: true,
    labels: { 'devhotel.managed': '1', 'devhotel.room': 'room1abc', 'devhotel.role': 'volume' },
    ...overrides
  }
}

describe('the Host footprint through the orchestrator', () => {
  let db: Db
  let userData: string
  let backend: FakeBackend
  let ledger: IngressLedger
  let revoked: string[]
  let orch: RoomOrchestrator

  beforeEach(() => {
    db = testDb()
    userData = tempDir()
    backend = new FakeBackend()
    ledger = new IngressLedger({ userData })
    revoked = []
    orch = new RoomOrchestrator({
      userData,
      backend,
      gateway: new FakeGateway().asGateway(),
      db,
      appVersion: 'test',
      runtimeMode: 'managed',
      runtimeId: 'rt-1',
      ingressLedger: ledger,
      revokeIngress: async (roomId) => {
        revoked.push(roomId)
        ledger.forget(roomId)
      }
    })
  })

  afterEach(() => {
    db.close()
    rmSync(userData, { recursive: true, force: true })
  })

  it('enumerates disks, containers, isolation domains, shared caches and Host ports together', async () => {
    orch.rooms.create(makeRoom({ id: 'room1abc', status: 'sleeping' }))
    backend.managedVolumes = [usage(), usage({ name: 'dh-shared-packages', labels: sharedCacheLabels('packages'), sizeBytes: 4000 })]
    backend.managedContainers = [{ roomId: 'room1abc', role: 'web', state: 'exited', name: 'dh-room1abc-web' }]
    backend.managedNetworks = [{ roomId: 'room1abc', name: 'dh-room1abc-net' }]
    ledger.record({ roomId: 'room1abc', hostPort: 51000, target: '192.168.0.2:41000', runtimeId: 'rt-1' })

    const footprint = await orch.hostFootprint()

    expect(footprint.complete).toBe(true)
    expect(footprint.runtimeMode).toBe('managed')
    expect(footprint.artifacts.map((artifact) => artifact.id).sort()).toEqual([
      'container:dh-room1abc-web',
      'disk:dh-room1abc-cache',
      'ingress:room1abc:51000',
      'network:dh-room1abc-net',
      'shared-cache:dh-shared-packages'
    ])
    // The shared cache is Hotel-scoped, so it is not charged to the Room.
    expect(footprint.rooms.find((entry) => entry.roomId === 'room1abc')?.totals.bytes).toBe(1000)
    expect(footprint.hotel.bytes).toBe(4000)
  })

  it('will not collect anything from an incomplete footprint', async () => {
    orch.rooms.create(makeRoom({ id: 'room1abc', status: 'sleeping' }))
    backend.managedVolumes = [usage({ name: 'dh-delroom1-cache', labels: { 'devhotel.managed': '1', 'devhotel.room': 'delroom1', 'devhotel.role': 'volume' } })]
    backend.listManagedNetworksError = new Error('engine is restarting')

    const footprint = await orch.hostFootprint()
    expect(footprint.complete).toBe(false)

    const result = await orch.gcHostFootprint({ dryRun: false, maxArtifacts: 5, maxBytes: 10_000 })
    expect(result.dryRun).toBe(true)
    expect(result.plan.authorized).toBe(false)
    expect(backend.removedManagedVolumes).toEqual([])
  })

  it('collects a provably orphaned Room disk, and only that', async () => {
    orch.rooms.create(makeRoom({ id: 'room1abc', status: 'sleeping' }))
    backend.managedVolumes = [
      usage(),
      usage({
        name: 'dh-delroom1-cache',
        sizeBytes: 800,
        labels: { 'devhotel.managed': '1', 'devhotel.room': 'delroom1', 'devhotel.role': 'volume' }
      })
    ]

    const dry = await orch.gcHostFootprint()
    expect(dry.dryRun).toBe(true)
    expect(dry.plan.collect.map((artifact) => artifact.id)).toEqual(['disk:dh-delroom1-cache'])
    expect(backend.removedManagedVolumes).toEqual([])

    const done = await orch.gcHostFootprint({ dryRun: false, maxArtifacts: 5, maxBytes: 10_000 })
    expect(done.collectedIds).toEqual(['disk:dh-delroom1-cache'])
    expect(done.reclaimedBytes).toBe(800)
    expect(backend.removedManagedVolumes).toEqual(['dh-delroom1-cache'])
  })

  it('keeps a shared cache while a Room still exists, and collects it once none do', async () => {
    const shared = usage({ name: 'dh-shared-packages', labels: sharedCacheLabels('packages'), sizeBytes: 4000 })
    backend.managedVolumes = [shared]
    orch.rooms.create(makeRoom({ id: 'room1abc', status: 'sleeping' }))

    const held = await orch.gcHostFootprint()
    expect(held.plan.collect).toEqual([])
    expect(held.plan.refused[0]?.reason).toContain('reachable by all 1 Room(s)')

    orch.rooms.delete('room1abc')
    const collected = await orch.gcHostFootprint({ dryRun: false, maxArtifacts: 5, maxBytes: 10_000 })
    expect(collected.collectedIds).toEqual(['shared-cache:dh-shared-packages'])
    expect(backend.calls).toContain('removeSharedCache:dh-shared-packages')
  })

  it('revokes a Host port left behind by a Room that went back to sleep', async () => {
    orch.rooms.create(makeRoom({ id: 'room1abc', status: 'sleeping' }))
    ledger.record({ roomId: 'room1abc', hostPort: 51000, target: '192.168.0.2:41000', runtimeId: 'rt-1' })

    const result = await orch.gcHostFootprint({ dryRun: false, maxArtifacts: 5, maxBytes: 10_000 })
    expect(result.collectedIds).toEqual(['ingress:room1abc:51000'])
    expect(revoked).toEqual(['room1abc'])
    expect(ledger.list()).toEqual([])
  })

  it('answers a quota question from the footprint without touching anything', async () => {
    orch.rooms.create(makeRoom({ id: 'room1abc', status: 'sleeping' }))
    backend.managedVolumes = [usage({ sizeBytes: 900 })]

    const verdict = await orch.checkQuotas({ roomId: 'room1abc', bytes: 200 })
    expect(verdict.ok).toBe(true)
    expect(verdict.conclusive).toBe(true)
    expect(backend.removedManagedVolumes).toEqual([])
  })
})
