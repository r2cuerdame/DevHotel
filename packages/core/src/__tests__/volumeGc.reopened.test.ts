import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DockerVolumeUsage } from '../backend/types'
import { ChangeEngine } from '../changes/engine'
import { registerQuickChanges } from '../changes/definitions/index'
import { depsGenKey, depsGenMaxKey } from '../changes/definitions/deps'
import type { ChangeCtx } from '../changes/types'
import { RoomOrchestrator } from '../orchestrator'
import { changesRepo } from '../store/changesRepo'
import type { Db } from '../store/db'
import { roomsRepo } from '../store/roomsRepo'
import { settingsRepo } from '../store/settingsRepo'
import {
  executeVolumeGc,
  isRoomFencedForRecovery,
  reconcileVolumesState,
  type VolumeReconciliationContext
} from '../volumeGc'
import { FakeBackend, FakeGateway, makeRoom, tempDir, testDb } from './fakes'

/**
 * The reopened #63 contract: one inventory pass per run, a wall-clock deadline,
 * attempts (not successes) consume the count bound, fences keyed off durable
 * intent, positive stale classification for non-current-major deps and
 * removed-service data, a declared retention rule for superseded
 * package-install history, and generation reservation before any mutation.
 */

const managedLabels = (roomId: string) => ({
  'devhotel.managed': '1',
  'devhotel.room': roomId,
  'devhotel.role': 'volume'
})

function vol(name: string, sizeBytes: number, overrides: Partial<DockerVolumeUsage> = {}): DockerVolumeUsage {
  const roomId = /^dh-([a-z0-9]{8})-/.exec(name)?.[1]
  return {
    name,
    driver: 'local',
    scope: 'local',
    mountpoint: `/var/lib/docker/volumes/${name}/_data`,
    sizeBytes,
    sizeKnown: true,
    ownership: roomId ? 'managed-labels' : 'unowned',
    links: 0,
    linksKnown: true,
    labels: roomId ? managedLabels(roomId) : {},
    ...overrides
  }
}

const settingsOf = (entries: Array<[string, string]> = []) => {
  const map = new Map(entries)
  return { get: (key: string) => map.get(key) ?? null }
}

describe('fencing keys off durable intent (#63 reopened, item 3)', () => {
  it('does not fence a Room on the generic attention status alone', () => {
    expect(isRoomFencedForRecovery('room1abc', settingsOf(), undefined, 'attention')).toBe(false)
  })

  it('fences on every durable recovery intent record, including the locale recovery diagnostic', () => {
    for (const key of [
      'androidLocaleRestorePending:room1abc',
      'androidAcceptanceRestorePending:room1abc',
      'artifactExportPending:room1abc',
      'androidLocaleRecoveryDiagnostic:room1abc'
    ]) {
      expect(isRoomFencedForRecovery('room1abc', settingsOf([[key, '{}']])), key).toBe(true)
    }
  })

  it('keeps every #61 volume fenced through the durable restore intent, not the status', () => {
    const rooms = [
      makeRoom({ id: 'njfstb4z', status: 'sleeping', workspaceVolumeRevision: 10 }),
      makeRoom({ id: '29c5e8ys', status: 'attention', workspaceVolumeRevision: 3 })
    ]
    const report = reconcileVolumesState({
      volumes: [
        vol('dh-njfstb4z-src-r10', 1), vol('dh-njfstb4z-src-r1', 1), vol('dh-njfstb4z-sdk', 1),
        vol('dh-29c5e8ys-src-r3', 1), vol('dh-29c5e8ys-src-r1', 1), vol('dh-29c5e8ys-cache', 1)
      ],
      rooms,
      settings: settingsOf([
        ['androidLocaleRestorePending:njfstb4z', '{"version":4}'],
        ['androidLocaleRestorePending:29c5e8ys', '{"version":4}']
      ]),
      activeOperations: [],
      changes: { list: () => [] }
    })
    expect(report.fencedVolumeCount).toBe(6)
    expect(report.safeGcCandidateCount).toBe(0)
  })

  it('classifies an attention Room like any other awake Room: live state retained, stale generations positively stale', () => {
    const room = makeRoom({ id: 'att1room', status: 'attention', workspaceVolumeRevision: 3 })
    const report = reconcileVolumesState({
      volumes: [vol('dh-att1room-src-r3', 30), vol('dh-att1room-src-r1', 10), vol('dh-att1room-cache', 5)],
      rooms: [room],
      settings: settingsOf(),
      activeOperations: [],
      changes: { list: () => [] }
    })
    const byName = new Map(report.volumes.map((v) => [v.name, v]))
    expect(byName.get('dh-att1room-src-r3')).toMatchObject({ class: 'retained-current', safeToDelete: false })
    expect(byName.get('dh-att1room-cache')).toMatchObject({ class: 'retained-active', safeToDelete: false })
    expect(byName.get('dh-att1room-src-r1')).toMatchObject({ class: 'orphaned-stale-generation', safeToDelete: true })
  })
})

