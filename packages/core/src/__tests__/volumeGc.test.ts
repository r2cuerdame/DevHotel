import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DockerVolumeUsage } from '../backend/types'
import { RoomOrchestrator } from '../orchestrator'
import { retainedWorkspaceGenKey } from '../workingState'
import { depsGenKey } from '../changes/definitions/deps'
import {
  parseDockerUnitSize,
  parseVolumeNameAndLabels,
  isRoomFencedForRecovery,
  reconcileVolumesState,
  executeVolumeGc,
  type VolumeReconciliationContext
} from '../volumeGc'
import type { Db } from '../store/db'
import { FakeBackend, FakeGateway, makeRoom, tempDir, testDb } from './fakes'

describe('Volume GC & Reconciliation (Issue #63)', () => {
  describe('parseDockerUnitSize', () => {
    it('handles 0B, N/A, and empty strings', () => {
      expect(parseDockerUnitSize('')).toBe(0)
      expect(parseDockerUnitSize('0B')).toBe(0)
      expect(parseDockerUnitSize('N/A')).toBe(0)
      expect(parseDockerUnitSize('invalid')).toBe(0)
    })

    it('parses decimal sizes with standard units', () => {
      expect(parseDockerUnitSize('500B')).toBe(500)
      expect(parseDockerUnitSize('192.7kB')).toBe(192700)
      expect(parseDockerUnitSize('153.6MB')).toBe(153600000)
      expect(parseDockerUnitSize('1.616GB')).toBe(1616000000)
      expect(parseDockerUnitSize('2.542GB')).toBe(2542000000)
      expect(parseDockerUnitSize('1TB')).toBe(1000000000000)
    })

    it('parses binary IEC units', () => {
      expect(parseDockerUnitSize('1KiB')).toBe(1024)
      expect(parseDockerUnitSize('10MiB')).toBe(10485760)
      expect(parseDockerUnitSize('2GiB')).toBe(2147483648)
    })
  })

  describe('parseVolumeNameAndLabels', () => {
    it('identifies standard DevHotel named volumes', () => {
      const cache = parseVolumeNameAndLabels('dh-cgwwdje7-cache')
      expect(cache).toEqual({
        roomId: 'cgwwdje7',
        purpose: 'cache',
        revision: null,
        generation: null,
        nodeMajor: null,
        serviceKind: null,
        snapshotOperationId: null,
        isDevHotelNamed: true
      })

      const sdk = parseVolumeNameAndLabels('dh-cgwwdje7-sdk')
      expect(sdk.purpose).toBe('sdk')
      expect(sdk.roomId).toBe('cgwwdje7')

      const srcRoot = parseVolumeNameAndLabels('dh-cgwwdje7-src')
      expect(srcRoot.purpose).toBe('workspace')
      expect(srcRoot.revision).toBe(0)

      const srcRev = parseVolumeNameAndLabels('dh-cgwwdje7-src-r38')
      expect(srcRev.purpose).toBe('workspace')
      expect(srcRev.revision).toBe(38)

      const snapshot = parseVolumeNameAndLabels('dh-ea9p0aqh-src-build-1234567890abcdef1234567890abcdef')
      expect(snapshot.purpose).toBe('workspace-snapshot')
      expect(snapshot.snapshotOperationId).toBe('1234567890abcdef1234567890abcdef')

      const deps = parseVolumeNameAndLabels('dh-1pdmdbbb-deps-node22-g3')
      expect(deps.purpose).toBe('dependencies')
      expect(deps.nodeMajor).toBe('22')
      expect(deps.generation).toBe(3)

      const svc = parseVolumeNameAndLabels('dh-cf3dl7zs-svc-postgres-data')
      expect(svc.purpose).toBe('service-data')
      expect(svc.serviceKind).toBe('postgres')
    })

    it('identifies DevHotel labeled volumes even if differently named', () => {
      const labeled = parseVolumeNameAndLabels('custom-named-vol', {
        'devhotel.managed': '1',
        'devhotel.room': 'cgwwdje7',
        'devhotel.role': 'volume'
      })
      expect(labeled.roomId).toBe('cgwwdje7')
      expect(labeled.isDevHotelNamed).toBe(true)
    })

    it('identifies non-DevHotel volumes as external', () => {
      const anon = parseVolumeNameAndLabels('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
      expect(anon.purpose).toBe('external')
      expect(anon.roomId).toBeNull()

      const compose = parseVolumeNameAndLabels('loopoffice-main_pgdata')
      expect(compose.purpose).toBe('external')
      expect(compose.roomId).toBeNull()

      const invalidRoom = parseVolumeNameAndLabels('dh-androidtest-cache')
      expect(invalidRoom.purpose).toBe('external')
      expect(invalidRoom.roomId).toBeNull()
    })
  })

  describe('isRoomFencedForRecovery', () => {
    it('fences explicit rooms and attention status', () => {
      const settings = new Map<string, string>()
      const getSettings = { get: (k: string) => settings.get(k) ?? null }

      expect(isRoomFencedForRecovery('njfstb4z', getSettings, new Set(['njfstb4z']))).toBe(true)
      expect(isRoomFencedForRecovery('room1', getSettings, undefined, 'attention')).toBe(true)
      expect(isRoomFencedForRecovery('room1', getSettings, undefined, 'ready')).toBe(false)

      settings.set('androidLocaleRestorePending:room1', '{}')
      expect(isRoomFencedForRecovery('room1', getSettings)).toBe(true)
    })
  })

  describe('reconcileVolumesState', () => {
    const fakeVol = (name: string, sizeBytes: number, links = 0, labels: Record<string, string> = {}): DockerVolumeUsage => ({
      name,
      driver: 'local',
      scope: 'local',
      mountpoint: `/var/lib/docker/volumes/${name}/_data`,
      sizeBytes,
      links,
      labels
    })

    it('strictly fences all volumes for issue #61 recovery rooms (njfstb4z, 29c5e8ys)', () => {
      const roomNj = makeRoom({ id: 'njfstb4z', status: 'ready', workspaceVolumeRevision: 10 })
      const room29 = makeRoom({ id: '29c5e8ys', status: 'ready', workspaceVolumeRevision: 3 })

      const settings = new Map<string, string>([
        ['androidLocaleRestorePending:njfstb4z', '{"version":4}'],
        ['androidLocaleRestorePending:29c5e8ys', '{"version":4}']
      ])

      const volumes: DockerVolumeUsage[] = [
        fakeVol('dh-njfstb4z-cache', 1616000000),
        fakeVol('dh-njfstb4z-sdk', 2542000000),
        fakeVol('dh-njfstb4z-src-r10', 37330000),
        fakeVol('dh-njfstb4z-src-r9', 8590000),
        fakeVol('dh-njfstb4z-src-r1', 7400000),
        fakeVol('dh-29c5e8ys-cache', 3923000000),
        fakeVol('dh-29c5e8ys-sdk', 560200000),
        fakeVol('dh-29c5e8ys-src-r3', 133300000),
        fakeVol('dh-29c5e8ys-src-r2', 118100000),
        fakeVol('dh-29c5e8ys-src-r1', 9860000)
      ]

      const report = reconcileVolumesState({
        volumes,
        rooms: [roomNj, room29],
        settings: { get: (k) => settings.get(k) ?? null }
      })

      expect(report.fencedVolumeCount).toBe(10)
      expect(report.safeGcCandidateCount).toBe(0)
      expect(report.safeGcCandidateBytes).toBe(0)

      for (const v of report.volumes) {
        expect(v.class).toBe('fenced')
        expect(v.safeToDelete).toBe(false)
        expect(v.reason).toContain('active recovery or acceptance fence')
      }
    })

    it('preserves sleeping room persistent cache, sdk, services, and current revision', () => {
      const room = makeRoom({ id: 'cgwwdje7', status: 'sleeping', workspaceVolumeRevision: 38 })
      const settings = new Map<string, string>([
        [retainedWorkspaceGenKey('cgwwdje7'), '37']
      ])

      const volumes: DockerVolumeUsage[] = [
        fakeVol('dh-cgwwdje7-cache', 100000),
        fakeVol('dh-cgwwdje7-sdk', 200000),
        fakeVol('dh-cgwwdje7-src-r38', 500000),
        fakeVol('dh-cgwwdje7-src-r37', 450000),
        fakeVol('dh-cgwwdje7-src-r36', 400000),
        fakeVol('dh-cgwwdje7-svc-postgres-data', 800000)
      ]

      const report = reconcileVolumesState({
        volumes,
        rooms: [room],
        settings: { get: (k) => settings.get(k) ?? null }
      })

      const cache = report.volumes.find((v) => v.name === 'dh-cgwwdje7-cache')!
      expect(cache.class).toBe('retained-sleeping')
      expect(cache.safeToDelete).toBe(false)

      const sdk = report.volumes.find((v) => v.name === 'dh-cgwwdje7-sdk')!
      expect(sdk.class).toBe('retained-sleeping')
      expect(sdk.safeToDelete).toBe(false)

      const r38 = report.volumes.find((v) => v.name === 'dh-cgwwdje7-src-r38')!
      expect(r38.class).toBe('retained-sleeping')
      expect(r38.safeToDelete).toBe(false)

      const r37 = report.volumes.find((v) => v.name === 'dh-cgwwdje7-src-r37')!
      expect(r37.class).toBe('retained-recovery')
      expect(r37.safeToDelete).toBe(false)

      const svc = report.volumes.find((v) => v.name === 'dh-cgwwdje7-svc-postgres-data')!
      expect(svc.class).toBe('retained-sleeping')
      expect(svc.safeToDelete).toBe(false)

      const r36 = report.volumes.find((v) => v.name === 'dh-cgwwdje7-src-r36')!
      expect(r36.class).toBe('orphaned-stale-generation')
      expect(r36.safeToDelete).toBe(true)
    })

    it('identifies provably orphaned volumes from deleted rooms (like a17wkjn5)', () => {
      const volumes: DockerVolumeUsage[] = [
        fakeVol('dh-a17wkjn5-cache', 192700),
        fakeVol('dh-a17wkjn5-sdk', 153600000),
        fakeVol('dh-a17wkjn5-src', 7531000)
      ]

      const report = reconcileVolumesState({
        volumes,
        rooms: [], // Room does not exist in DB
        settings: { get: () => null },
        roomDirExists: () => false // Room has no on-disk folder
      })

      expect(report.safeGcCandidateCount).toBe(3)
      expect(report.safeGcCandidateBytes).toBe(192700 + 153600000 + 7531000)
      for (const v of report.volumes) {
        expect(v.class).toBe('orphaned-deleted-room')
        expect(v.safeToDelete).toBe(true)
      }
    })

    it('fails-closed on deleted room volumes if on-disk folder still exists', () => {
      const volumes: DockerVolumeUsage[] = [
        fakeVol('dh-a17wkjn5-cache', 192700)
      ]

      const report = reconcileVolumesState({
        volumes,
        rooms: [],
        settings: { get: () => null },
        roomDirExists: (id) => id === 'a17wkjn5' // Disk folder still exists!
      })

      expect(report.safeGcCandidateCount).toBe(0)
      const v = report.volumes[0]!
      expect(v.class).toBe('unowned')
      expect(v.safeToDelete).toBe(false)
      expect(v.reason).toContain('on-disk directory')
    })

    it('fails-closed on unowned anonymous and external volumes', () => {
      const volumes: DockerVolumeUsage[] = [
        fakeVol('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 100000000),
        fakeVol('loopoffice-main_pgdata', 200000000),
        fakeVol('dh-androidtest-cache', 50000000)
      ]

      const report = reconcileVolumesState({
        volumes,
        rooms: [],
        settings: { get: () => null }
      })

      expect(report.unownedVolumeCount).toBe(3)
      expect(report.safeGcCandidateCount).toBe(0)
      for (const v of report.volumes) {
        expect(v.class).toBe('unowned')
        expect(v.safeToDelete).toBe(false)
      }
    })

    it('preserves build snapshots if operation is actively running', () => {
      const room = makeRoom({ id: 'ea9p0aqh', status: 'ready' })
      const opId = '1234567890abcdef1234567890abcdef'
      const volumes: DockerVolumeUsage[] = [
        fakeVol(`dh-ea9p0aqh-src-build-${opId}`, 50000000),
        fakeVol('dh-ea9p0aqh-src-build-fedcba0987654321fedcba0987654321', 30000000)
      ]

      const report = reconcileVolumesState({
        volumes,
        rooms: [room],
        settings: { get: () => null },
        activeOperations: [
          { id: opId, roomId: 'ea9p0aqh', status: 'running' }
        ]
      })

      const activeSnap = report.volumes.find((v) => v.name === `dh-ea9p0aqh-src-build-${opId}`)!
      expect(activeSnap.class).toBe('retained-active')
      expect(activeSnap.safeToDelete).toBe(false)

      const staleSnap = report.volumes.find((v) => v.name.includes('fedcba'))!
      expect(staleSnap.class).toBe('orphaned-stale-snapshot')
      expect(staleSnap.safeToDelete).toBe(true)
    })

    it('preserves dependency generations referenced by undoable changes', () => {
      const room = makeRoom({ id: '1pdmdbbb', status: 'sleeping', runtime: { kind: 'node', version: '22' } })
      const settings = new Map<string, string>([
        [depsGenKey('1pdmdbbb', '22'), '2'] // Current gen is 2
      ])
      const volumes: DockerVolumeUsage[] = [
        fakeVol('dh-1pdmdbbb-deps-node22-g2', 100000), // Current gen
        fakeVol('dh-1pdmdbbb-deps-node22-g1', 90000),  // Older gen, but in undoable change
        fakeVol('dh-1pdmdbbb-deps-node22-g0', 80000)   // Older gen, not in undoable change
      ]

      const report = reconcileVolumesState({
        volumes,
        rooms: [room],
        settings: { get: (k) => settings.get(k) ?? null },
        changes: {
          list: (roomId) =>
            roomId === '1pdmdbbb'
              ? [
                  {
                    undoable: true,
                    captured: {
                      deps: { nodeMajor: '22', gen: 1 }
                    }
                  }
                ]
              : []
        }
      })

      const g2 = report.volumes.find((v) => v.name === 'dh-1pdmdbbb-deps-node22-g2')!
      expect(g2.class).toBe('retained-sleeping')
      expect(g2.safeToDelete).toBe(false)

      const g1 = report.volumes.find((v) => v.name === 'dh-1pdmdbbb-deps-node22-g1')!
      expect(g1.class).toBe('retained-recovery')
      expect(g1.safeToDelete).toBe(false)
      expect(g1.reason).toContain('change undo')

      const g0 = report.volumes.find((v) => v.name === 'dh-1pdmdbbb-deps-node22-g0')!
      expect(g0.class).toBe('orphaned-stale-deps')
      expect(g0.safeToDelete).toBe(true)
    })

    it('refuses safeToDelete if any stale or deleted-room volume has active container links', () => {
      const volumes: DockerVolumeUsage[] = [
        fakeVol('dh-a17wkjn5-cache', 192700, 1), // deleted room, but attached (links = 1)
        fakeVol('dh-cgwwdje7-src-r1', 1000000, 2), // stale gen, but attached (links = 2)
        fakeVol('dh-ea9p0aqh-src-build-fedcba0987654321fedcba0987654321', 30000000, 1) // stale snapshot, but attached (links = 1)
      ]

      const roomCg = makeRoom({ id: 'cgwwdje7', status: 'sleeping', workspaceVolumeRevision: 38 })
      const roomEa = makeRoom({ id: 'ea9p0aqh', status: 'sleeping' })

      const report = reconcileVolumesState({
        volumes,
        rooms: [roomCg, roomEa],
        settings: { get: () => null },
        roomDirExists: () => false
      })

      for (const v of report.volumes) {
        expect(v.safeToDelete).toBe(false)
        expect(v.reason).toMatch(/attached to a container|active container attachments/)
      }
    })
  })

  describe('executeVolumeGc', () => {
    const fakeVol = (name: string, sizeBytes: number, links = 0): DockerVolumeUsage => ({
      name,
      driver: 'local',
      scope: 'local',
      mountpoint: `/var/lib/docker/volumes/${name}/_data`,
      sizeBytes,
      links,
      labels: {}
    })

    it('dryRun does not delete any volumes', async () => {
      const backend = new FakeBackend()
      const volumes: DockerVolumeUsage[] = [
        fakeVol('dh-a17wkjn5-cache', 1000),
        fakeVol('dh-a17wkjn5-sdk', 2000)
      ]

      const context: VolumeReconciliationContext = {
        volumes,
        rooms: [],
        settings: { get: () => null },
        roomDirExists: () => false
      }

      const result = await executeVolumeGc(backend, context, { dryRun: true })
      expect(result.dryRun).toBe(true)
      expect(result.deletedCount).toBe(0)
      expect(result.deletedVolumes).toHaveLength(0)
      expect(backend.removedManagedVolumes).toHaveLength(0)
      expect(result.report.safeGcCandidateCount).toBe(2)
    })

    it('real execution deletes only safe candidates and respects maxVolumes', async () => {
      const backend = new FakeBackend()
      const volumes: DockerVolumeUsage[] = [
        fakeVol('dh-a17wkjn5-cache', 1000),
        fakeVol('dh-a17wkjn5-sdk', 2000),
        fakeVol('dh-a17wkjn5-src', 3000),
        fakeVol('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 5000)
      ]

      const context: VolumeReconciliationContext = {
        volumes,
        rooms: [],
        settings: { get: () => null },
        roomDirExists: () => false
      }

      const result = await executeVolumeGc(backend, context, { dryRun: false, maxVolumes: 2 })
      expect(result.dryRun).toBe(false)
      expect(result.deletedCount).toBe(2)
      expect(result.reclaimedBytes).toBe(3000)
      expect(result.deletedVolumes).toEqual(['dh-a17wkjn5-cache', 'dh-a17wkjn5-sdk'])
      expect(backend.removedManagedVolumes).toEqual(['dh-a17wkjn5-cache', 'dh-a17wkjn5-sdk'])
    })

    it('real execution respects maxBytes limit', async () => {
      const backend = new FakeBackend()
      const volumes: DockerVolumeUsage[] = [
        fakeVol('dh-a17wkjn5-cache', 1000),
        fakeVol('dh-a17wkjn5-sdk', 5000),
        fakeVol('dh-a17wkjn5-src', 1000)
      ]

      const context: VolumeReconciliationContext = {
        volumes,
        rooms: [],
        settings: { get: () => null },
        roomDirExists: () => false
      }

      const result = await executeVolumeGc(backend, context, { dryRun: false, maxBytes: 4000 })
      expect(result.dryRun).toBe(false)
      expect(result.deletedCount).toBe(1)
      expect(result.reclaimedBytes).toBe(1000)
      expect(result.deletedVolumes).toEqual(['dh-a17wkjn5-cache'])
    })
  })

  describe('RoomOrchestrator integration', () => {
    let db: Db
    let userData: string
    let backend: FakeBackend
    let orch: RoomOrchestrator

    beforeEach(() => {
      db = testDb()
      userData = tempDir()
      backend = new FakeBackend()
      orch = new RoomOrchestrator({
        userData,
        backend,
        gateway: new FakeGateway().asGateway(),
        db,
        appVersion: 'test'
      })
    })

    afterEach(() => {
      db.close()
      rmSync(userData, { recursive: true, force: true })
    })

    it('reconciles volumes via orchestrator and accurately identifies deleted room orphans', async () => {
      const room = makeRoom({ id: 'room1abc', status: 'sleeping', workspaceVolumeRevision: 1 })
      orch.rooms.create(room)

      backend.managedVolumes = [
        {
          name: 'dh-room1abc-cache',
          driver: 'local',
          scope: 'local',
          mountpoint: '/path',
          sizeBytes: 50000,
          links: 0,
          labels: {}
        },
        {
          name: 'dh-delroom1-cache',
          driver: 'local',
          scope: 'local',
          mountpoint: '/path',
          sizeBytes: 80000,
          links: 0,
          labels: {}
        },
        {
          name: 'unowned-anon-vol',
          driver: 'local',
          scope: 'local',
          mountpoint: '/path',
          sizeBytes: 120000,
          links: 0,
          labels: {}
        }
      ]

      const report = await orch.reconcileVolumes()
      expect(report.totalDockerVolumes).toBe(3)
      expect(report.safeGcCandidateCount).toBe(1)
      expect(report.safeGcCandidateBytes).toBe(80000)
      expect(report.unownedVolumeCount).toBe(1)
      expect(report.retainedVolumeCount).toBe(1)

      const dryRun = await orch.gcVolumes({ dryRun: true })
      expect(dryRun.dryRun).toBe(true)
      expect(dryRun.deletedCount).toBe(0)
      expect(backend.removedManagedVolumes).toHaveLength(0)

      const executed = await orch.gcVolumes({ dryRun: false })
      expect(executed.dryRun).toBe(false)
      expect(executed.deletedCount).toBe(1)
      expect(executed.reclaimedBytes).toBe(80000)
      expect(backend.removedManagedVolumes).toEqual(['dh-delroom1-cache'])
    })
  })
})