describe('non-current-major dependencies and removed-service data (#63 reopened, item 4)', () => {
  const room = makeRoom({ id: 'dep1room', status: 'sleeping', runtime: { kind: 'node', version: '22' }, services: {} })

  it('classifies gen-0 dependencies of a Node major the Room no longer runs as stale', () => {
    const report = reconcileVolumesState({
      volumes: [vol('dh-dep1room-deps-node20', 700), vol('dh-dep1room-deps-node22', 800)],
      rooms: [room],
      settings: settingsOf(),
      activeOperations: [],
      changes: { list: () => [] }
    })
    const byName = new Map(report.volumes.map((v) => [v.name, v]))
    expect(byName.get('dh-dep1room-deps-node22')).toMatchObject({ class: 'retained-sleeping', safeToDelete: false })
    expect(byName.get('dh-dep1room-deps-node20')).toMatchObject({ class: 'orphaned-stale-deps', safeToDelete: true })
    expect(byName.get('dh-dep1room-deps-node20')!.reason).toMatch(/Node 20.*no longer/)
  })

  it('retains the old major dependencies while an undoable Node switch still references that major', () => {
    const report = reconcileVolumesState({
      volumes: [vol('dh-dep1room-deps-node20', 700)],
      rooms: [room],
      settings: settingsOf(),
      activeOperations: [],
      changes: { list: () => [{ undoable: true, status: 'verified', captured: { prevVersion: '20' } }] }
    })
    expect(report.volumes[0]).toMatchObject({ class: 'retained-recovery', safeToDelete: false })
    expect(report.volumes[0]!.reason).toContain('undo')
  })

  it('never lets non-current-major deps past the exact ownership, known size and zero-attachment gates', () => {
    const base = { rooms: [room], settings: settingsOf(), activeOperations: [], changes: { list: () => [] } }
    const attached = reconcileVolumesState({ ...base, volumes: [vol('dh-dep1room-deps-node20', 1, { links: 1 })] })
    const unlabeled = reconcileVolumesState({
      ...base,
      volumes: [vol('dh-dep1room-deps-node20', 1, { labels: {}, ownership: 'unowned' })]
    })
    const sizeless = reconcileVolumesState({ ...base, volumes: [vol('dh-dep1room-deps-node20', 0, { sizeKnown: false })] })
    for (const report of [attached, unlabeled, sizeless]) {
      expect(report.volumes[0]!.safeToDelete).toBe(false)
    }
  })

  it('classifies data for a service the Room no longer declares as an orphaned removed service', () => {
    const report = reconcileVolumesState({
      volumes: [vol('dh-dep1room-svc-postgres-data', 900), vol('dh-dep1room-svc-redis-data', 50)],
      rooms: [makeRoom({ ...room, services: { redis: { version: '8' } } })],
      settings: settingsOf(),
      activeOperations: [],
      changes: { list: () => [] }
    })
    const byName = new Map(report.volumes.map((v) => [v.name, v]))
    expect(byName.get('dh-dep1room-svc-redis-data')).toMatchObject({ class: 'retained-sleeping', safeToDelete: false })
    expect(byName.get('dh-dep1room-svc-postgres-data')).toMatchObject({ class: 'orphaned-removed-service', safeToDelete: true })
    expect(report.byClass['orphaned-removed-service']).toEqual({ count: 1, totalBytes: 900, reclaimableBytes: 900 })
  })

  it('keeps removed-service data while any undoable change still names that service or attachment state is unproved', () => {
    const base = { rooms: [room], settings: settingsOf(), activeOperations: [] }
    const referenced = reconcileVolumesState({
      ...base,
      volumes: [vol('dh-dep1room-svc-postgres-data', 900)],
      changes: { list: () => [{ undoable: true, status: 'applied', captured: { service: 'postgres', backupFile: null } }] }
    })
    expect(referenced.volumes[0]).toMatchObject({ class: 'retained-recovery', safeToDelete: false })

    const attached = reconcileVolumesState({
      ...base,
      volumes: [vol('dh-dep1room-svc-postgres-data', 900, { links: 1 })],
      changes: { list: () => [] }
    })
    expect(attached.volumes[0]!.safeToDelete).toBe(false)

    const historyUnknown = reconcileVolumesState({ ...base, volumes: [vol('dh-dep1room-svc-postgres-data', 900)] })
    expect(historyUnknown.volumes[0]).toMatchObject({ class: 'retained-recovery', safeToDelete: false })
  })
})

describe('superseded package-install retention rule (#63 reopened, item 5)', () => {
  const packageInstall = (previous: number, next: number, status = 'verified') => ({
    kind: 'package-install',
    undoable: true,
    status,
    captured: {
      nodeMajor: '22',
      previousWorkspaceGeneration: previous,
      nextWorkspaceGeneration: next,
      previousDepsGeneration: previous,
      nextDepsGeneration: next,
      beforeStateRevision: previous,
      appliedStateRevision: next,
      published: true
    }
  })

  it('retains only the generations the live (still undoable) package install references', () => {
    const room = makeRoom({ id: 'pkg1room', status: 'sleeping', workspaceVolumeRevision: 5 })
    const report = reconcileVolumesState({
      volumes: [
        vol('dh-pkg1room-src-r5', 5), vol('dh-pkg1room-src-r4', 4), vol('dh-pkg1room-src-r3', 3),
        vol('dh-pkg1room-deps-node22-g5', 5), vol('dh-pkg1room-deps-node22-g4', 4), vol('dh-pkg1room-deps-node22-g3', 3)
      ],
      rooms: [room],
      settings: settingsOf([[depsGenKey('pkg1room', '22'), '5']]),
      activeOperations: [],
      changes: { list: () => [packageInstall(4, 5), packageInstall(3, 4)] }
    })
    const byName = new Map(report.volumes.map((v) => [v.name, v]))
    expect(byName.get('dh-pkg1room-src-r4')).toMatchObject({ class: 'retained-recovery', safeToDelete: false })
    expect(byName.get('dh-pkg1room-deps-node22-g4')).toMatchObject({ class: 'retained-recovery', safeToDelete: false })
    expect(byName.get('dh-pkg1room-src-r3')).toMatchObject({ class: 'orphaned-stale-generation', safeToDelete: true })
    expect(byName.get('dh-pkg1room-src-r3')!.reason).toContain('superseded')
    expect(byName.get('dh-pkg1room-deps-node22-g3')).toMatchObject({ class: 'orphaned-stale-deps', safeToDelete: true })
  })

  it('keeps a package install live while its staged generation is the published one even after a plain deps reinstall', () => {
    // The workspace pointer still names the staged generation, so undo is
    // still possible on that side; the previous generations must survive.
    const room = makeRoom({ id: 'pkg1room', status: 'sleeping', workspaceVolumeRevision: 4 })
    const report = reconcileVolumesState({
      volumes: [vol('dh-pkg1room-src-r3', 3), vol('dh-pkg1room-deps-node22-g3', 3)],
      rooms: [room],
      settings: settingsOf([[depsGenKey('pkg1room', '22'), '6']]),
      activeOperations: [],
      changes: { list: () => [packageInstall(3, 4)] }
    })
    for (const record of report.volumes) {
      expect(record).toMatchObject({ class: 'retained-recovery', safeToDelete: false })
    }
  })
})

describe('bounded execution (#63 reopened, items 1 and 2)', () => {
  const context = (names: string[]): VolumeReconciliationContext => ({
    volumes: names.map((name, index) => vol(name, 100 * (index + 1))),
    rooms: [],
    settings: settingsOf(),
    activeOperations: [],
    changes: { list: () => [] },
    roomDirExists: () => false
  })
  const bounds = { dryRun: false as const, maxVolumes: 2, maxBytes: 10_000, deadlineMs: 60_000 }

  it('counts failed removal attempts against maxVolumes', async () => {
    const attempted: string[] = []
    const result = await executeVolumeGc(
      new FakeBackend(),
      context(['dh-gone1abc-cache', 'dh-gone1abc-sdk', 'dh-gone1abc-src']),
      bounds,
      {
        removeCandidateIfStillSafe: async (candidate) => {
          attempted.push(candidate.name)
          if (attempted.length === 1) throw new Error('engine refused')
          return candidate.sizeBytes
        }
      }
    )
    expect(attempted).toEqual(['dh-gone1abc-cache', 'dh-gone1abc-sdk'])
    expect(result.attemptedCount).toBe(2)
    expect(result.deletedCount).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.skipped).toEqual([{ name: 'dh-gone1abc-src', reason: expect.stringContaining('maxVolumes') }])
  })

  it('keeps maxBytes fail-closed: a candidate that would overshoot is skipped, not squeezed in', async () => {
    const attempted: string[] = []
    const result = await executeVolumeGc(
      new FakeBackend(),
      context(['dh-gone1abc-cache', 'dh-gone1abc-sdk', 'dh-gone1abc-src']),
      { ...bounds, maxVolumes: 10, maxBytes: 250 },
      { removeCandidateIfStillSafe: async (candidate) => { attempted.push(candidate.name); return candidate.sizeBytes } }
    )
    expect(attempted).toEqual(['dh-gone1abc-cache'])
    expect(result.reclaimedBytes).toBe(100)
    expect(result.skipped.map((s) => s.name)).toEqual(['dh-gone1abc-sdk', 'dh-gone1abc-src'])
    expect(result.skipped[0]!.reason).toContain('maxBytes')
  })

  it('stops attempting once the wall-clock deadline has passed and says so', async () => {
    let now = 1_000
    const attempted: string[] = []
    const result = await executeVolumeGc(
      new FakeBackend(),
      context(['dh-gone1abc-cache', 'dh-gone1abc-sdk', 'dh-gone1abc-src']),
      { ...bounds, maxVolumes: 10, deadlineMs: 500, now: () => now },
      {
        removeCandidateIfStillSafe: async (candidate) => {
          attempted.push(candidate.name)
          now += 400
          return candidate.sizeBytes
        }
      }
    )
    expect(attempted).toEqual(['dh-gone1abc-cache', 'dh-gone1abc-sdk'])
    expect(result.deadlineReached).toBe(true)
    expect(result.skipped).toEqual([{ name: 'dh-gone1abc-src', reason: expect.stringContaining('deadline') }])
  })

  it('refuses a real run without an explicit finite deadline', async () => {
    await expect(executeVolumeGc(
      new FakeBackend(),
      context(['dh-gone1abc-cache']),
      { dryRun: false, maxVolumes: 1, maxBytes: 1000 },
      { removeCandidateIfStillSafe: async () => 0 }
    )).rejects.toThrow(/deadline/)
  })

  it('reports every dry-run candidate with its reason and nothing attempted', async () => {
    const result = await executeVolumeGc(new FakeBackend(), context(['dh-gone1abc-cache']), { dryRun: true })
    expect(result).toMatchObject({ dryRun: true, attemptedCount: 0, deadlineReached: false, skipped: [] })
    expect(result.report.volumes[0]!.reason).toContain('provably orphaned')
  })
})

describe('one inventory pass per run (#63 reopened, item 1)', () => {
  let db: Db
  let userData: string
  let backend: FakeBackend
  let orch: RoomOrchestrator

  beforeEach(() => {
    db = testDb()
    userData = tempDir()
    backend = new FakeBackend()
    orch = new RoomOrchestrator({ userData, backend, gateway: new FakeGateway().asGateway(), db, appVersion: 'test' })
  })

  afterEach(() => {
    db.close()
    rmSync(userData, { recursive: true, force: true })
  })

  it('lists the inventory once and re-proves each candidate through a single-volume inspection', async () => {
    backend.managedVolumes = [vol('dh-gone1abc-cache', 100), vol('dh-gone1abc-sdk', 200)]
    const result = await orch.gcVolumes({ dryRun: false, maxVolumes: 5, maxBytes: 1000, deadlineMs: 60_000 })
    expect(result.deletedVolumes).toEqual(['dh-gone1abc-cache', 'dh-gone1abc-sdk'])
    expect(backend.calls.filter((call) => call === 'listVolumesWithUsage')).toHaveLength(1)
    expect(backend.calls.filter((call) => call.startsWith('inspectVolumeUsage:'))).toEqual([
      'inspectVolumeUsage:dh-gone1abc-cache',
      'inspectVolumeUsage:dh-gone1abc-sdk'
    ])
  })

  it('fails closed when the single-volume re-proof shows a new attachment or a recreated Room', async () => {
    backend.managedVolumes = [vol('dh-gone1abc-cache', 100), vol('dh-gone1abc-sdk', 200)]
    const original = backend.inspectVolumeUsage.bind(backend)
    backend.inspectVolumeUsage = async (name) => {
      const current = await original(name)
      if (name === 'dh-gone1abc-cache') return current && { ...current, links: 1 }
      orch.rooms.create(makeRoom({ id: 'gone1abc', status: 'sleeping' }))
      return current
    }
    const result = await orch.gcVolumes({ dryRun: false, maxVolumes: 5, maxBytes: 1000, deadlineMs: 60_000 })
    expect(result.deletedCount).toBe(0)
    expect(result.errors).toHaveLength(2)
    expect(backend.removedManagedVolumes).toEqual([])
  })

  it('fails closed when the candidate disappeared before the re-proof', async () => {
    backend.managedVolumes = [vol('dh-gone1abc-cache', 100)]
    backend.inspectVolumeUsage = async () => null
    const result = await orch.gcVolumes({ dryRun: false, maxVolumes: 5, maxBytes: 1000, deadlineMs: 60_000 })
    expect(result.deletedCount).toBe(0)
    expect(result.errors).toEqual([expect.stringContaining('disappeared')])
  })
})

describe('dependency generation reservation (#63 reopened, item 6)', () => {
  let engine: ChangeEngine
  let backend: FakeBackend
  let db: Db
  let userData: string
  let repos: { rooms: ReturnType<typeof roomsRepo>; changes: ReturnType<typeof changesRepo>; settings: ReturnType<typeof settingsRepo> }

  function ctx(roomId = 'room1abc'): ChangeCtx {
    const gateway = new FakeGateway()
    return {
      roomId,
      backend,
      gateway: gateway.asGateway(),
      rooms: repos.rooms,
      changes: repos.changes,
      settings: repos.settings,
      userData,
      log: () => undefined,
      room: () => repos.rooms.get(roomId)!,
      webSpec: (overrides) => {
        const r = repos.rooms.get(roomId)!
        return {
          roomId,
          internalPort: r.internalPort,
          nodeMajor: r.runtime.version,
          sourceType: r.sourceType,
          sourceRef: r.sourceRef,
          workspaceMode: r.workspaceMode,
          workspaceVolumeRevision: r.workspaceVolumeRevision,
          startCommand: r.startCommand,
          env: {},
          ...overrides
        }
      },
      isAwake: () => false,
      syncRoute: async () => undefined,
      installTrackedAndroidArtifact: async () => { throw new Error('not configured') },
      removeTrackedAndroidInstall: () => undefined,
      removeTrackedAndroidInstalls: () => undefined
    }
  }

  beforeEach(() => {
    db = testDb()
    userData = tempDir()
    engine = new ChangeEngine()
    registerQuickChanges(engine)
    backend = new FakeBackend()
    repos = { rooms: roomsRepo(db), changes: changesRepo(db), settings: settingsRepo(db) }
    repos.rooms.create(makeRoom({ status: 'sleeping', sourceType: 'managed-git', workspaceMode: 'hotel' }))
  })

  afterEach(() => {
    db.close()
    rmSync(userData, { recursive: true, force: true })
  })

  it('reserves the next generation durably before a clean reinstall touches any volume', async () => {
    const original = backend.resetVolume.bind(backend)
    let crashed = false
    let maxAtCrash: string | null = null
    backend.resetVolume = async (roomId, name) => {
      if (!crashed) {
        crashed = true
        maxAtCrash = repos.settings.get(depsGenMaxKey('room1abc', '22'))
        throw new Error('injected crash before the volume existed')
      }
      await original(roomId, name)
    }
    const failed = await engine.execute(ctx(), 'deps-install', { clean: true }, 'user')
    expect(failed.status).not.toBe('verified')
    expect(maxAtCrash).toBe('1')
    expect(repos.settings.get(depsGenMaxKey('room1abc', '22'))).toBe('1')
    expect(Number(repos.settings.get(depsGenKey('room1abc', '22')) ?? '0')).toBe(0)

    await engine.execute(ctx(), 'deps-install', { clean: true }, 'user')
    expect(backend.calls).toContain('resetVolume:dh-room1abc-deps-node22-g2')
    expect(backend.calls).not.toContain('resetVolume:dh-room1abc-deps-node22-g1')
    expect(repos.settings.get(depsGenKey('room1abc', '22'))).toBe('2')
  })

  it('reserves the next generation durably before a Room reset reinstall touches any volume', async () => {
    const original = backend.resetVolume.bind(backend)
    let crashed = false
    backend.resetVolume = async (roomId, name) => {
      if (!crashed) {
        crashed = true
        throw new Error('injected crash before the volume existed')
      }
      await original(roomId, name)
    }
    const reset = { reinstallDependencies: true, clearCaches: false, services: 'keep' as const, clearBrowserData: false }
    const failed = await engine.execute(ctx(), 'room-reset', reset, 'user')
    expect(failed.status).not.toBe('verified')
    expect(repos.settings.get(depsGenMaxKey('room1abc', '22'))).toBe('1')

    await engine.execute(ctx(), 'room-reset', reset, 'user')
    expect(backend.calls).toContain('resetVolume:dh-room1abc-deps-node22-g2')
    expect(repos.settings.get(depsGenKey('room1abc', '22'))).toBe('2')
  })
})
